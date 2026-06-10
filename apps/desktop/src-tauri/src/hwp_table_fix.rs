//! 저장 시 표 CTRL_HEADER(개체 공통 속성) 보정.
//!
//! rhwp의 `create_table_native`는 표 컨트롤의 `raw_ctrl_data`를 38바이트로만 만든다.
//! 게다가 표 직렬화기(`serialize_table`)는 다른 개체와 달리 이 raw 바이트를 그대로
//! 쓰기 때문에, 우리가 삽입한 표는 CTRL_HEADER가 42바이트(정상 48바이트보다 6바이트
//! 부족)로 저장되고 다음 문제가 생긴다.
//!
//! - `prevent_page_break`(offset 36..40)와 설명문 필드가 통째로 누락 → 한글이 표를
//!   페이지 경계에서 자유롭게 쪼갬("표가 두 페이지로 쪼개짐"의 직접 원인).
//! - FLAGS = 0x002A0310 → treat_as_char(bit0)=0인데 horzRelTo(bit8-9)=3(단락)이라
//!   앵커링 상태가 모순.
//!
//! rhwp는 upstream submodule이라 수정하지 않는다. 대신 저장 직전 내보낸 HWP 바이트를
//! 후처리하여, 표 CTRL_HEADER를 정상 48바이트 레이아웃(treat_as_char=1, horzRelTo=2,
//! offset=0, prevent_page_break/설명문 포함)으로 다시 쓴다.
//!
//! 보수적으로 동작한다: CFB가 아니거나, 암호화/압축 해제 실패 등 예상치 못한 경우엔
//! **원본 바이트를 그대로 반환**한다(저장을 절대 악화시키지 않는다).

use std::io::{Cursor, Read, Seek, SeekFrom, Write};

/// HWPTAG_CTRL_HEADER = HWPTAG_BEGIN(0x10) + 55.
const HWPTAG_CTRL_HEADER: u16 = 71;
/// 표 컨트롤 ID `ctrl_id(b"tbl ")` = 0x74626C20 의 little-endian 바이트 (= b" lbt").
const TABLE_CTRL_ID: [u8; 4] = [0x20, 0x6C, 0x62, 0x74];
/// 정상 `raw_ctrl_data` 길이(개체 공통 속성, ctrlID 제외). ctrlID 4 + 44 = 48바이트.
const CORRECT_RAW_LEN: usize = 44;

/// 내보낸 HWP 바이트의 표 CTRL_HEADER를 보정한다. 실패 시 입력을 그대로 반환한다.
pub fn fix_table_headers(bytes: Vec<u8>) -> Vec<u8> {
    match try_fix(&bytes) {
        Some(fixed) => fixed,
        None => bytes,
    }
}

fn try_fix(bytes: &[u8]) -> Option<Vec<u8>> {
    let cursor = Cursor::new(bytes.to_vec());
    let mut comp = cfb::CompoundFile::open(cursor).ok()?;

    let (compressed, encrypted) = read_header_flags(&mut comp)?;
    // 암호화/배포 문서는 섹션 본문을 해석할 수 없으므로 건드리지 않는다.
    if encrypted {
        return None;
    }

    let section_paths = collect_section_paths(&comp);
    if section_paths.is_empty() {
        return None;
    }

    let mut any_changed = false;
    for path in section_paths {
        let raw = read_stream(&mut comp, &path)?;
        let decoded = if compressed {
            match inflate_raw(&raw) {
                Some(d) => d,
                None => continue, // 해석 불가 섹션은 건너뛴다.
            }
        } else {
            raw
        };
        let (patched, count) = patch_records(&decoded);
        if count == 0 {
            continue;
        }
        let encoded = if compressed {
            deflate_raw(&patched)
        } else {
            patched
        };
        write_stream(&mut comp, &path, &encoded)?;
        any_changed = true;
    }

    if !any_changed {
        return None;
    }
    comp.flush().ok()?;
    Some(comp.into_inner().into_inner())
}

