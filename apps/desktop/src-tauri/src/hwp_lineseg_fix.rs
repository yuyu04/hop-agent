//! 저장 직전 PARA_LINE_SEG의 줄 세로 위치(vpos)를 '페이지 상대'로 보정한다.
//!
//! HWP 포맷의 줄 배치 캐시(PARA_LINE_SEG)는 줄 vpos가 **페이지(본문 영역)마다 0부터
//! 다시 시작**하는 것이 한컴 의미론이다(한컴 저장 파일 실측). rhwp의 내부 모델은
//! 구역 누적 vpos라 그대로 직렬화되면 2쪽 이상 문서에서 표준을 벗어나고, 저장된
//! 줄 배치를 신뢰하는 소비자(구버전 HOP·뷰어류)에서 문단이 겹쳐 보인다.
//!
//! 보정 방법: 같은 바이트를 rhwp로 다시 파스해 실제 페이지네이션을 돌린 뒤, 각 줄의
//! 시작 글자 위치(text_start)로 `get_cursor_rect_native`를 호출해 '페이지 상대 px'를
//! 얻고, 본문 영역 원점(margin_top + margin_header)을 뺀 HWPUNIT으로 vpos를
//! 덮어쓴다. 값(4바이트)만 교체하므로 레코드 크기·구조는 변하지 않는다.
//! rhwp는 read-only 서브모듈이므로 hwp_table_fix와 같은 저장 후처리로 우회한다.
//! 어떤 단계든 실패하면 원본 바이트를 그대로 반환한다(fail-closed).

use crate::hwp_table_fix::{
    collect_section_paths, deflate_raw, inflate_raw, read_header_flags, read_stream, write_stream,
};
use std::io::Cursor;

const HWPTAG_BEGIN: u16 = 0x10;
const TAG_PARA_HEADER: u16 = HWPTAG_BEGIN + 50;
const TAG_PARA_LINE_SEG: u16 = HWPTAG_BEGIN + 53;
const TAG_PAGE_DEF: u16 = HWPTAG_BEGIN + 57;
/// PARA_LINE_SEG 엔트리 크기(고정 36바이트: text_start, vpos, line_h, text_h, …, tag).
const SEG_ENTRY: usize = 36;
/// 커서 좌표(px)는 코어 기본 DPI(96) 기준이다.
const DPI: f64 = 96.0;

pub fn fix_linesegs(bytes: Vec<u8>) -> Vec<u8> {
    match try_fix(&bytes) {
        Some(fixed) => fixed,
        None => bytes,
    }
}

fn try_fix(bytes: &[u8]) -> Option<Vec<u8>> {
    // 진실 소스: 저장하려는 바이트를 그대로 파스해 재배치한 코어(페이지 상대 좌표 제공).
    let core = crate::state::editable_core_from_bytes(
        bytes,
        "lineseg 보정용 파싱 실패",
        "lineseg 보정용 변환 실패",
    )
    .ok()?;

    let cursor = Cursor::new(bytes.to_vec());
    let mut comp = cfb::CompoundFile::open(cursor).ok()?;
    let (compressed, encrypted) = read_header_flags(&mut comp)?;
    if encrypted {
        return None;
    }
    let section_paths = collect_section_paths(&comp);
    if section_paths.is_empty() {
        return None;
    }

    let mut any_changed = false;
    for path in section_paths {
        let sec_idx = section_index_from_path(&path)?;
        let raw = read_stream(&mut comp, &path)?;
        let mut decoded = if compressed { inflate_raw(&raw)? } else { raw.clone() };

        // 바이트 스트림의 최상위 문단 수와 코어 문단 수가 다르면 매핑이 어긋난 것 —
        // 건드리지 않는다(fail-closed).
        let stream_paras = count_top_level_paragraphs(&decoded);
        let core_paras = core.get_paragraph_count_native(sec_idx).ok()?;
        if stream_paras != core_paras {
            return None;
        }

        if patch_section_linesegs(&mut decoded, &core, sec_idx)? {
            let encoded = if compressed { deflate_raw(&decoded) } else { decoded };
            write_stream(&mut comp, &path, &encoded)?;
            any_changed = true;
        }
    }
    if !any_changed {
        return None;
    }
    comp.flush().ok()?;
    let fixed = comp.into_inner().into_inner();
    // 보정본이 다시 파스되는지 확인 — 실패하면 호출 측이 원본으로 폴백한다.
    crate::state::editable_core_from_bytes(&fixed, "보정본 검증 실패", "보정본 변환 실패").ok()?;
    Some(fixed)
}

