#!/usr/bin/env python3
"""HWP 문단별 PARA_LINE_SEG(저장된 줄 배치)를 덤프 — 겹침 진단용."""
import sys, struct, zlib
import olefile

HWPTAG_BEGIN = 0x10
PARA_HEADER = HWPTAG_BEGIN + 50      # 66
PARA_TEXT = HWPTAG_BEGIN + 51        # 67
PARA_LINE_SEG = HWPTAG_BEGIN + 53    # 69

def records(data):
    pos = 0
    while pos + 4 <= len(data):
        hdr = struct.unpack_from('<I', data, pos)[0]
        tag = hdr & 0x3FF
        level = (hdr >> 10) & 0x3FF
        size = (hdr >> 20) & 0xFFF
        pos += 4
        if size == 0xFFF:
            size = struct.unpack_from('<I', data, pos)[0]
            pos += 4
        yield tag, level, data[pos:pos+size]
        pos += size

path = sys.argv[1]
ole = olefile.OleFileIO(path)
raw = ole.openstream('BodyText/Section0').read()
data = zlib.decompress(raw, -15)

para_idx = -1
text = ''
out = []
for tag, level, payload in records(data):
    if tag == PARA_HEADER and level == 0:
        para_idx += 1
        text = ''
        out.append({'idx': para_idx, 'text': '', 'segs': []})
    elif tag == PARA_TEXT and out and level == 1:
        # UTF-16LE, 제어문자(코드<32)는 건너뛰기 단순화
        chars = []
        i = 0
        while i + 2 <= len(payload):
            ch = struct.unpack_from('<H', payload, i)[0]
            if ch >= 32:
                chars.append(chr(ch))
                i += 2
            else:
                # 제어문자: 일부는 8바이트 추가
                if ch in (1,2,3,11,12,14,15,16,17,18,21,22,23):
                    i += 16
                else:
                    i += 2
        out[-1]['text'] = ''.join(chars)[:30]
    elif tag == PARA_LINE_SEG and out and level == 1:
        n = len(payload) // 36
        segs = []
        for k in range(n):
            off = k * 36
            text_start, vpos, line_h, text_h, base, spacing, col_start, seg_w, tagv = struct.unpack_from('<IiiiiiiiI', payload, off)
            segs.append((vpos, line_h))
        out[-1]['segs'] = segs

target = sys.argv[2] if len(sys.argv) > 2 else None
start = 0
if target:
    for i, p in enumerate(out):
        if target in p['text']:
            start = max(0, i - 2)
            break
for p in out[start:start+28]:
    segs = p['segs']
    desc = ' '.join(f"(y={v},h={h})" for v, h in segs[:5])
    more = f" …+{len(segs)-5}" if len(segs) > 5 else ''
    print(f"p[{p['idx']:3}] segs={len(segs):2} {desc}{more} | {p['text']}")