/// FileHeader(256바이트, 비압축) offset 36 속성 플래그에서 (compressed, encrypted)를 읽는다.
pub(crate) fn read_header_flags(comp: &mut cfb::CompoundFile<Cursor<Vec<u8>>>) -> Option<(bool, bool)> {
    let fh = read_stream(comp, "/FileHeader")?;
    if fh.len() < 40 {
        return None;
    }
    let flags = u32::from_le_bytes([fh[36], fh[37], fh[38], fh[39]]);
    Some((flags & 0x01 != 0, flags & 0x02 != 0))
}

/// 본문 섹션 스트림 경로를 모은다 (`/BodyText/SectionN` 및 구버전 `/SectionN`).
pub(crate) fn collect_section_paths(comp: &cfb::CompoundFile<Cursor<Vec<u8>>>) -> Vec<String> {
    let mut paths = Vec::new();
    for entry in comp.walk() {
        if !entry.is_stream() {
            continue;
        }
        let p = entry.path().to_string_lossy().replace('\\', "/");
        let name = p.rsplit('/').next().unwrap_or("");
        let is_section = name
            .strip_prefix("Section")
            .map(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
            .unwrap_or(false);
        // BodyText 하위 또는 루트의 SectionN만 (ViewText=배포용 암호화 섹션 제외).
        if is_section && (p.starts_with("/BodyText/") || p.matches('/').count() == 1) {
            paths.push(p);
        }
    }
    paths
}

pub(crate) fn read_stream(comp: &mut cfb::CompoundFile<Cursor<Vec<u8>>>, path: &str) -> Option<Vec<u8>> {
    if !comp.is_stream(path) {
        return None;
    }
    let mut s = comp.open_stream(path).ok()?;
    let mut buf = Vec::new();
    s.read_to_end(&mut buf).ok()?;
    Some(buf)
}

pub(crate) fn write_stream(
    comp: &mut cfb::CompoundFile<Cursor<Vec<u8>>>,
    path: &str,
    data: &[u8],
) -> Option<()> {
    let mut s = comp.open_stream(path).ok()?;
    s.set_len(0).ok()?;
    s.seek(SeekFrom::Start(0)).ok()?;
    s.write_all(data).ok()?;
    s.flush().ok()?;
    Some(())
}

pub(crate) fn inflate_raw(data: &[u8]) -> Option<Vec<u8>> {
    use flate2::read::DeflateDecoder;
    let mut d = DeflateDecoder::new(data);
    let mut out = Vec::new();
    d.read_to_end(&mut out).ok()?;
    Some(out)
}

pub(crate) fn deflate_raw(data: &[u8]) -> Vec<u8> {
    use flate2::write::DeflateEncoder;
    use flate2::Compression;
    let mut e = DeflateEncoder::new(Vec::new(), Compression::default());
    e.write_all(data).expect("deflate into Vec는 실패하지 않는다");
    e.finish().expect("deflate finish는 실패하지 않는다")
}

/// 레코드 스트림을 순회하며 결함 있는 표 CTRL_HEADER를 보정한다.
/// 반환: (보정된 바이트, 보정한 레코드 수).
fn patch_records(data: &[u8]) -> (Vec<u8>, usize) {
    let mut out = Vec::with_capacity(data.len() + 16);
    let mut i = 0usize;
    let mut count = 0usize;

    while i + 4 <= data.len() {
        let header = u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
        let tag = (header & 0x3FF) as u16;
        let level = (header >> 10) & 0x3FF;
        let mut size = ((header >> 20) & 0xFFF) as usize;
        let mut header_len = 4usize;
        if size == 0xFFF {
            if i + 8 > data.len() {
                out.extend_from_slice(&data[i..]);
                i = data.len();
                break;
            }
            size = u32::from_le_bytes([data[i + 4], data[i + 5], data[i + 6], data[i + 7]]) as usize;
            header_len = 8;
        }
        let body_start = i + header_len;
        let body_end = body_start + size;
        if body_end > data.len() {
            // 잘린 레코드 — 남은 바이트를 그대로 보존하고 종료.
            out.extend_from_slice(&data[i..]);
            i = data.len();
            break;
        }
        let body = &data[body_start..body_end];

        let is_broken_table = tag == HWPTAG_CTRL_HEADER
            && body.len() >= 4
            && body[0..4] == TABLE_CTRL_ID
            && body.len() - 4 < CORRECT_RAW_LEN;

        if is_broken_table {
            let new_body = rebuild_table_ctrl(body);
            write_record(&mut out, tag, level, &new_body);
            count += 1;
        } else {
            out.extend_from_slice(&data[i..body_end]);
        }
        i = body_end;
    }
    if i < data.len() {
        out.extend_from_slice(&data[i..]);
    }
    (out, count)
}

/// 표 CTRL_HEADER 바디(ctrlID + 결함 raw)를 정상 48바이트 레이아웃으로 재구성한다.
fn rebuild_table_ctrl(body: &[u8]) -> Vec<u8> {
    let raw = &body[4..];
    let ru32 = |off: usize| -> u32 {
        if off + 4 <= raw.len() {
            u32::from_le_bytes([raw[off], raw[off + 1], raw[off + 2], raw[off + 3]])
        } else {
            0
        }
    };
    let ri16 = |off: usize| -> i16 {
        if off + 2 <= raw.len() {
            i16::from_le_bytes([raw[off], raw[off + 1]])
        } else {
            0
        }
    };

    let old_flags = ru32(0);
    // treat_as_char(bit0)=1, horzRelTo(bit8-9)=2 로 일관화 (나머지 비트는 보존).
    let new_flags = (old_flags & !(0b11u32 << 8)) | 0b1 | (2u32 << 8);
    let width = ru32(12);
    let height = ru32(16);
    let z_order = ru32(20);
    let (m_l, m_r, m_t, m_b) = (ri16(24), ri16(26), ri16(28), ri16(30));
    let instance_id = ru32(32);

    let mut new_raw = Vec::with_capacity(CORRECT_RAW_LEN);
    new_raw.extend_from_slice(&new_flags.to_le_bytes()); // 0..4   FLAGS
    new_raw.extend_from_slice(&0u32.to_le_bytes()); //        4..8   V_OFFSET = 0 (음수 제거)
    new_raw.extend_from_slice(&0u32.to_le_bytes()); //        8..12  H_OFFSET = 0
    new_raw.extend_from_slice(&width.to_le_bytes()); //       12..16 WIDTH
    new_raw.extend_from_slice(&height.to_le_bytes()); //      16..20 HEIGHT
    new_raw.extend_from_slice(&z_order.to_le_bytes()); //     20..24 Z_ORDER
    new_raw.extend_from_slice(&m_l.to_le_bytes()); //         24..26 MARGIN_LEFT
    new_raw.extend_from_slice(&m_r.to_le_bytes()); //         26..28 MARGIN_RIGHT
    new_raw.extend_from_slice(&m_t.to_le_bytes()); //         28..30 MARGIN_TOP
    new_raw.extend_from_slice(&m_b.to_le_bytes()); //         30..32 MARGIN_BOTTOM
    new_raw.extend_from_slice(&instance_id.to_le_bytes()); // 32..36 INSTANCE_ID
    new_raw.extend_from_slice(&[0u8; 8]); //                  36..44 prevent_page_break(0)+설명문(len 0)+여유
    debug_assert_eq!(new_raw.len(), CORRECT_RAW_LEN);

    let mut out = Vec::with_capacity(4 + CORRECT_RAW_LEN);
    out.extend_from_slice(&body[0..4]); // ctrlID
    out.extend_from_slice(&new_raw);
    out
}

fn write_record(out: &mut Vec<u8>, tag: u16, level: u32, body: &[u8]) {
    let size = body.len();
    if size < 0xFFF {
        let header = (tag as u32 & 0x3FF) | ((level & 0x3FF) << 10) | ((size as u32 & 0xFFF) << 20);
        out.extend_from_slice(&header.to_le_bytes());
    } else {
        let header = (tag as u32 & 0x3FF) | ((level & 0x3FF) << 10) | (0xFFF << 20);
        out.extend_from_slice(&header.to_le_bytes());
        out.extend_from_slice(&(size as u32).to_le_bytes());
    }
    out.extend_from_slice(body);
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 레코드 헤더(tag/level/size)를 만든다.
    fn rec_header(tag: u16, level: u32, size: usize) -> [u8; 4] {
        let h = (tag as u32 & 0x3FF) | ((level & 0x3FF) << 10) | ((size as u32 & 0xFFF) << 20);
        h.to_le_bytes()
    }

    /// 결함 있는 표 CTRL_HEADER 레코드(ctrlID + 38바이트 raw) 한 개로 된 섹션을 만든다.
    fn buggy_table_section() -> Vec<u8> {
        let mut raw = vec![0u8; 38];
        // create_table_native가 쓰는 FLAGS = 0x002A0310.
        raw[0..4].copy_from_slice(&0x002A0310u32.to_le_bytes());
        raw[12..16].copy_from_slice(&50000u32.to_le_bytes()); // width
        raw[16..20].copy_from_slice(&20000u32.to_le_bytes()); // height
        raw[24..26].copy_from_slice(&283i16.to_le_bytes()); // margin left
        raw[26..28].copy_from_slice(&283i16.to_le_bytes());
        raw[28..30].copy_from_slice(&283i16.to_le_bytes());
        raw[30..32].copy_from_slice(&283i16.to_le_bytes());
        raw[32..36].copy_from_slice(&0x7c154b69u32.to_le_bytes()); // instance id

        let mut body = TABLE_CTRL_ID.to_vec();
        body.extend_from_slice(&raw);

        let mut sec = Vec::new();
        sec.extend_from_slice(&rec_header(HWPTAG_CTRL_HEADER, 1, body.len()));
        sec.extend_from_slice(&body);
        sec
    }

    #[test]
    fn rebuilds_broken_table_header_to_48_bytes() {
        let sec = buggy_table_section();
        let (patched, count) = patch_records(&sec);
        assert_eq!(count, 1);

        // 레코드 헤더(4) + ctrlID(4) + raw(44) = 52바이트.
        assert_eq!(patched.len(), 4 + 4 + CORRECT_RAW_LEN);
        let header = u32::from_le_bytes([patched[0], patched[1], patched[2], patched[3]]);
        let size = ((header >> 20) & 0xFFF) as usize;
        assert_eq!(size, 4 + CORRECT_RAW_LEN); // CTRL_HEADER 데이터 = 48바이트

        let raw = &patched[8..]; // ctrlID 이후 raw
        let flags = u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]);
        assert_eq!(flags & 0x1, 0x1, "treat_as_char 비트가 켜져야 한다");
        assert_eq!((flags >> 8) & 0x3, 2, "horzRelTo는 2(단)여야 한다");
        // v/h offset = 0 (음수 제거).
        assert_eq!(&raw[4..8], &0u32.to_le_bytes());
        assert_eq!(&raw[8..12], &0u32.to_le_bytes());
        // width/height/instance_id 보존.
        assert_eq!(u32::from_le_bytes([raw[12], raw[13], raw[14], raw[15]]), 50000);
        assert_eq!(u32::from_le_bytes([raw[16], raw[17], raw[18], raw[19]]), 20000);
        assert_eq!(
            u32::from_le_bytes([raw[32], raw[33], raw[34], raw[35]]),
            0x7c154b69
        );
        // 36..44 = 8바이트 0 (prevent_page_break + 설명문 + 여유).
        assert_eq!(&raw[36..44], &[0u8; 8]);
    }

    #[test]
    fn leaves_correct_table_header_untouched() {
        // 이미 48바이트(raw 44)인 정상 표 헤더는 건드리지 않는다.
        let mut body = TABLE_CTRL_ID.to_vec();
        body.extend_from_slice(&vec![0u8; CORRECT_RAW_LEN]);
        let mut sec = Vec::new();
        sec.extend_from_slice(&rec_header(HWPTAG_CTRL_HEADER, 1, body.len()));
        sec.extend_from_slice(&body);

        let (patched, count) = patch_records(&sec);
        assert_eq!(count, 0);
        assert_eq!(patched, sec);
    }

    #[test]
    fn leaves_non_table_records_untouched() {
        // 표가 아닌 CTRL_HEADER(예: 단 정의 'cold')는 건드리지 않는다.
        let mut body = vec![0x64, 0x6C, 0x6F, 0x63]; // "cold" 역순 비슷한 임의 ctrlID
        body.extend_from_slice(&vec![0u8; 10]);
        let mut sec = Vec::new();
        sec.extend_from_slice(&rec_header(HWPTAG_CTRL_HEADER, 1, body.len()));
        sec.extend_from_slice(&body);

        let (patched, count) = patch_records(&sec);
        assert_eq!(count, 0);
        assert_eq!(patched, sec);
    }

    #[test]
    fn preserves_surrounding_records() {
        // [앞 레코드][결함 표 헤더][뒤 레코드] 순서/내용이 보존되어야 한다.
        let mut sec = Vec::new();
        // 앞: 임의 태그(5) level 0 size 3
        sec.extend_from_slice(&rec_header(5, 0, 3));
        sec.extend_from_slice(&[0xAA, 0xBB, 0xCC]);
        let before_len = sec.len();
        sec.extend_from_slice(&buggy_table_section());
        // 뒤: 임의 태그(6) level 0 size 2
        sec.extend_from_slice(&rec_header(6, 0, 2));
        sec.extend_from_slice(&[0xDE, 0xAD]);

        let (patched, count) = patch_records(&sec);
        assert_eq!(count, 1);
        // 앞 레코드 보존.
        assert_eq!(&patched[..before_len], &sec[..before_len]);
        // 뒤 레코드(태그 6, 데이터 DE AD)가 끝부분에 존재.
        assert_eq!(&patched[patched.len() - 2..], &[0xDE, 0xAD]);
    }

    #[test]
    fn deflate_inflate_round_trip() {
        let original = buggy_table_section();
        let comp = deflate_raw(&original);
        let back = inflate_raw(&comp).unwrap();
        assert_eq!(back, original);
    }

    #[test]
    fn non_cfb_bytes_returned_unchanged() {
        let junk = b"this is not an OLE compound file".to_vec();
        assert_eq!(fix_table_headers(junk.clone()), junk);
    }

    #[test]
    fn real_exported_table_is_detected_patched_and_reparses() {
        use rhwp::DocumentCore;

        // rhwp로 실제 표를 만들고 HWP로 내보낸다 (결함 있는 38바이트 raw_ctrl_data).
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native()
            .expect("빈 문서 생성 성공");
        core.create_table_native(0, 0, 0, 7, 5)
            .expect("표 생성 성공");
        let exported = core.export_hwp_native().expect("HWP 내보내기 성공");

        // 보정이 결함 표를 찾아 바이트를 변경해야 한다.
        let fixed = fix_table_headers(exported.clone());
        assert_ne!(fixed, exported, "결함 표가 감지되어 보정되어야 한다");

        // 보정 결과를 rhwp가 다시 파싱할 수 있어야 한다 (폴백이 아닌 실제 적용 증명).
        DocumentCore::from_bytes(&fixed).expect("보정된 HWP가 rhwp로 재파싱되어야 한다");

        // 멱등성: 한 번 보정한 결과엔 결함 표가 없어 다시 보정해도 동일해야 한다.
        let fixed_again = fix_table_headers(fixed.clone());
        assert_eq!(fixed_again, fixed, "보정은 멱등이어야 한다");
    }

    /// 검증용: 병합 표(직접비×3 세로 병합)를 buggy/fixed 채우기로 각각 만들어
    /// /tmp 에 저장한다. `cargo test --lib -- --ignored verify_merge_fill_writes`
    /// 로 실행 후 hwp_table_check.py로 확인한다.
    #[test]
    #[ignore]
    fn verify_merge_fill_writes_tmp_files() {
        use rhwp::DocumentCore;

        let build = |fill_covered: bool| -> Vec<u8> {
            let mut core = DocumentCore::new_empty();
            core.create_blank_document_native().unwrap();
            // 3행×2열, col0 을 3행 세로 병합.
            let ret = core.create_table_native(0, 0, 0, 3, 2).unwrap();
            // 반환 JSON에서 paraIdx 파싱 (controlIdx는 항상 0).
            let pi: usize = ret
                .split("\"paraIdx\":")
                .nth(1)
                .and_then(|s| s.split(|ch: char| !ch.is_ascii_digit()).next())
                .and_then(|s| s.parse().ok())
                .unwrap();
            let mut put = |idx: usize, t: &str| {
                core.insert_text_in_cell_native(0, pi, 0, idx, 0, 0, t).unwrap();
            };
            let cell = |r: usize, c: usize| r * 2 + c; // row-major, cols=2
            put(cell(0, 0), "직접비"); // 대표 셀(0,0)
            if fill_covered {
                // 가려질 셀에도 같은 텍스트(버그 재현).
                put(cell(1, 0), "직접비");
                put(cell(2, 0), "직접비");
            }
            // 우측 칸은 정상 텍스트.
            put(cell(0, 1), "a");
            put(cell(1, 1), "b");
            put(cell(2, 1), "c");
            // 병합 (0,0)~(2,0).
            core.merge_table_cells_native(0, pi, 0, 0, 0, 2, 0).unwrap();
            let bytes = core.export_hwp_native().unwrap();
            fix_table_headers(bytes)
        };

        std::fs::write("/tmp/hop_buggy.hwp", build(true)).unwrap();
        std::fs::write("/tmp/hop_fixed.hwp", build(false)).unwrap();
    }

    #[test]
    fn cfb_round_trip_patches_section_stream() {
        // FileHeader(비압축) + BodyText/Section0(결함 표)로 된 CFB를 만들어
        // fix_table_headers가 섹션을 보정하고 다시 정상 CFB로 직렬화하는지 확인한다.
        let mut buf = Cursor::new(Vec::new());
        {
            let mut comp = cfb::CompoundFile::create(&mut buf).unwrap();
            // FileHeader: 256바이트, compressed=0/encrypted=0.
            let mut fh = vec![0u8; 256];
            fh[..b"HWP Document File".len()].copy_from_slice(b"HWP Document File");
            // flags(36..40) = 0 → 비압축.
            {
                let mut s = comp.create_stream("/FileHeader").unwrap();
                s.write_all(&fh).unwrap();
            }
            comp.create_storage("/BodyText").unwrap();
            {
                let mut s = comp.create_stream("/BodyText/Section0").unwrap();
                s.write_all(&buggy_table_section()).unwrap();
            }
            comp.flush().unwrap();
        }
        let bytes = buf.into_inner();

        let fixed = fix_table_headers(bytes.clone());
        assert_ne!(fixed, bytes, "보정으로 바이트가 달라져야 한다");

        // 다시 열어 Section0이 보정됐는지 확인.
        let mut comp = cfb::CompoundFile::open(Cursor::new(fixed)).unwrap();
        let mut s = comp.open_stream("/BodyText/Section0").unwrap();
        let mut sec = Vec::new();
        s.read_to_end(&mut sec).unwrap();
        let header = u32::from_le_bytes([sec[0], sec[1], sec[2], sec[3]]);
        let size = ((header >> 20) & 0xFFF) as usize;
        assert_eq!(size, 4 + CORRECT_RAW_LEN);
    }
}
