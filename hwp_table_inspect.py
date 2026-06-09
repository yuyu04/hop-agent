#!/usr/bin/env python3
"""HWP 표를 셀 단위로 정밀 검사한다 — 폭(mm)·정렬·텍스트까지.

hwp_table_check.py(구조 검증)를 보완: 열 폭 가중치와 셀 정렬이 실제로 들어갔는지
사람이 눈으로 못 보는 부분을 수치로 확인한다.

사용법: python3 hwp_table_inspect.py <파일.hwp> [표번호(1부터)]
"""
import sys
import struct
import hwp_table_check as C
import olefile

HWPTAG_PARA_SHAPE = 0x10 + 9  # 25
HWPUNIT_PER_MM = 7200.0 / 25.4
ALIGN = {0: "양쪽", 1: "왼쪽", 2: "오른쪽", 3: "가운데", 4: "배분", 5: "나눔", 6: "나눔2"}


def para_shape_alignments(ole):
    """DocInfo의 PARA_SHAPE를 id 순서대로 읽어 alignment 코드 배열을 만든다."""
    try:
        data = C.get_section_data(ole, "DocInfo")
    except Exception:
        return []
    recs, _ = C.parse_records(data)
    aligns = []
    for tag, level, size, payload, off in recs:
        if tag == HWPTAG_PARA_SHAPE and len(payload) >= 4:
            attr1 = struct.unpack_from("<I", payload, 0)[0]
            aligns.append((attr1 >> 2) & 0x07)
    return aligns


def inspect(path, only=None):
    ole = olefile.OleFileIO(path)
    aligns = para_shape_alignments(ole)
    print("PARA_SHAPE 개수: %d" % len(aligns))
    sections = sorted("/".join(e) for e in ole.listdir()
                      if len(e) == 2 and e[0] == "BodyText" and e[1].startswith("Section"))
    tnum = 0
    for sec in sections:
        data = C.get_section_data(ole, sec)
        recs, _ = C.parse_records(data)
        n = len(recs)
        i = 0
        while i < n:
            tag, level, size, payload, off = recs[i]
            if tag != C.HWPTAG_TABLE:
                i += 1
                continue
            tnum += 1
            attr, nrows, ncols, cpr = C.decode_table_record(payload)
            # 셀별: LIST_HEADER + 첫 PARA_HEADER(para_shape_id)
            cells = []
            j = i + 1
            cur = None
            while j < n:
                t2, l2, s2, p2, o2 = recs[j]
                if t2 == C.HWPTAG_LIST_HEADER and l2 == level:
                    if cur:
                        cells.append(cur)
                    npar, col, row, cs, rs = C.decode_cell_list_header(p2)
                    w = struct.unpack_from("<I", p2, 16)[0] if len(p2) >= 20 else 0
                    cur = {"row": row, "col": col, "cs": cs, "rs": rs, "w": w,
                           "psid": None, "text": []}
                elif t2 == C.HWPTAG_PARA_HEADER and cur is not None and cur["psid"] is None:
                    # 셀의 첫 PARA_HEADER는 LIST_HEADER와 같은 level에 온다(level+1 아님).
                    if len(p2) >= 10:
                        cur["psid"] = struct.unpack_from("<H", p2, 8)[0]
                elif t2 == C.HWPTAG_PARA_TEXT and l2 == level + 1 and cur is not None:
                    cur["text"].append(C.decode_para_text(p2).strip())
                elif t2 == C.HWPTAG_TABLE or (t2 == C.HWPTAG_CTRL_HEADER and l2 <= level):
                    break
                j += 1
            if cur:
                cells.append(cur)
            i = j

            if only and tnum != only:
                continue
            print("\n===== 표#%d  %d행 x %d열 =====" % (tnum, nrows, ncols))
            # 열별 대표 폭(0행 우선)
            colw = {}
            for c in cells:
                if c["cs"] == 1 and c["col"] not in colw:
                    colw[c["col"]] = c["w"]
            wsum = sum(colw.get(k, 0) for k in range(ncols))
            print("열 폭(mm): " + "  ".join(
                "c%d=%.0f(%.0f%%)" % (k, colw.get(k, 0) / HWPUNIT_PER_MM,
                                      100 * colw.get(k, 0) / wsum if wsum else 0)
                for k in range(ncols)))
            for c in cells:
                al = ALIGN.get(aligns[c["psid"]], "?") if (c["psid"] is not None and c["psid"] < len(aligns)) else "?"
                span = (" span%dx%d" % (c["rs"], c["cs"])) if (c["cs"] > 1 or c["rs"] > 1) else ""
                txt = " | ".join(t for t in c["text"] if t)
                txt = (txt[:50] + "…") if len(txt) > 50 else txt
                print("  (%d,%d)%s  w=%.0fmm  정렬=%s  %r" % (
                    c["row"], c["col"], span, c["w"] / HWPUNIT_PER_MM, al, txt))
    ole.close()


if __name__ == "__main__":
    inspect(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else None)
