#!/usr/bin/env python3
"""
hwp_table_check.py  -  HWP 5.0 표 구조 자가 검증기

사용법:
    pip install olefile
    python3 hwp_table_check.py <파일.hwp>

하는 일:
  - BodyText/Section* 스트림을 풀어 레코드 트리를 파싱
  - 표(CTRL_HEADER 'tbl ' + TABLE + 셀들)를 찾아 다음을 검사:
      [구조]   레코드가 끝까지 정상 파싱되는가 (잘린 레코드 = 표 사라짐의 주원인)
      [헤더]   표 CTRL_HEADER 개체공통속성이 정상 길이/필드인가
      [개수]   TABLE의 rows/cols, cells-per-row 합 == 실제 셀 개수
      [기하]   각 셀 col/row/colSpan/rowSpan으로 그리드를 채워 빈칸·겹침·범위초과 검사
      [문단]   병합 셀에 텍스트가 rowSpan/colSpan 배수로 중복됐는지 (nParas vs 실제 PARA 수)
  - 문제가 있으면 사람이 읽을 수 있는 한국어 진단을 출력하고 종료코드 1
  - 모두 통과하면 OK 출력 후 종료코드 0

종료코드 0 = 정상, 1 = 문제 발견, 2 = 파일/형식 오류
"""

import sys
import struct

try:
    import olefile
except ImportError:
    print("ERROR: olefile 모듈이 필요합니다.  pip install olefile", file=sys.stderr)
    sys.exit(2)

try:
    import zlib
except ImportError:
    print("ERROR: zlib 사용 불가", file=sys.stderr)
    sys.exit(2)


# ---- HWP 레코드 태그 ----
HWPTAG_PARA_HEADER  = 0x42
HWPTAG_PARA_TEXT    = 0x43
HWPTAG_CTRL_HEADER  = 0x47
HWPTAG_LIST_HEADER  = 0x48
HWPTAG_TABLE        = 0x4D

# PARA_TEXT 안에서 16바이트(8 wchar)를 차지하는 inline control 문자 코드
INLINE_CTRL_8WCHAR = {1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23}


def read_header_flags(ole):
    hdr = ole.openstream("FileHeader").read()
    flags = int.from_bytes(hdr[36:40], "little")
    return {"compressed": bool(flags & 1), "encrypted": bool(flags & 2)}


def get_section_data(ole, path):
    raw = ole.openstream(path).read()
    flags = read_header_flags(ole)
    if flags["compressed"]:
        return zlib.decompress(raw, -15)
    return raw


def parse_records(data):
    """레코드 파싱. (tag, level, size, payload, start_offset) 리스트.
    파싱이 도중에 깨지면 truncated=True 도 같이 반환."""
    recs = []
    pos = 0
    truncated = False
    while pos < len(data):
        if pos + 4 > len(data):
            truncated = True
            break
        header = struct.unpack_from("<I", data, pos)[0]
        tag = header & 0x3FF
        level = (header >> 10) & 0x3FF
        size = (header >> 20) & 0xFFF
        rec_start = pos
        pos += 4
        if size == 0xFFF:
            if pos + 4 > len(data):
                truncated = True
                break
            size = struct.unpack_from("<I", data, pos)[0]
            pos += 4
        if pos + size > len(data):
            # 레코드가 선언한 size만큼 데이터가 없음 = 잘림 (표 사라짐의 흔한 원인)
            truncated = True
            recs.append((tag, level, size, data[pos:], rec_start))
            break
        recs.append((tag, level, size, data[pos:pos + size], rec_start))
        pos += size
    return recs, truncated


def decode_para_text(payload):
    out = []
    i = 0
    while i + 1 < len(payload):
        code = struct.unpack_from("<H", payload, i)[0]
        if code in (0, 10, 13):
            if code in (10, 13):
                out.append("\n")
            i += 2
        elif code < 32:
            i += 16 if code in INLINE_CTRL_8WCHAR else 2
        else:
            out.append(chr(code))
            i += 2
    return "".join(out)


def decode_ctrl_header(p):
    """표 CTRL_HEADER(개체 공통 속성) 디코드. 길이가 짧으면 그대로 반환."""
    info = {"len": len(p)}
    if len(p) < 4:
        return info
    info["ctrl_id"] = p[0:4][::-1].decode("latin1", errors="replace")
    if len(p) >= 8:
        info["attribute"] = struct.unpack_from("<I", p, 4)[0]
    if len(p) >= 12:
        info["yoffset"] = struct.unpack_from("<i", p, 8)[0]
    if len(p) >= 16:
        info["xoffset"] = struct.unpack_from("<i", p, 12)[0]
    if len(p) >= 20:
        info["width"] = struct.unpack_from("<i", p, 16)[0]
    if len(p) >= 24:
        info["height"] = struct.unpack_from("<i", p, 20)[0]
    return info