/// `BodyText/SectionN` 경로에서 N을 꺼낸다.
fn section_index_from_path(path: &str) -> Option<usize> {
    path.rsplit("Section").next()?.parse().ok()
}

/// 레코드를 순회하며 최상위(level 0) PARA_HEADER 수를 센다.
fn count_top_level_paragraphs(data: &[u8]) -> usize {
    let mut count = 0usize;
    walk_records(data, |tag, level, _, _| {
        if tag == TAG_PARA_HEADER && level == 0 {
            count += 1;
        }
        true
    });
    count
}

/// 레코드 순회 헬퍼. 콜백: (tag, level, body_offset, body_len) → 계속 여부.
fn walk_records(data: &[u8], mut f: impl FnMut(u16, u16, usize, usize) -> bool) {
    let mut pos = 0usize;
    while pos + 4 <= data.len() {
        let hdr = u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]);
        let tag = (hdr & 0x3FF) as u16;
        let level = ((hdr >> 10) & 0x3FF) as u16;
        let mut size = ((hdr >> 20) & 0xFFF) as usize;
        let mut body = pos + 4;
        if size == 0xFFF {
            if body + 4 > data.len() {
                return;
            }
            size = u32::from_le_bytes([
                data[body],
                data[body + 1],
                data[body + 2],
                data[body + 3],
            ]) as usize;
            body += 4;
        }
        if body + size > data.len() {
            return;
        }
        if !f(tag, level, body, size) {
            return;
        }
        pos = body + size;
    }
}

