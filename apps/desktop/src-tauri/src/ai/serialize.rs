//! 문서 직렬화 및 인덱싱 매핑(스펙 2장).
//!
//! rhwp `DocumentCore`를 순회하여 계층적 Path-based ID(`sec[s].p[p]`)를 부여한
//! LLM 피딩용 컨텍스트를 만든다. 동시에 부여한 모든 ID를 세션 화이트리스트로
//! 모아, LLM 응답의 `target_id` 환각을 검증할 수 있게 한다(스펙 7장).
//!
//! 표 내부 셀 텍스트의 행렬 직렬화는 후속 작업으로 남긴다. PR1은 문단 단위
//! 직렬화로 직렬화→화이트리스트→검증 경로 전체를 확립한다.

use rhwp::DocumentCore;
use serde::Serialize;
use std::collections::HashSet;

/// 스펙 4장 Sliding Window 임계치 — 전체 글자 수가 이를 넘으면 커서 주변만 직렬화한다.
const WINDOW_CHAR_THRESHOLD: usize = 30_000;
/// 커서 기준 앞/뒤로 포함할 문단 수(앞 5 + 뒤 5).
const WINDOW_RADIUS: usize = 5;
/// 표 셀 탐색 상한(무한 루프 방지). 일반 문서의 표 셀 수를 충분히 덮는다.
const MAX_TABLE_CELLS: usize = 4096;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DocumentMetadata {
    pub total_sections: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_cursor_path: Option<String>,
}

/// 직렬화된 콘텐츠 노드. `type` 태그로 종류를 구분한다(스펙 2장 JSON 포맷).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentNode {
    Paragraph { id: String, text: String },
}