def decode_table_record(p):
    attr = struct.unpack_from("<I", p, 0)[0]
    nrows = struct.unpack_from("<H", p, 4)[0]
    ncols = struct.unpack_from("<H", p, 6)[0]
    cells_per_row = None
    # +8 cellspacing(2) +10 margins(8) +18 cells-per-row(nrows*2)
    try:
        cells_per_row = struct.unpack_from("<%dH" % nrows, p, 18)
    except struct.error:
        cells_per_row = None
    return attr, nrows, ncols, cells_per_row


def decode_cell_list_header(p):
    """셀 LIST_HEADER: nParas, col, row, colspan, rowspan."""
    nparas = struct.unpack_from("<h", p, 0)[0]
    col = struct.unpack_from("<H", p, 8)[0]
    row = struct.unpack_from("<H", p, 10)[0]
    cspan = struct.unpack_from("<H", p, 12)[0]
    rspan = struct.unpack_from("<H", p, 14)[0]
    return nparas, col, row, cspan, rspan


def collect_tables(recs):
    """레코드 리스트에서 표 단위로 묶음.
    각 표: {ctrl, ctrl_len, table_payload, level, cells:[{coords, nparas, npara_actual, text}]}"""
    tables = []
    i = 0
    n = len(recs)
    while i < n:
        tag, level, size, payload, off = recs[i]
        if tag == HWPTAG_TABLE:
            tbl = {"rec_index": i, "level": level, "table_payload": payload}
            # 바로 앞 CTRL_HEADER
            if i > 0 and recs[i - 1][0] == HWPTAG_CTRL_HEADER:
                tbl["ctrl_payload"] = recs[i - 1][3]
            else:
                tbl["ctrl_payload"] = None
            # 이후 셀들(LIST_HEADER level==table level)
            cells = []
            j = i + 1
            cur = None
            while j < n:
                t2, l2, s2, p2, o2 = recs[j]
                if t2 == HWPTAG_LIST_HEADER and l2 == level:
                    if cur is not None:
                        cells.append(cur)
                    nparas, col, row, cs, rs = decode_cell_list_header(p2)
                    cur = {"nparas": nparas, "col": col, "row": row,
                           "cspan": cs, "rspan": rs,
                           "para_count": 0, "texts": []}
                elif t2 == HWPTAG_PARA_HEADER and l2 == level + 1 and cur is not None:
                    cur["para_count"] += 1
                elif t2 == HWPTAG_PARA_TEXT and l2 == level + 1 and cur is not None:
                    cur["texts"].append(decode_para_text(p2).strip())
                elif t2 == HWPTAG_TABLE or (t2 == HWPTAG_CTRL_HEADER and l2 <= level):
                    break
                j += 1
            if cur is not None:
                cells.append(cur)
            tbl["cells"] = cells
            tables.append(tbl)
            i = j
        else:
            i += 1
    return tables


