#!/usr/bin/env python3
"""HWP 표의 셀 내용을 행/열 그리드로 덤프한다(검증용). hwp_table_check.py와 동일 파서.

사용법: python3 hwp_table_dump.py <파일.hwp> [표번호(1부터)]
표번호 생략 시 모든 표를 덤프한다.
"""
import sys
import hwp_table_check as C
import olefile


def main():
    path = sys.argv[1]
    only = int(sys.argv[2]) if len(sys.argv) > 2 else None
    ole = olefile.OleFileIO(path)
    sections = sorted("/".join(e) for e in ole.listdir()
                      if len(e) == 2 and e[0] == "BodyText" and e[1].startswith("Section"))
    tnum = 0
    for sec in sections:
        data = C.get_section_data(ole, sec)
        recs, trunc = C.parse_records(data)
        for tbl in C.collect_tables(recs):
            tnum += 1
            if only and tnum != only:
                continue
            attr, nrows, ncols, cpr = C.decode_table_record(tbl["table_payload"])
            print(f"\n===== 표#{tnum}  {nrows}행 x {ncols}열  (cells={len(tbl['cells'])}) =====")
            for ci, c in enumerate(tbl["cells"]):
                txt = " | ".join(t for t in c["texts"] if t) or "(빈칸)"
                span = ""
                if c["cspan"] > 1 or c["rspan"] > 1:
                    span = f"  [span {c['rspan']}x{c['cspan']}]"
                print(f"  ({c['row']},{c['col']}){span}: {txt}")
    ole.close()


if __name__ == "__main__":
    main()