impl ContentNode {
    /// PR3 적용 단계에서 target_id 매핑에 사용한다.
    #[allow(dead_code)]
    pub fn id(&self) -> &str {
        match self {
            ContentNode::Paragraph { id, .. } => id,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DocumentContext {
    pub document_metadata: DocumentMetadata,
    pub content: Vec<ContentNode>,
}

/// Sliding Window를 적용한 `DocumentContext`를 만든다(스펙 4장).
///
/// 전체 글자 수가 `WINDOW_CHAR_THRESHOLD`를 넘거나 `selection_only`가 참이면,
/// 커서 문단 기준 앞/뒤 `WINDOW_RADIUS`문단만 직렬화해 토큰 낭비와 외부 노출
/// 면적을 줄인다. 화이트리스트도 윈도우에 포함된 ID로만 좁혀지므로(스펙 7장),
/// LLM은 보이지 않는 문단을 편집 대상으로 삼을 수 없다.
///
/// 헤딩(목차) 전체 포함은 후속 작업이다 — `rhwp::DocumentCore`가 문단 스타일을
/// 네이티브로 노출하지 않아(필드가 `pub(crate)`) 현재 경계에서 구현할 수 없다.
pub fn build_windowed_context(
    core: &DocumentCore,
    cursor: Option<(usize, usize)>,
    selection_only: bool,
) -> Result<(DocumentContext, HashSet<String>), String> {
    let (paragraphs, total_sections) = collect_paragraphs(core)?;
    let total_chars: usize = paragraphs.iter().map(|(_, _, text)| text.chars().count()).sum();
    let cursor_path = cursor.map(|(sec, para)| format!("sec[{}].p[{}]", sec, para));

    let windowed = selection_only || total_chars > WINDOW_CHAR_THRESHOLD;
    let body: Vec<(String, String)> = if !windowed {
        paragraphs.iter().map(body_node).collect()
    } else {
        // 커서를 찾지 못하면 문서 앞쪽(0번)을 기준으로 윈도우를 잡는다.
        let anchor = cursor
            .and_then(|(sec, para)| paragraphs.iter().position(|(s, p, _)| *s == sec && *p == para))
            .unwrap_or(0);
        let start = anchor.saturating_sub(WINDOW_RADIUS);
        let end = (anchor + WINDOW_RADIUS + 1).min(paragraphs.len());
        paragraphs[start..end].iter().map(body_node).collect()
    };

    // 표 셀(스펙 2장)은 본문 윈도우와 무관하게 항상 포함한다 — 편집의 핵심 타깃이다.
    let mut nodes = body;
    nodes.extend(collect_table_cells(core));

    Ok(assemble(nodes, total_sections, cursor_path))
}

fn body_node(p: &Paragraph) -> (String, String) {
    (format!("sec[{}].p[{}]", p.0, p.1), p.2.clone())
}

/// `sec[<s>].p[<p>]` 형식의 커서 경로를 `(section, paragraph)`로 파싱한다.
/// 문단 경로가 아니면(예: 표 셀) `None`.
pub fn parse_cursor_path(path: &str) -> Option<(usize, usize)> {
    let rest = path.strip_prefix("sec[")?;
    let (sec, rest) = rest.split_once("].p[")?;
    let para = rest.strip_suffix(']')?;
    Some((sec.parse().ok()?, para.parse().ok()?))
}

/// 직렬화 중간 표현: `(section, paragraph, text)`.
type Paragraph = (usize, usize, String);

/// 문서의 모든 문단을 reading-order로 수집한다(`(sec, para, text)` + 구역 수).
fn collect_paragraphs(core: &DocumentCore) -> Result<(Vec<Paragraph>, u32), String> {
    let total_sections = section_count(core)?;
    let mut out = Vec::new();

    for section_idx in 0..total_sections as usize {
        let paragraph_count = core
            .get_paragraph_count_native(section_idx)
            .map_err(|e| format!("문단 수 조회 실패(sec {}): {}", section_idx, e))?;

        for para_idx in 0..paragraph_count {
            let length = core
                .get_paragraph_length_native(section_idx, para_idx)
                .map_err(|e| {
                    format!("문단 길이 조회 실패(sec {}, p {}): {}", section_idx, para_idx, e)
                })?;
            let text = core
                .get_text_range_native(section_idx, para_idx, 0, length)
                .map_err(|e| {
                    format!("문단 텍스트 조회 실패(sec {}, p {}): {}", section_idx, para_idx, e)
                })?;
            out.push((section_idx, para_idx, text));
        }
    }

    Ok((out, total_sections))
}

/// `(id, text)` 노드 목록으로 `DocumentContext` + 화이트리스트를 조립한다.
fn assemble(
    nodes: Vec<(String, String)>,
    total_sections: u32,
    cursor_path: Option<String>,
) -> (DocumentContext, HashSet<String>) {
    let mut content = Vec::with_capacity(nodes.len());
    let mut whitelist = HashSet::with_capacity(nodes.len());

    for (id, text) in nodes {
        whitelist.insert(id.clone());
        content.push(ContentNode::Paragraph { id, text });
    }

    let context = DocumentContext {
        document_metadata: DocumentMetadata {
            total_sections,
            current_cursor_path: cursor_path,
        },
        content,
    };
    (context, whitelist)
}

/// `get_page_control_layout_native`의 JSON에서 표 컨트롤 좌표 `(sec, para, ctrl)`만 뽑는다.
fn parse_table_controls(layout_json: &str) -> Vec<(usize, usize, usize)> {
    let value: serde_json::Value = match serde_json::from_str(layout_json) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    if let Some(controls) = value.get("controls").and_then(|c| c.as_array()) {
        for ctrl in controls {
            if ctrl.get("type").and_then(|t| t.as_str()) != Some("table") {
                continue;
            }
            if let (Some(s), Some(p), Some(c)) = (
                ctrl.get("secIdx").and_then(|v| v.as_u64()),
                ctrl.get("paraIdx").and_then(|v| v.as_u64()),
                ctrl.get("controlIdx").and_then(|v| v.as_u64()),
            ) {
                out.push((s as usize, p as usize, c as usize));
            }
        }
    }
    out
}

/// 모든 페이지의 표 셀을 직렬화한다(스펙 2장). 셀 ID는 `sec[S].p[P].tbl[C].cell[K].p[I]`.
///
/// 표 위치는 페이지 레이아웃에서 열거하고(다중 페이지 표는 중복 제거), 각 표의 셀은
/// `get_cell_paragraph_count_native`가 범위 초과로 실패할 때까지 0부터 훑는다.
fn collect_table_cells(core: &DocumentCore) -> Vec<(String, String)> {
    let mut tables: Vec<(usize, usize, usize)> = Vec::new();
    let mut seen: HashSet<(usize, usize, usize)> = HashSet::new();
    for page in 0..core.page_count() {
        if let Ok(layout) = core.get_page_control_layout_native(page) {
            for coords in parse_table_controls(&layout) {
                if seen.insert(coords) {
                    tables.push(coords);
                }
            }
        }
    }

    let mut out = Vec::new();
    for (sec, para, ctrl) in tables {
        let mut cell = 0usize;
        while cell < MAX_TABLE_CELLS {
            let cell_para_count = match core.get_cell_paragraph_count_native(sec, para, ctrl, cell) {
                Ok(count) => count,
                Err(_) => break, // 셀 인덱스 범위 초과 — 표 끝.
            };
            for cp in 0..cell_para_count {
                let length = core
                    .get_cell_paragraph_length_native(sec, para, ctrl, cell, cp)
                    .unwrap_or(0);
                let text = core
                    .get_text_in_cell_native(sec, para, ctrl, cell, cp, 0, length)
                    .unwrap_or_default();
                out.push((
                    format!("sec[{}].p[{}].tbl[{}].cell[{}].p[{}]", sec, para, ctrl, cell, cp),
                    text,
                ));
            }
            cell += 1;
        }
    }
    out
}

/// `get_document_info()` JSON에서 `sectionCount`를 읽는다.
fn section_count(core: &DocumentCore) -> Result<u32, String> {
    let info: serde_json::Value = serde_json::from_str(&core.get_document_info())
        .map_err(|e| format!("문서 정보 파싱 실패: {}", e))?;
    info.get("sectionCount")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .ok_or_else(|| "문서 정보에 sectionCount가 없습니다".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank_core() -> DocumentCore {
        let mut core = DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        core
    }

    /// 섹션 0에 `n`개 문단(각 `chars_each`자)을 가진 문서를 만든다.
    fn doc_with_paragraphs(n: usize, chars_each: usize) -> DocumentCore {
        let mut core = blank_core();
        let text: String = "가".repeat(chars_each);
        for i in 0..n {
            core.insert_text_native(0, i, 0, &text).unwrap();
            if i + 1 < n {
                let len = core.get_paragraph_length_native(0, i).unwrap();
                core.split_paragraph_native(0, i, len).unwrap();
            }
        }
        core
    }

    #[test]
    fn serializes_blank_document_with_path_ids() {
        let core = blank_core();
        let (context, whitelist) = build_windowed_context(&core, None, false).unwrap();

        assert!(context.document_metadata.total_sections >= 1);
        // 빈 문서도 최소 한 문단을 가지며 ID가 부여되어야 한다.
        assert!(!context.content.is_empty());
        let first_id = context.content[0].id();
        assert_eq!(first_id, "sec[0].p[0]");
        assert!(whitelist.contains("sec[0].p[0]"));
        assert_eq!(whitelist.len(), context.content.len());
    }

    #[test]
    fn serializes_inserted_text() {
        let mut core = blank_core();
        core.insert_text_native(0, 0, 0, "추진 배경").unwrap();

        let (context, whitelist) = build_windowed_context(&core, None, false).unwrap();
        let ContentNode::Paragraph { id, text } = &context.content[0];
        assert_eq!(id, "sec[0].p[0]");
        assert_eq!(text, "추진 배경");
        assert!(whitelist.contains("sec[0].p[0]"));
    }

    #[test]
    fn whitelist_matches_every_serialized_id() {
        let mut core = blank_core();
        core.insert_text_native(0, 0, 0, "첫 문단").unwrap();
        core.split_paragraph_native(0, 0, core.get_paragraph_length_native(0, 0).unwrap())
            .unwrap();

        let (context, whitelist) = build_windowed_context(&core, None, false).unwrap();
        for node in &context.content {
            assert!(
                whitelist.contains(node.id()),
                "화이트리스트에 {} 누락",
                node.id()
            );
        }
        assert_eq!(whitelist.len(), context.content.len());
    }

    #[test]
    fn parses_table_controls_from_layout_json() {
        let json = r#"{"controls":[
            {"type":"table","secIdx":0,"paraIdx":2,"controlIdx":0,"cells":[]},
            {"type":"image","secIdx":0,"paraIdx":3,"controlIdx":0},
            {"type":"table","secIdx":1,"paraIdx":0,"controlIdx":1}
        ]}"#;
        assert_eq!(parse_table_controls(json), vec![(0, 2, 0), (1, 0, 1)]);
    }

    #[test]
    fn parse_table_controls_tolerates_non_table_and_garbage() {
        assert!(parse_table_controls("not json").is_empty());
        assert!(parse_table_controls("{}").is_empty());
        assert!(parse_table_controls(r#"{"controls":[{"type":"image"}]}"#).is_empty());
    }

    #[test]
    fn parse_cursor_path_handles_paragraph_paths_only() {
        assert_eq!(parse_cursor_path("sec[0].p[12]"), Some((0, 12)));
        assert_eq!(parse_cursor_path("sec[3].p[0]"), Some((3, 0)));
        assert_eq!(parse_cursor_path("p[1]"), None);
        assert_eq!(parse_cursor_path("sec[0].tbl[0]"), None);
        assert_eq!(parse_cursor_path("sec[x].p[1]"), None);
    }

    #[test]
    fn small_document_is_not_windowed() {
        let core = doc_with_paragraphs(3, 10); // 30자 — 임계치 미만
        let (context, whitelist) = build_windowed_context(&core, Some((0, 1)), false).unwrap();
        assert_eq!(context.content.len(), 3);
        assert_eq!(whitelist.len(), 3);
    }

    #[test]
    fn large_document_windows_around_cursor() {
        // 30문단 × 1100자 = 33,000자 → 임계치 초과 → 윈도잉.
        let core = doc_with_paragraphs(30, 1100);
        let (context, whitelist) = build_windowed_context(&core, Some((0, 15)), false).unwrap();

        // 커서 15 기준 앞 5 + 본인 + 뒤 5 = 11문단(p[10]..p[20]).
        assert_eq!(context.content.len(), 11);
        assert_eq!(context.content[0].id(), "sec[0].p[10]");
        assert_eq!(context.content[10].id(), "sec[0].p[20]");
        assert_eq!(whitelist.len(), 11);
        assert!(whitelist.contains("sec[0].p[15]"));
        assert!(!whitelist.contains("sec[0].p[0]"));
        assert_eq!(
            context.document_metadata.current_cursor_path.as_deref(),
            Some("sec[0].p[15]")
        );
    }

    #[test]
    fn selection_only_forces_windowing_under_threshold() {
        let core = doc_with_paragraphs(20, 10); // 200자 — 임계치 미만이지만 selection_only=true
        let (context, _) = build_windowed_context(&core, Some((0, 10)), true).unwrap();
        assert_eq!(context.content.len(), 11);
        assert_eq!(context.content[0].id(), "sec[0].p[5]");
    }
}