/// 한 섹션 스트림의 최상위 문단 LINE_SEG vpos를 페이지 상대값으로 덮어쓴다.
/// 반환: 변경 여부(None = 좌표 조회 실패 등 — 호출 측이 전체를 포기).
fn patch_section_linesegs(
    data: &mut [u8],
    core: &rhwp::DocumentCore,
    sec_idx: usize,
) -> Option<bool> {
    // 1) 본문 영역 원점: PAGE_DEF의 margin_top + margin_header.
    let mut body_top: i32 = 0;
    walk_records(data, |tag, _level, off, len| {
        if tag == TAG_PAGE_DEF && len >= 32 {
            let read_u32 = |i: usize| {
                u32::from_le_bytes([data[off + i], data[off + i + 1], data[off + i + 2], data[off + i + 3]])
            };
            let margin_top = read_u32(16) as i32;
            let margin_header = read_u32(24) as i32;
            body_top = margin_top + margin_header;
            return false; // 첫 PAGE_DEF만.
        }
        true
    });

    // 2) 최상위 문단의 LINE_SEG 위치들을 수집(레벨 0 PARA_HEADER 직속 = 레벨 1).
    struct Target {
        para_idx: usize,
        body_off: usize,
        entries: usize,
    }
    let mut targets: Vec<Target> = Vec::new();
    let mut para_idx: isize = -1;
    let mut top_level_para = false;
    walk_records(data, |tag, level, off, len| {
        if tag == TAG_PARA_HEADER {
            top_level_para = level == 0;
            if top_level_para {
                para_idx += 1;
            }
        } else if tag == TAG_PARA_LINE_SEG && level == 1 && top_level_para && para_idx >= 0 {
            targets.push(Target {
                para_idx: para_idx as usize,
                body_off: off,
                entries: len / SEG_ENTRY,
            });
        }
        true
    });
    if targets.is_empty() {
        return Some(false);
    }

    // 3) 줄마다 커서 좌표(페이지 상대 px) → HWPUNIT vpos.
    // 줄 '시작' 오프셋은 줄 경계라 이전 줄로 해석될 수 있어, 줄의 '중간 글자'를 찍는다.
    let mut changed = false;
    for target in &targets {
        let para_len = core
            .get_paragraph_length_native(sec_idx, target.para_idx)
            .ok()?;
        let starts: Vec<usize> = (0..target.entries)
            .map(|k| {
                let entry = target.body_off + k * SEG_ENTRY;
                u32::from_le_bytes([
                    data[entry],
                    data[entry + 1],
                    data[entry + 2],
                    data[entry + 3],
                ]) as usize
            })
            .collect();
        for k in 0..target.entries {
            let entry = target.body_off + k * SEG_ENTRY;
            let start = starts[k];
            let end = if k + 1 < target.entries { starts[k + 1] } else { para_len };
            let mid = if end > start { start + (end - start - 1) / 2 } else { start };
            let rect_json = core
                .get_cursor_rect_native(sec_idx, target.para_idx, mid)
                .ok()?;
            let rect: serde_json::Value = serde_json::from_str(&rect_json).ok()?;
            let y_px = rect.get("y")?.as_f64()?;
            let vpos = (rhwp::renderer::px_to_hwpunit(y_px, DPI) - body_top).max(0);
            let old = i32::from_le_bytes([
                data[entry + 4],
                data[entry + 5],
                data[entry + 6],
                data[entry + 7],
            ]);
            // px 변환 반올림 수준(±80 HWPUNIT ≈ 1px)의 차이는 의미가 없으므로 건너뛴다 —
            // 1쪽 문서(누적==페이지 상대)는 바이트가 전혀 바뀌지 않는다.
            if (old - vpos).abs() > 80 {
                data[entry + 4..entry + 8].copy_from_slice(&vpos.to_le_bytes());
                changed = true;
            }
        }
    }
    Some(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hwp_table_fix::{
        collect_section_paths as csp, inflate_raw as inflate, read_header_flags as rhf,
        read_stream as rs,
    };

    /// 바이트에서 최상위 문단 LINE_SEG vpos들을 (등장 순서대로) 수집한다.
    fn collect_body_vpos(bytes: &[u8]) -> Vec<i32> {
        let mut comp = cfb::CompoundFile::open(Cursor::new(bytes.to_vec())).unwrap();
        let (compressed, _) = rhf(&mut comp).unwrap();
        let mut out = Vec::new();
        for path in csp(&comp) {
            let raw = rs(&mut comp, &path).unwrap();
            let data = if compressed { inflate(&raw).unwrap() } else { raw };
            let mut top = false;
            walk_records(&data, |tag, level, off, len| {
                if tag == TAG_PARA_HEADER {
                    top = level == 0;
                } else if tag == TAG_PARA_LINE_SEG && level == 1 && top {
                    for k in 0..len / SEG_ENTRY {
                        let e = off + k * SEG_ENTRY;
                        out.push(i32::from_le_bytes([
                            data[e + 4],
                            data[e + 5],
                            data[e + 6],
                            data[e + 7],
                        ]));
                    }
                }
                true
            });
        }
        out
    }

    fn multipage_doc() -> (rhwp::DocumentCore, Vec<u8>) {
        let mut core = rhwp::DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        let body = "이 문단은 다중 페이지 줄 배치 저장 검증을 위한 본문입니다. \
                    충분히 길게 써서 한 문단이 여러 줄을 차지하게 합니다. \
                    페이지 경계를 넘는 내용이 필요합니다.";
        core.insert_text_native(0, 0, 0, "다중 페이지 줄 배치 검증").unwrap();
        for i in 0..60 {
            let len = core.get_paragraph_length_native(0, i).unwrap();
            core.split_paragraph_native(0, i, len).unwrap();
            core.insert_text_native(0, i + 1, 0, body).unwrap();
            core.apply_para_format_native(
                0,
                i + 1,
                r#"{"lineSpacingType":"Percent","lineSpacing":180,"spacingAfter":600}"#,
            )
            .unwrap();
        }
        core.reflow_linesegs_on_demand();
        let bytes = core.export_hwp_native().unwrap();
        (core, bytes)
    }

    /// 핵심 계약: rhwp가 구역 누적으로 저장한 vpos(재현)를 페이지 상대로 보정한다.
    #[test]
    fn rewrites_cumulative_vpos_to_page_relative() {
        let (core, raw) = multipage_doc();
        assert!(core.page_count() >= 3, "다중 페이지 전제: {}", core.page_count());

        // 재현: 보정 전에는 구역 누적이라 종이 높이(84,188)를 훌쩍 넘는다.
        const PAPER_H: i32 = 84_188;
        let before = collect_body_vpos(&raw);
        assert!(*before.iter().max().unwrap() > PAPER_H, "재현 실패: {:?}", before.iter().max());

        let fixed = fix_linesegs(raw.clone());
        assert_ne!(fixed, raw, "보정이 적용되지 않음");

        let after = collect_body_vpos(&fixed);
        assert_eq!(after.len(), before.len());
        // 페이지 상대: 모든 줄이 종이 높이 이내 + 페이지 경계 리셋 존재 + 첫 줄은 본문 원점.
        assert!(*after.iter().max().unwrap() < PAPER_H, "여전히 누적: {:?}", after.iter().max());
        let resets = after.windows(2).filter(|w| w[1] < w[0]).count();
        assert!(
            resets >= core.page_count().saturating_sub(1) as usize,
            "페이지 리셋 없음: resets={} pages={}",
            resets,
            core.page_count()
        );
        assert!(after[0] < 200, "첫 줄이 본문 원점이 아님: {}", after[0]);

        // 보정본은 그대로 다시 열리고 본문 텍스트가 보존된다.
        let reloaded =
            crate::state::editable_core_from_bytes(&fixed, "파싱 실패", "변환 실패").unwrap();
        let orig_text = crate::ai::serialize::extract_all_text(&core).unwrap();
        let new_text = crate::ai::serialize::extract_all_text(&reloaded).unwrap();
        assert_eq!(orig_text, new_text);
    }

    /// 한 쪽짜리 문서(누적==페이지 상대)는 사실상 변화가 없어야 한다(값 동등 보정).
    #[test]
    fn single_page_doc_stays_consistent() {
        let mut core = rhwp::DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        core.insert_text_native(0, 0, 0, "한 쪽짜리 문서").unwrap();
        let raw = core.export_hwp_native().unwrap();
        let fixed = fix_linesegs(raw.clone());
        let before = collect_body_vpos(&raw);
        let after = collect_body_vpos(&fixed);
        assert_eq!(before.len(), after.len());
        // epsilon 덕에 1쪽 문서는 바이트가 전혀 바뀌지 않는다(저장 안정성).
        assert_eq!(before, after);
        assert_eq!(fixed, raw);
    }

    /// 깨진 입력은 원본 그대로 반환한다(fail-closed).
    #[test]
    fn garbage_input_is_returned_unchanged() {
        let junk = vec![1u8, 2, 3, 4];
        assert_eq!(fix_linesegs(junk.clone()), junk);
    }
}

#[cfg(test)]
mod manual_probe {
    /// [진단] HOP_HWP 파일에 보정을 적용해 HOP_OUT으로 쓴다(실파일 확인용).
    #[test]
    #[ignore]
    fn fix_external_file() {
        let input = std::env::var("HOP_HWP").unwrap();
        let output = std::env::var("HOP_OUT").unwrap();
        let bytes = std::fs::read(&input).unwrap();
        let fixed = super::fix_linesegs(bytes.clone());
        assert_ne!(fixed, bytes, "보정이 적용되지 않음");
        std::fs::write(&output, &fixed).unwrap();
        eprintln!("fixed → {}", output);
    }
}

#[cfg(test)]
mod rect_probe {
    /// [진단] HOP_HWP의 지정 문단들 커서 좌표(page,y)와 PAGE_DEF를 출력.
    #[test]
    #[ignore]
    fn dump_cursor_pages() {
        let input = std::env::var("HOP_HWP").unwrap();
        let bytes = std::fs::read(&input).unwrap();
        let core = crate::state::editable_core_from_bytes(&bytes, "p", "c").unwrap();
        eprintln!("page_count={}", core.page_count());
        for para in [42usize, 43, 44, 45, 46] {
            let len = core.get_paragraph_length_native(0, para).unwrap_or(0);
            for off in [0usize, len.saturating_sub(1)] {
                if let Ok(json) = core.get_cursor_rect_native(0, para, off) {
                    eprintln!("p[{}] off={} -> {}", para, off, json);
                }
            }
        }
    }
}