def check_table(tbl, idx, problems):
    p = tbl["table_payload"]
    attr, nrows, ncols, cpr = decode_table_record(p)
    cells = tbl["cells"]
    tag = "표#%d" % (idx + 1)

    # [헤더] CTRL_HEADER 길이/필드
    ch = tbl["ctrl_payload"]
    if ch is None:
        problems.append("%s: 표 앞에 CTRL_HEADER('tbl ') 레코드가 없음." % tag)
    else:
        chi = decode_ctrl_header(ch)
        if chi.get("ctrl_id") != "tbl ":
            problems.append("%s: CTRL_HEADER ctrlID가 'tbl '가 아님 (%r)." % (tag, chi.get("ctrl_id")))
        if chi["len"] < 48:
            problems.append(
                "%s: CTRL_HEADER가 %d바이트로 짧음 (정상 48바이트). 개체 공통 속성 끝 필드가 누락됨 → 표가 안 보이거나 위치가 깨짐."
                % (tag, chi["len"]))
        if "attribute" in chi and (chi["attribute"] & 1) == 0:
            problems.append(
                "%s: CTRL_HEADER attribute의 '글자처럼취급'(bit0)이 0. 보통 1이어야 앵커링이 안정적임 (현재 0x%08X)."
                % (tag, chi["attribute"]))
        if chi.get("yoffset", 0) < 0 or chi.get("xoffset", 0) < 0:
            problems.append("%s: CTRL_HEADER offset이 음수 (y=%s x=%s). 0으로 둘 것."
                            % (tag, chi.get("yoffset"), chi.get("xoffset")))

    # [개수] cells-per-row 합 == 실제 셀 수
    if cpr is None:
        problems.append("%s: TABLE 레코드에서 cells-per-row 배열을 읽지 못함 (레코드 길이 부족)." % tag)
    else:
        if sum(cpr) != len(cells):
            problems.append(
                "%s: cells-per-row 합(%d)과 실제 셀 레코드 수(%d)가 불일치. 셀이 누락/과잉."
                % (tag, sum(cpr), len(cells)))
        if len(cpr) != nrows:
            problems.append("%s: cells-per-row 길이(%d) != rows(%d)." % (tag, len(cpr), nrows))

    # [기하] 그리드 채우기
    grid = [[None] * ncols for _ in range(nrows)]
    for ci, c in enumerate(cells):
        for r in range(c["row"], c["row"] + max(1, c["rspan"])):
            for cc in range(c["col"], c["col"] + max(1, c["cspan"])):
                if r >= nrows or cc >= ncols:
                    problems.append(
                        "%s: 셀#%d (텍스트=%r)이 그리드 범위를 벗어남 (%d,%d) / 표 %dx%d."
                        % (tag, ci, (c["texts"][0] if c["texts"] else ""), r, cc, nrows, ncols))
                    continue
                if grid[r][cc] is not None:
                    problems.append(
                        "%s: (%d행,%d열)에서 셀#%d 와 셀#%d 가 겹침 (colspan/rowspan 오류)."
                        % (tag, r, cc, grid[r][cc], ci))
                else:
                    grid[r][cc] = ci
    empties = [(r, c) for r in range(nrows) for c in range(ncols) if grid[r][c] is None]
    if empties:
        problems.append("%s: 채워지지 않은 빈칸 %d개: %s%s"
                        % (tag, len(empties), empties[:10],
                           " ..." if len(empties) > 10 else ""))

    # [문단] 병합 셀 텍스트 중복
    # 주의: nParas==span 자체는 정상일 수 있음 (한컴 원본도 "정부지원"+"(A)"처럼
    #       서로 다른 두 줄을 한 셀에 두 문단으로 넣음). 진짜 버그는 "똑같은 텍스트"가
    #       병합 배수만큼 반복되는 경우다. 그래서 텍스트 동일성으로 판정한다.
    for ci, c in enumerate(cells):
        span = max(1, c["rspan"]) * max(1, c["cspan"])
        texts = [t for t in c["texts"] if t != ""]
        if span > 1 and len(texts) >= 2:
            uniq = set(texts)
            if len(uniq) == 1:
                # 모든 문단의 텍스트가 동일 = 병합 셀 텍스트를 배수로 복제한 전형적 버그
                problems.append(
                    "%s: 셀#%d 의 문단 %d개가 모두 같은 텍스트(%r)로 중복됨. 병합크기는 %d. "
                    "병합 셀(대표 셀)에는 같은 텍스트를 한 번만 넣을 것 (문단을 rowSpan/colSpan 배수로 복제하지 말 것)."
                    % (tag, ci, len(texts), texts[0], span))
            elif c["nparas"] == span and len(texts) == span:
                # 텍스트가 다 같진 않지만 개수가 정확히 병합크기와 일치 → 의심스러우니 알려만 줌
                problems.append(
                    "%s: 셀#%d 의 문단 수(%d)가 병합크기(%d)와 정확히 일치. 의도된 다중 줄이면 무시해도 되나, "
                    "병합 때문에 줄이 복제된 게 아닌지 확인할 것 (문단 내용: %s)."
                    % (tag, ci, len(texts), span, " / ".join(texts[:span])))


def main():
    if len(sys.argv) < 2:
        print("사용법: python3 hwp_table_check.py <파일.hwp>", file=sys.stderr)
        sys.exit(2)

    path = sys.argv[1]
    try:
        ole = olefile.OleFileIO(path)
    except Exception as e:
        print("ERROR: HWP(OLE) 파일을 열 수 없음: %s" % e, file=sys.stderr)
        sys.exit(2)

    flags = read_header_flags(ole)
    if flags["encrypted"]:
        print("ERROR: 암호화된 문서는 검사할 수 없음.", file=sys.stderr)
        sys.exit(2)

    sections = sorted([("/".join(e)) for e in ole.listdir()
                       if len(e) == 2 and e[0] == "BodyText" and e[1].startswith("Section")])
    if not sections:
        print("ERROR: BodyText/Section 스트림이 없음. 올바른 HWP 5.0 파일이 아님.", file=sys.stderr)
        sys.exit(2)

    problems = []
    total_tables = 0

    for sec in sections:
        data = get_section_data(ole, sec)
        recs, truncated = parse_records(data)
        if truncated:
            problems.append(
                "[%s] 레코드 스트림이 끝까지 파싱되지 않고 중간에 잘림 — 어떤 레코드의 size 헤더가 실제 데이터보다 큼. 이게 '표가 통째로 사라지는' 가장 흔한 원인. (레코드 size 헤더와 실제 payload 길이를 정확히 맞출 것)"
                % sec)
        tables = collect_tables(recs)
        total_tables += len(tables)
        for idx, tbl in enumerate(tables):
            check_table(tbl, idx, problems)

    ole.close()

    print("검사 파일: %s" % path)
    print("섹션 수: %d, 발견된 표: %d개" % (len(sections), total_tables))
    if total_tables == 0:
        print("경고: 표를 하나도 찾지 못함. (삽입 실패했거나 레코드가 잘려 표 레코드까지 도달 못했을 수 있음)")
    print("-" * 60)

    if problems:
        print("문제 %d건 발견:" % len(problems))
        for i, msg in enumerate(problems, 1):
            print("  %d) %s" % (i, msg))
        sys.exit(1)
    else:
        print("OK: 표 구조에서 발견된 문제 없음.")
        sys.exit(0)


if __name__ == "__main__":
    main()
