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
use std::collections::{HashMap, HashSet};

/// 스펙 4장 Sliding Window 임계치 — 전체 글자 수가 이를 넘으면 커서 주변만 직렬화한다.
const WINDOW_CHAR_THRESHOLD: usize = 30_000;
/// 커서 기준 앞/뒤로 포함할 문단 수(앞 5 + 뒤 5).
const WINDOW_RADIUS: usize = 5;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DocumentMetadata {
    pub total_sections: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_cursor_path: Option<String>,
    /// 반복 양식(연구노트 폼 등)에서 복제 가능한 최상위 양식 표 목록(F-220afd, AC-facb58).
    /// AI가 새 항목을 추가할 때 새로 그리지 말고 이 중 하나를 clone_table로 복제하도록
    /// 한다. 비어 있으면 양식 표가 없는 일반 문서다.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub form_tables: Vec<FormTable>,
}

/// 복제 대상이 될 수 있는 최상위 양식 표 하나(AC-facb58).
/// `clone_from`(섹션/부모문단/controlIndex)으로 결정적으로 가리킬 수 있고, 셀별
/// (row,col) 좌표와 라벨↔입력 역할 힌트를 노출해 AI가 입력칸만 채우게 한다.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FormTable {
    pub section: u32,
    pub paragraph: u32,
    pub control_index: u32,
    pub rows: u32,
    pub cols: u32,
    pub cells: Vec<FormCell>,
}

/// 양식 표 한 셀의 좌표·역할·현재 내용.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FormCell {
    pub row: u32,
    pub col: u32,
    /// "label"(채워진 안내 칸 — 건드리지 말 것) | "input"(비어 있어 채울 입력칸).
    pub role: String,
    /// 현재 셀 내용(라벨 칸 식별·중복 방지용). 입력칸이면 보통 빈 문자열.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub text: String,
}

/// 직렬화된 콘텐츠 노드. `type` 태그로 종류를 구분한다(스펙 2장 JSON 포맷).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentNode {
    Paragraph {
        id: String,
        text: String,
        /// 휴리스틱으로 추정한 제목 수준(1~3). rhwp가 문단 스타일을 노출하지 않아
        /// 글자 크기·굵기(레이아웃 런)·번호 패턴으로 추정한다. 확신 없으면 None —
        /// LLM이 목차 생성·장별 요약의 구조 근거로 쓴다(F-0858f2).
        #[serde(skip_serializing_if = "Option::is_none")]
        heading: Option<u8>,
    },
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
    let headings = detect_headings(&paragraphs, &collect_body_font_info(core));
    let total_chars: usize = paragraphs.iter().map(|(_, _, text)| text.chars().count()).sum();
    let cursor_path = cursor.map(|(sec, para)| format!("sec[{}].p[{}]", sec, para));

    let windowed = selection_only || total_chars > WINDOW_CHAR_THRESHOLD;
    let body: Vec<Node> = if !windowed {
        paragraphs.iter().map(|p| body_node(p, &headings)).collect()
    } else {
        // 커서를 찾지 못하면 문서 앞쪽(0번)을 기준으로 윈도우를 잡는다.
        let anchor = cursor
            .and_then(|(sec, para)| paragraphs.iter().position(|(s, p, _)| *s == sec && *p == para))
            .unwrap_or(0);
        let start = anchor.saturating_sub(WINDOW_RADIUS);
        let end = (anchor + WINDOW_RADIUS + 1).min(paragraphs.len());
        paragraphs[start..end].iter().map(|p| body_node(p, &headings)).collect()
    };

    // 표 셀(중첩 포함, 스펙 2장)·머리말/꼬리말·각주는 본문 윈도우와 무관하게 항상 포함한다.
    let mut nodes = body;
    nodes.extend(cell_nodes(core));
    nodes.extend(collect_header_footers(core, total_sections));
    nodes.extend(collect_footnotes(core));
    nodes.extend(collect_fields(core));

    Ok(assemble(nodes, total_sections, cursor_path, collect_form_tables(core)))
}

/// 직렬화 노드: (id, text, 추정 헤딩 수준).
type Node = (String, String, Option<u8>);

fn body_node(p: &Paragraph, headings: &HashMap<(usize, usize), u8>) -> Node {
    (
        format!("sec[{}].p[{}]", p.0, p.1),
        p.2.clone(),
        headings.get(&(p.0, p.1)).copied(),
    )
}

/// 표 셀 노드(헤딩 없음).
fn cell_nodes(core: &DocumentCore) -> Vec<Node> {
    collect_cells(core).into_iter().map(|(id, text)| (id, text, None)).collect()
}

/// 머리말/꼬리말 문단을 `sec[S].header|footer[A].p[I]` 노드로 수집한다(A=적용 대상
/// 0=양쪽/1=짝수/2=홀수). 해당 종류가 하나도 없으면 양쪽(0) 자리에 빈 placeholder를
/// 넣어 AI가 REPLACE로 새로 만들 수 있게 한다(F-191fd6 — 화이트리스트에 있어야
/// 편집 대상이 될 수 있다).
fn collect_header_footers(core: &DocumentCore, total_sections: u32) -> Vec<Node> {
    let mut out = Vec::new();
    for sec in 0..total_sections as usize {
        for (is_header, kind) in [(true, "header"), (false, "footer")] {
            let mut any = false;
            for apply in 0u8..=2 {
                let Ok(json) = core.get_header_footer_native(sec, is_header, apply) else {
                    continue;
                };
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) else { continue };
                if v.get("exists").and_then(|e| e.as_bool()) != Some(true) {
                    continue;
                }
                any = true;
                let text = v.get("text").and_then(|t| t.as_str()).unwrap_or("");
                // 문단은 줄바꿈을 포함할 수 없으므로 '\n' 분리가 곧 문단 경계다.
                for (i, para) in text.split('\n').enumerate() {
                    out.push((
                        format!("sec[{}].{}[{}].p[{}]", sec, kind, apply, i),
                        para.to_string(),
                        None,
                    ));
                }
            }
            if !any {
                out.push((format!("sec[{}].{}[0].p[0]", sec, kind), String::new(), None));
            }
        }
    }
    out
}

/// 본문 각주를 `sec[S].p[P].fn[C].p[I]` 노드로 수집한다. 페이지별 각주 목록을
/// 인덱스 프로브(범위 초과 시 Err)로 발견하고 본문 소속(body)만 직렬화한다.
fn collect_footnotes(core: &DocumentCore) -> Vec<Node> {
    let mut out = Vec::new();
    let mut seen: HashSet<(usize, usize, usize)> = HashSet::new();
    for page in 0..core.page_count() {
        let mut idx = 0usize;
        while let Ok(json) = core.get_page_footnote_info_native(page, idx) {
            idx += 1;
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) else { continue };
            if v.get("sourceType").and_then(|s| s.as_str()) != Some("body") {
                continue; // 표/글상자 안 각주는 컨트롤 인덱스 해석이 달라 제외.
            }
            let (Some(sec), Some(para), Some(ctrl)) = (
                v.get("sectionIdx").and_then(|x| x.as_u64()),
                v.get("paraIdx").and_then(|x| x.as_u64()),
                v.get("controlIdx").and_then(|x| x.as_u64()),
            ) else {
                continue;
            };
            let key = (sec as usize, para as usize, ctrl as usize);
            if !seen.insert(key) {
                continue;
            }
            let Ok(info) = core.get_footnote_info_native(key.0, key.1, key.2) else { continue };
            let Ok(iv) = serde_json::from_str::<serde_json::Value>(&info) else { continue };
            let Some(texts) = iv.get("texts").and_then(|t| t.as_array()) else { continue };
            for (i, t) in texts.iter().enumerate() {
                out.push((
                    format!("sec[{}].p[{}].fn[{}].p[{}]", key.0, key.1, key.2, i),
                    t.as_str().unwrap_or("").to_string(),
                    None,
                ));
            }
        }
    }
    out
}

/// 누름틀(Field)을 `field[<id>:<이름>]` 노드로 수집한다(F-10a6a5 — 템플릿 채우기).
/// 값이 비어 있으면 안내문을 `(안내: …)`로 보여 AI가 무엇을 채울지 알게 한다.
fn collect_fields(core: &DocumentCore) -> Vec<Node> {
    field_nodes_from_json(&core.get_field_list_json())
}

/// getFieldList JSON 배열 → 노드 변환(테스트 가능하게 분리).
fn field_nodes_from_json(json: &str) -> Vec<Node> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    let Some(fields) = value.as_array() else { return Vec::new() };
    let mut out = Vec::new();
    for field in fields {
        let Some(id) = field.get("fieldId").and_then(|v| v.as_u64()) else { continue };
        let name = field.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let value_text = field.get("value").and_then(|v| v.as_str()).unwrap_or("");
        let guide = field.get("guide").and_then(|v| v.as_str()).unwrap_or("");
        let text = if value_text.trim().is_empty() {
            if guide.trim().is_empty() {
                String::new()
            } else {
                format!("(안내: {})", guide.trim())
            }
        } else {
            value_text.to_string()
        };
        out.push((format!("field[{}:{}]", id, name), text, None));
    }
    out
}

/// 전체 문서(본문 전부 + 표 셀) 컨텍스트 — 교정 패스 등 전수 스캔용(Sliding Window 없음).
/// 긴 문서는 호출 측(프런트)이 노드를 구간으로 나눠 `target_ids`로 스코프 요청한다.
pub fn build_full_context(
    core: &DocumentCore,
) -> Result<(DocumentContext, HashSet<String>), String> {
    let (paragraphs, total_sections) = collect_paragraphs(core)?;
    let headings = detect_headings(&paragraphs, &collect_body_font_info(core));
    let mut nodes: Vec<Node> = paragraphs.iter().map(|p| body_node(p, &headings)).collect();
    nodes.extend(cell_nodes(core));
    nodes.extend(collect_header_footers(core, total_sections));
    nodes.extend(collect_footnotes(core));
    nodes.extend(collect_fields(core));
    Ok(assemble(nodes, total_sections, None, collect_form_tables(core)))
}

/// 지정한 ID들만 직렬화한다(구간 교정 등 스코프 요청용). 화이트리스트도 같은 ID들로
/// 좁혀지므로 LLM은 구간 밖 문단을 편집 대상으로 삼을 수 없다(스펙 7장과 일관).
pub fn build_scoped_context(
    core: &DocumentCore,
    ids: &HashSet<String>,
) -> Result<(DocumentContext, HashSet<String>), String> {
    let (paragraphs, total_sections) = collect_paragraphs(core)?;
    let headings = detect_headings(&paragraphs, &collect_body_font_info(core));
    let mut nodes: Vec<Node> = paragraphs.iter().map(|p| body_node(p, &headings)).collect();
    nodes.extend(cell_nodes(core));
    nodes.extend(collect_header_footers(core, total_sections));
    nodes.extend(collect_footnotes(core));
    nodes.extend(collect_fields(core));
    nodes.retain(|(id, _, _)| ids.contains(id));
    Ok(assemble(nodes, total_sections, None, collect_form_tables(core)))
}

/// `sec[<s>].p[<p>]` 형식의 커서 경로를 `(section, paragraph)`로 파싱한다.
/// 문단 경로가 아니면(예: 표 셀) `None`.
pub fn parse_cursor_path(path: &str) -> Option<(usize, usize)> {
    let rest = path.strip_prefix("sec[")?;
    let (sec, rest) = rest.split_once("].p[")?;
    let para = rest.strip_suffix(']')?;
    Some((sec.parse().ok()?, para.parse().ok()?))
}

/// 첨부용: 문서의 모든 텍스트(본문 + 표/중첩 셀)를 읽기 순서로 이어붙인다.
/// LLM 컨텍스트(편집 대상)와 달리 ID 없이 평문만 필요할 때 쓴다.
pub fn extract_all_text(core: &DocumentCore) -> Result<String, String> {
    let (paragraphs, _) = collect_paragraphs(core)?;
    let mut lines: Vec<String> = paragraphs
        .into_iter()
        .map(|(_, _, text)| text)
        .filter(|t| !t.trim().is_empty())
        .collect();
    for (_, text) in collect_cells(core) {
        if !text.trim().is_empty() {
            lines.push(text);
        }
    }
    Ok(lines.join("\n"))
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

/// `(id, text, heading)` 노드 목록으로 `DocumentContext` + 화이트리스트를 조립한다.
fn assemble(
    nodes: Vec<Node>,
    total_sections: u32,
    cursor_path: Option<String>,
    form_tables: Vec<FormTable>,
) -> (DocumentContext, HashSet<String>) {
    let mut content = Vec::with_capacity(nodes.len());
    let mut whitelist = HashSet::with_capacity(nodes.len());

    for (id, text, heading) in nodes {
        whitelist.insert(id.clone());
        content.push(ContentNode::Paragraph { id, text, heading });
    }

    // 양식 표 식별자도 화이트리스트에 넣어 clone_table.clone_from 좌표 환각을 막는다
    // (AC-facb58). 형식: `formtable:sec[S].p[P].tbl[C]`.
    for ft in &form_tables {
        whitelist.insert(form_table_token(ft.section, ft.paragraph, ft.control_index));
    }

    let context = DocumentContext {
        document_metadata: DocumentMetadata {
            total_sections,
            current_cursor_path: cursor_path,
            form_tables,
        },
        content,
    };
    (context, whitelist)
}

/// clone_table.clone_from 좌표의 화이트리스트 토큰(AC-facb58).
pub fn form_table_token(section: u32, paragraph: u32, control_index: u32) -> String {
    format!("formtable:sec[{}].p[{}].tbl[{}]", section, paragraph, control_index)
}

/// 본문 문단별 폰트 신호: (글자 수 가중 평균 크기, 과반 굵음 여부). 레이아웃 런에서
/// 수집한다 — rhwp가 문단 스타일을 노출하지 않아 렌더 런의 fontSize/bold를 쓴다.
/// 레이아웃이 없으면(문서 미배치) 빈 맵 → 헤딩도 비활성(오분류 강제 금지, AC4).
fn collect_body_font_info(core: &DocumentCore) -> HashMap<(usize, usize), (f64, bool)> {
    struct Acc {
        weighted: f64,
        chars: f64,
        bold_chars: f64,
    }
    let mut acc: HashMap<(usize, usize), Acc> = HashMap::new();
    for page in 0..core.page_count() {
        let Ok(layout) = core.get_page_text_layout_native(page) else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&layout) else { continue };
        let Some(runs) = value.get("runs").and_then(|r| r.as_array()) else { continue };
        for run in runs {
            if run.get("cellPath").is_some() {
                continue; // 셀 런은 헤딩 후보가 아니다.
            }
            let (Some(sec), Some(para), Some(size)) = (
                run.get("secIdx").and_then(|v| v.as_u64()),
                run.get("paraIdx").and_then(|v| v.as_u64()),
                run.get("fontSize").and_then(|v| v.as_f64()),
            ) else {
                continue;
            };
            let chars = run
                .get("text")
                .and_then(|t| t.as_str())
                .map(|s| s.chars().filter(|c| !c.is_whitespace()).count())
                .unwrap_or(0) as f64;
            if chars == 0.0 || size <= 0.0 {
                continue;
            }
            let bold = run.get("bold").and_then(|v| v.as_bool()).unwrap_or(false);
            let entry = acc
                .entry((sec as usize, para as usize))
                .or_insert(Acc { weighted: 0.0, chars: 0.0, bold_chars: 0.0 });
            entry.weighted += size * chars;
            entry.chars += chars;
            if bold {
                entry.bold_chars += chars;
            }
        }
    }
    acc.into_iter()
        .map(|(key, a)| (key, (a.weighted / a.chars, a.bold_chars * 2.0 >= a.chars)))
        .collect()
}

/// 헤딩 후보의 최대 길이(자). 제목은 짧다 — 이보다 길면 본문으로 본다.
const HEADING_MAX_CHARS: usize = 60;

/// 글자 크기·굵기·번호 패턴 휴리스틱으로 본문 문단의 헤딩 수준(1~3)을 추정한다.
///
/// 보수적 규칙(AC4 — 오분류 강제 금지): 폰트 신호(과반 굵음 또는 중앙값 대비 1.1배
/// 이상)가 있어야만 헤딩이다. 모든 문단이 같은 서식이면 신호가 없어 빈 결과가 된다.
/// 수준은 번호 패턴 깊이를 우선하고, 없으면 크기 비율로 정한다.
fn detect_headings(
    paragraphs: &[Paragraph],
    fonts: &HashMap<(usize, usize), (f64, bool)>,
) -> HashMap<(usize, usize), u8> {
    let mut sizes: Vec<f64> = paragraphs
        .iter()
        .filter(|(_, _, text)| !text.trim().is_empty())
        .filter_map(|(sec, para, _)| fonts.get(&(*sec, *para)).map(|(size, _)| *size))
        .collect();
    if sizes.is_empty() {
        return HashMap::new();
    }
    sizes.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = sizes[sizes.len() / 2];

    let mut out = HashMap::new();
    for (sec, para, text) in paragraphs {
        let trimmed = text.trim();
        if trimmed.is_empty() || trimmed.chars().count() > HEADING_MAX_CHARS {
            continue;
        }
        let Some((size, bold)) = fonts.get(&(*sec, *para)) else { continue };
        let ratio = if median > 0.0 { size / median } else { 1.0 };
        if !*bold && ratio < 1.1 {
            continue; // 폰트 신호 없음 — 번호 패턴만으로는 헤딩으로 단정하지 않는다.
        }
        let level = match numbering_depth(trimmed) {
            Some(depth) => depth,
            None if ratio >= 1.5 => 1,
            None if ratio >= 1.25 => 2,
            None => 3,
        };
        out.insert((*sec, *para), level.clamp(1, 3));
    }
    out
}

/// 번호 패턴의 깊이를 추정한다(없으면 None).
/// 1수준: "제1장/편/부", "Ⅰ." 등 로마숫자, "1. "  ·  2수준: "제1절/관", "1.1", "가."
/// 3수준: "1.1.1", "1)", "(1)".
fn numbering_depth(text: &str) -> Option<u8> {
    let t = text.trim_start();
    // 제N장(1) / 제N절(2)
    if let Some(rest) = t.strip_prefix('제') {
        let rest = rest.trim_start();
        let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits > 0 {
            let after = rest[digits..].trim_start();
            if after.starts_with('장') || after.starts_with('편') || after.starts_with('부') {
                return Some(1);
            }
            if after.starts_with('절') || after.starts_with('관') {
                return Some(2);
            }
        }
    }
    // 로마 숫자(Ⅰ~Ⅻ, U+2160~) → 1수준
    if let Some(first) = t.chars().next() {
        if ('\u{2160}'..='\u{216B}').contains(&first) {
            return Some(1);
        }
    }
    // 가./나./… → 2수준
    let mut chars = t.chars();
    if let (Some(first), Some('.')) = (chars.next(), chars.next()) {
        if matches!(
            first,
            '가' | '나' | '다' | '라' | '마' | '바' | '사' | '아' | '자' | '차' | '카' | '타' | '파' | '하'
        ) {
            return Some(2);
        }
    }
    // (1) → 3수준
    if let Some(rest) = t.strip_prefix('(') {
        let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits > 0 && rest[digits..].starts_with(')') {
            return Some(3);
        }
    }
    // "1." / "1.1" / "1.1.1" / "1)" — 숫자 그룹을 점으로 이어 센다.
    dotted_number_depth(t)
}

/// `1.` `1.1` `1.1.1` `1)` 패턴의 그룹 수(최대 3). 연도("1979년")나 소수("1.5억")처럼
/// 구분자 뒤에 본문이 바로 붙는 경우는 번호로 보지 않는다.
fn dotted_number_depth(t: &str) -> Option<u8> {
    let mut rest = t;
    let mut depth: u8 = 0;
    let mut separators = 0usize;
    let mut trailing_separator = false;
    let mut paren = false;
    loop {
        let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
        if digits == 0 {
            break;
        }
        depth += 1;
        rest = &rest[digits..];
        if let Some(r) = rest.strip_prefix('.') {
            rest = r;
            separators += 1;
            trailing_separator = true;
        } else if let Some(r) = rest.strip_prefix(')') {
            rest = r;
            separators += 1;
            trailing_separator = true;
            paren = true;
            break;
        } else {
            trailing_separator = false;
            break;
        }
    }
    if depth == 0 || separators == 0 {
        return None; // "1979년" — 구분자 없는 순수 숫자.
    }
    // "1)"은 한국 문서에서 보통 3수준 목록 번호다(1. → 가. → 1)).
    if paren && depth == 1 {
        return Some(3);
    }
    // 번호 뒤에는 공백/끝이 와야 한다("1.5억"의 '억'처럼 본문이 붙으면 소수다).
    let next_ok = match rest.chars().next() {
        None => true,
        Some(c) => c.is_whitespace(),
    };
    if !next_ok && !trailing_separator {
        return None;
    }
    if !next_ok && trailing_separator {
        // "1.제목"처럼 점 직후 글자가 붙은 경우 — 한국 문서에서 흔한 "1.개요" 형태는 허용.
        if rest.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            return None;
        }
    }
    Some(depth.min(3))
}

/// 텍스트 레이아웃 JSON(`get_page_text_layout_native`)에서 표 셀(중첩 포함) 문단을
/// `(id, text)`로 추출·병합한다. 셀 ID: `sec[S].p[PP]` + 경로 단계마다
/// `.tbl[C].cell[K].p[CP]`(중첩 표는 단계가 반복된다). 한 문단의 여러 run은 이어붙인다.
///
/// 본문(셀 밖) 텍스트는 `collect_paragraphs`(모델 경로)가 담당하므로 여기선 제외한다.
fn parse_cell_runs(text_layout_json: &str) -> Vec<(String, String)> {
    let value: serde_json::Value = match serde_json::from_str(text_layout_json) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let runs = match value.get("runs").and_then(|r| r.as_array()) {
        Some(runs) => runs,
        None => return Vec::new(),
    };

    let mut order: Vec<String> = Vec::new();
    let mut by_id: HashMap<String, String> = HashMap::new();
    for run in runs {
        let path = match run.get("cellPath").and_then(|p| p.as_array()) {
            Some(path) if !path.is_empty() => path,
            _ => continue,
        };
        let sec = run.get("secIdx").and_then(|v| v.as_u64()).unwrap_or(0);
        let parent_para = match run.get("parentParaIdx").and_then(|v| v.as_u64()) {
            Some(value) => value,
            None => continue,
        };

        let mut id = format!("sec[{}].p[{}]", sec, parent_para);
        let mut path_ok = true;
        for entry in path {
            match (
                entry.get("controlIndex").and_then(|v| v.as_u64()),
                entry.get("cellIndex").and_then(|v| v.as_u64()),
                entry.get("cellParaIndex").and_then(|v| v.as_u64()),
            ) {
                (Some(c), Some(k), Some(cp)) => {
                    id.push_str(&format!(".tbl[{}].cell[{}].p[{}]", c, k, cp));
                }
                _ => {
                    path_ok = false;
                    break;
                }
            }
        }
        if !path_ok {
            continue;
        }

        let text = run.get("text").and_then(|t| t.as_str()).unwrap_or("");
        match by_id.get_mut(&id) {
            Some(existing) => existing.push_str(text),
            None => {
                by_id.insert(id.clone(), text.to_string());
                order.push(id);
            }
        }
    }

    order
        .into_iter()
        .map(|id| {
            let text = by_id.remove(&id).unwrap_or_default();
            (id, text)
        })
        .collect()
}

/// 모든 페이지의 표 셀(중첩 포함)을 직렬화한다(스펙 2장). 다중 페이지에 걸친 셀
/// 문단은 이어붙인다.
fn collect_cells(core: &DocumentCore) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    for page in 0..core.page_count() {
        let layout = match core.get_page_text_layout_native(page) {
            Ok(layout) => layout,
            Err(_) => continue,
        };
        for (id, text) in parse_cell_runs(&layout) {
            match index.get(&id) {
                Some(&pos) => out[pos].1.push_str(&text),
                None => {
                    index.insert(id.clone(), out.len());
                    out.push((id, text));
                }
            }
        }
    }
    out
}

/// 최상위(본문 직속) 양식 표를 수집한다(AC-facb58). 렌더 컨트롤 레이아웃에서
/// 표 식별자(섹션/부모문단/controlIndex)와 셀 (row,col)·역할(label↔input)을 모은다.
///
/// 역할 추정(휴리스틱): 내용이 있는 셀은 `label`, 비어 있는 셀은 `input`. 라벨칸 오른쪽
/// 또는 아래에 빈 입력칸이 인접하는 전형적 폼 구조를 AI가 읽고 입력칸만 채우게 한다.
/// 중첩 표(셀 안의 표)는 복제 대상에서 제외한다 — 복제 단위는 최상위 표다.
fn collect_form_tables(core: &DocumentCore) -> Vec<FormTable> {
    // 셀 텍스트는 (parentParaIdx, controlIdx, cellIdx) → 합쳐진 텍스트로 모은다.
    let mut cell_text: HashMap<(u64, u64, u64), String> = HashMap::new();
    for page in 0..core.page_count() {
        let Ok(layout) = core.get_page_text_layout_native(page) else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&layout) else { continue };
        let Some(runs) = value.get("runs").and_then(|r| r.as_array()) else { continue };
        for run in runs {
            // 최상위 셀만(중첩이면 cellPath 길이>1) — path 첫 단계가 곧 최상위 표.
            let path = run.get("cellPath").and_then(|p| p.as_array());
            let nested = path.map(|p| p.len() > 1).unwrap_or(false);
            if nested {
                continue;
            }
            let (Some(pp), Some(ci), Some(cell)) = (
                run.get("parentParaIdx").and_then(|v| v.as_u64()),
                run.get("controlIdx").and_then(|v| v.as_u64()),
                run.get("cellIdx").and_then(|v| v.as_u64()),
            ) else {
                continue;
            };
            let text = run.get("text").and_then(|t| t.as_str()).unwrap_or("");
            cell_text.entry((pp, ci, cell)).or_default().push_str(text);
        }
    }

    // 컨트롤 레이아웃에서 표 구조(행/열/셀 좌표)를 모은다.
    let mut tables: Vec<FormTable> = Vec::new();
    let mut seen: HashSet<(u64, u64, u64)> = HashSet::new();
    for page in 0..core.page_count() {
        let Ok(layout) = core.get_page_control_layout_native(page) else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&layout) else { continue };
        let Some(controls) = value.get("controls").and_then(|c| c.as_array()) else { continue };
        for ctrl in controls {
            if ctrl.get("type").and_then(|t| t.as_str()) != Some("table") {
                continue;
            }
            let (Some(sec), Some(pp), Some(ci)) = (
                ctrl.get("secIdx").and_then(|v| v.as_u64()),
                ctrl.get("paraIdx").and_then(|v| v.as_u64()),
                ctrl.get("controlIdx").and_then(|v| v.as_u64()),
            ) else {
                continue; // 본문 직속이 아닌(중첩) 표는 좌표가 없어 제외된다.
            };
            // 페이지 분할 표가 여러 페이지에 나오면 한 번만.
            if !seen.insert((sec, pp, ci)) {
                continue;
            }
            let rows = ctrl.get("rowCount").and_then(|v| v.as_u64()).unwrap_or(0);
            let cols = ctrl.get("colCount").and_then(|v| v.as_u64()).unwrap_or(0);
            let Some(cell_arr) = ctrl.get("cells").and_then(|c| c.as_array()) else { continue };
            let mut cells: Vec<FormCell> = Vec::new();
            for cell in cell_arr {
                let (Some(row), Some(col)) = (
                    cell.get("row").and_then(|v| v.as_u64()),
                    cell.get("col").and_then(|v| v.as_u64()),
                ) else {
                    continue;
                };
                let cell_idx = cell.get("cellIdx").and_then(|v| v.as_u64()).unwrap_or(0);
                // cellIdx는 렌더 자식 인덱스 — 텍스트 맵은 model_cell_index 기반이 아니라
                // (pp,ci,cellIdx) 셀 단위로 모았으므로 동일 표의 셀 인덱스로 매칭한다.
                let text = cell_text
                    .get(&(pp, ci, cell_idx))
                    .cloned()
                    .unwrap_or_default();
                let role = if text.trim().is_empty() { "input" } else { "label" };
                cells.push(FormCell {
                    row: row as u32,
                    col: col as u32,
                    role: role.to_string(),
                    text: text.trim().to_string(),
                });
            }
            // 양식 표 판정: 채움 상태(has_label/has_input)에 의존하지 않는다 [F-220afd AC-facb58].
            // 가장 흔한 케이스(이미 다 채워진 기존 항목을 복제)에서도 표가 복제 소스로 노출돼야
            // 하므로 '빈 입력칸 존재'를 요구하지 않는다. 대신 구조적 판정으로 진짜 항목 표(다행
            // 그리드)는 노출하되 1행짜리 장식 박스는 거른다 — rows >= 2를 임계로 둔다(over-surface는
            // 허용: AI가 셀 내용으로 소스를 고르고 시스템 프롬프트가 clone-not-compose를 강제한다).
            // role("label"/"input")은 cells에 정보성 힌트로만 남는다(노출 게이트 아님).
            if rows >= 2 && cols >= 1 {
                cells.sort_by(|a, b| (a.row, a.col).cmp(&(b.row, b.col)));
                tables.push(FormTable {
                    section: sec as u32,
                    paragraph: pp as u32,
                    control_index: ci as u32,
                    rows: rows as u32,
                    cols: cols as u32,
                    cells,
                });
            }
        }
    }
    tables.sort_by(|a, b| {
        (a.section, a.paragraph, a.control_index).cmp(&(b.section, b.paragraph, b.control_index))
    });
    tables
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
        let ContentNode::Paragraph { id, text, .. } = &context.content[0];
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
    fn extract_all_text_joins_body_paragraphs() {
        let core = doc_with_paragraphs(3, 4);
        let text = extract_all_text(&core).unwrap();
        // 3문단 × "가가가가" → 줄바꿈으로 이어진다.
        assert_eq!(text.lines().count(), 3);
        assert!(text.contains("가가가가"));
    }

    #[test]
    fn parses_top_level_and_nested_cell_runs_with_paths() {
        // 본문 run(cellPath 없음)은 제외, 셀 run만 경로 ID로 병합한다.
        let json = r#"{"runs":[
            {"text":"제목","secIdx":0,"paraIdx":0},
            {"text":"525,","secIdx":0,"parentParaIdx":0,"cellPath":[
                {"controlIndex":2,"cellIndex":0,"cellParaIndex":4},
                {"controlIndex":0,"cellIndex":11,"cellParaIndex":0}]},
            {"text":"000,000","secIdx":0,"parentParaIdx":0,"cellPath":[
                {"controlIndex":2,"cellIndex":0,"cellParaIndex":4},
                {"controlIndex":0,"cellIndex":11,"cellParaIndex":0}]},
            {"text":"머리","secIdx":0,"parentParaIdx":0,"cellPath":[
                {"controlIndex":2,"cellIndex":0,"cellParaIndex":0}]}
        ]}"#;
        let cells = parse_cell_runs(json);
        assert_eq!(
            cells,
            vec![
                (
                    "sec[0].p[0].tbl[2].cell[0].p[4].tbl[0].cell[11].p[0]".to_string(),
                    "525,000,000".to_string(),
                ),
                ("sec[0].p[0].tbl[2].cell[0].p[0]".to_string(), "머리".to_string()),
            ]
        );
    }

    #[test]
    fn parse_cell_runs_tolerates_garbage_and_bodyonly() {
        assert!(parse_cell_runs("not json").is_empty());
        assert!(parse_cell_runs("{}").is_empty());
        // 본문 run만 있으면(cellPath 없음) 빈 결과.
        assert!(parse_cell_runs(r#"{"runs":[{"text":"x","secIdx":0,"paraIdx":1}]}"#).is_empty());
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
        // 본문 3 + 머리말/꼬리말 placeholder 2.
        assert_eq!(context.content.len(), 5);
        assert_eq!(whitelist.len(), 5);
    }

    #[test]
    fn large_document_windows_around_cursor() {
        // 30문단 × 1100자 = 33,000자 → 임계치 초과 → 윈도잉.
        let core = doc_with_paragraphs(30, 1100);
        let (context, whitelist) = build_windowed_context(&core, Some((0, 15)), false).unwrap();

        // 커서 15 기준 앞 5 + 본인 + 뒤 5 = 11문단(p[10]..p[20]) + hf placeholder 2.
        assert_eq!(context.content.len(), 13);
        assert_eq!(context.content[0].id(), "sec[0].p[10]");
        assert_eq!(context.content[10].id(), "sec[0].p[20]");
        assert_eq!(whitelist.len(), 13);
        assert!(whitelist.contains("sec[0].p[15]"));
        assert!(!whitelist.contains("sec[0].p[0]"));
        assert_eq!(
            context.document_metadata.current_cursor_path.as_deref(),
            Some("sec[0].p[15]")
        );
    }

    #[test]
    fn numbering_depth_recognizes_korean_patterns() {
        assert_eq!(numbering_depth("제1장 총칙"), Some(1));
        assert_eq!(numbering_depth("제 2 절 정의"), Some(2));
        assert_eq!(numbering_depth("Ⅲ. 추진 체계"), Some(1));
        assert_eq!(numbering_depth("1. 서론"), Some(1));
        assert_eq!(numbering_depth("1.1 연구 배경"), Some(2));
        assert_eq!(numbering_depth("2.3.1 세부 과제"), Some(3));
        assert_eq!(numbering_depth("가. 사업 개요"), Some(2));
        assert_eq!(numbering_depth("1) 첫째 항목"), Some(3));
        assert_eq!(numbering_depth("(1) 첫째"), Some(3));
        assert_eq!(numbering_depth("1.개요"), Some(1)); // 점 직후 글자(흔한 표기)
    }

    #[test]
    fn numbering_depth_rejects_years_and_decimals() {
        assert_eq!(numbering_depth("1979년에 설립되었다"), None);
        assert_eq!(numbering_depth("1.5억 원 규모"), None);
        assert_eq!(numbering_depth("총 525,000,000원"), None);
        assert_eq!(numbering_depth("일반 본문 문장이다."), None);
    }

    /// (sec, para) → (size, bold) 폰트 맵을 만든다.
    fn fonts(entries: &[(usize, f64, bool)]) -> HashMap<(usize, usize), (f64, bool)> {
        entries.iter().map(|(p, size, bold)| ((0, *p), (*size, *bold))).collect()
    }

    fn paras(texts: &[&str]) -> Vec<Paragraph> {
        texts.iter().enumerate().map(|(i, t)| (0, i, t.to_string())).collect()
    }

    #[test]
    fn detect_headings_uses_font_size_bold_and_numbering() {
        let paragraphs = paras(&[
            "사업 추진 계획",      // 큰 글씨 → h1
            "1. 추진 배경",        // 굵음 + 번호 → h1
            "본문 설명 문장이 이어진다. 충분히 평범한 크기다.",
            "1.1 세부 현황",       // 굵음 + 번호 깊이 2 → h2
            "또 다른 본문 문장.",
        ]);
        let font_map = fonts(&[
            (0, 18.0, true),
            (1, 14.0, true),
            (2, 10.0, false),
            (3, 11.0, true),
            (4, 10.0, false),
        ]);
        let headings = detect_headings(&paragraphs, &font_map);
        assert_eq!(headings.get(&(0, 0)), Some(&1)); // 크기 1.8배 → h1
        assert_eq!(headings.get(&(0, 1)), Some(&1)); // 번호 깊이 1
        assert_eq!(headings.get(&(0, 3)), Some(&2)); // 번호 깊이 2
        assert!(!headings.contains_key(&(0, 2)));
        assert!(!headings.contains_key(&(0, 4)));
    }

    #[test]
    fn detect_headings_yields_nothing_for_uniform_formatting() {
        // 모든 문단이 같은 크기·비굵음이면(번호 패턴이 있어도) 헤딩을 강제하지 않는다(AC4).
        let paragraphs = paras(&["1. 항목 하나", "2. 항목 둘", "일반 문장"]);
        let font_map = fonts(&[(0, 10.0, false), (1, 10.0, false), (2, 10.0, false)]);
        assert!(detect_headings(&paragraphs, &font_map).is_empty());
        // 폰트 정보 자체가 없으면(레이아웃 미배치) 역시 빈 결과.
        assert!(detect_headings(&paragraphs, &HashMap::new()).is_empty());
    }

    #[test]
    fn detect_headings_ignores_long_paragraphs() {
        let long = "아주 긴 문단 ".repeat(10); // 60자 초과 — 굵어도 제목이 아니다.
        let paragraphs = paras(&[&long, "본문"]);
        let font_map = fonts(&[(0, 14.0, true), (1, 10.0, false)]);
        assert!(detect_headings(&paragraphs, &font_map).is_empty());
    }

    #[test]
    fn heading_field_serializes_only_when_present() {
        let node = ContentNode::Paragraph {
            id: "sec[0].p[0]".to_string(),
            text: "1. 서론".to_string(),
            heading: Some(1),
        };
        let json = serde_json::to_string(&node).unwrap();
        assert!(json.contains("\"heading\":1"));
        let plain = ContentNode::Paragraph {
            id: "sec[0].p[1]".to_string(),
            text: "본문".to_string(),
            heading: None,
        };
        assert!(!serde_json::to_string(&plain).unwrap().contains("heading"));
    }

    /// 글상자(textbox) 문단이 기존 셀 경로 파이프라인으로 직렬화·편집·저장되는지
    /// 검증한다(F-21a81b). 글상자 런은 layout_textbox_content가 cell_index=0인
    /// CellContext를 달아 주므로 표 셀과 같은 `sec[S].p[P].tbl[C].cell[0].p[I]` ID가 된다.
    #[test]
    fn textbox_text_serializes_and_edits_via_cell_path() {
        let mut core = blank_core();
        core.insert_text_native(0, 0, 0, "본문").unwrap();
        let result = core
            .create_shape_control_native(
                0, 0, 0, 8504, 8504, 0, 0, true, "Square", "textbox", false, false, &[],
            )
            .unwrap();
        let ctrl = serde_json::from_str::<serde_json::Value>(&result)
            .ok()
            .and_then(|v| v.get("controlIdx").and_then(|c| c.as_u64()))
            .unwrap() as usize;

        // 직렬화: 글상자 문단이 셀 경로 ID로 나타난다.
        let textbox_id = format!("sec[0].p[0].tbl[{}].cell[0].p[0]", ctrl);
        let (context, whitelist) = build_full_context(&core).unwrap();
        assert!(
            whitelist.contains(&textbox_id),
            "글상자 ID 직렬화 누락: {:?}",
            context.content.iter().map(|n| n.id().to_string()).collect::<Vec<_>>()
        );

        // 편집(REPLACE 흐름): 길이 조회 → 삭제 → 삽입 — 표 셀과 같은 flat API.
        core.insert_text_in_cell_native(0, 0, ctrl, 0, 0, 0, "임시").unwrap();
        let len = core.get_cell_paragraph_length_native(0, 0, ctrl, 0, 0).unwrap();
        assert_eq!(len, 2);
        core.delete_text_in_cell_native(0, 0, ctrl, 0, 0, 0, len).unwrap();
        core.insert_text_in_cell_native(0, 0, ctrl, 0, 0, 0, "글상자 내용").unwrap();

        let (context, _) = build_full_context(&core).unwrap();
        let node_text = context
            .content
            .iter()
            .find(|n| n.id() == textbox_id)
            .map(|n| match n {
                ContentNode::Paragraph { text, .. } => text.clone(),
            });
        assert_eq!(node_text.as_deref(), Some("글상자 내용"));

        // 저장 라운드트립: HWP로 내보낸 뒤 다시 파싱해도 글상자 텍스트가 유지된다(AC4 회귀 프록시).
        let bytes = core.export_hwp_native().unwrap();
        let reloaded = crate::state::editable_core_from_bytes(
            &bytes,
            "문서 파싱 실패",
            "편집 가능 문서 변환 실패",
        )
        .unwrap();
        let all_text = extract_all_text(&reloaded).unwrap();
        assert!(all_text.contains("글상자 내용"), "저장 후 글상자 텍스트 소실: {}", all_text);
    }

    /// [F-220afd DE-RISK] 양식 표 복제 프리미티브 검증.
    ///
    /// 연구노트 폼처럼 병합이 섞인 다행 표를 copyControl→pasteControl로 in-model
    /// 복제했을 때 (1) 복제본이 원본과 동일한 leaf-cell 집합(cellIdx→내용)을 갖고
    /// (2) hwp_table_fix 후처리를 포함해 저장·재파싱해도 원본·복제본 셀 내용이 모두
    /// 살아남는지 확인한다. 이 프리미티브가 충실하지 않으면 F-220afd 전체가 무의미하므로
    /// 본 기능 코드보다 먼저 이 게이트가 GREEN이어야 한다.
    ///
    /// 구조(행·열·병합) 동일성은 블랙박스로 검증한다: 모든 leaf 셀에 고유 마커를 채운 뒤
    /// get_page_text_layout_native의 cellIdx→text 매핑을 원본 표와 복제 표에서 각각
    /// 수집해 동일한지 비교한다(복제가 셀을 추가/누락/병합변경하면 매핑이 달라진다).
    #[test]
    fn clone_form_table_preserves_structure_and_roundtrips() {
        let mut core = blank_core();
        core.insert_text_native(0, 0, 0, "연구노트 폼").unwrap();

        // 4행×3열 폼: 맨 위 행은 (0,0)~(0,2) 가로 병합(제목 띠) — 실제 연구노트 폼의 머리.
        let result = core.create_table_native(0, 0, 0, 4, 3).unwrap();
        let v: serde_json::Value = serde_json::from_str(&result).unwrap();
        let ctrl = v.get("controlIdx").and_then(|c| c.as_u64()).unwrap() as usize;
        let tp = v.get("paraIdx").and_then(|c| c.as_u64()).unwrap() as usize;
        core.merge_table_cells_native(0, tp, ctrl, 0, 0, 0, 2).unwrap();

        // 병합 후 남은 모든 leaf 셀에 고유 마커(SRC0..)를 채운다.
        // cellIdx는 cells 배열 인덱스 — 병합으로 줄어든 실제 셀 수만큼 채운다.
        let mut idx = 0usize;
        loop {
            match core.insert_text_in_cell_native(0, tp, ctrl, idx, 0, 0, &format!("SRC{}", idx)) {
                Ok(_) => idx += 1,
                Err(_) => break,
            }
        }
        let leaf_count = idx;
        assert!(leaf_count > 0, "양식 표에 채울 셀이 없습니다");
        // 4행×3열에서 머리 한 줄(3셀)을 1셀로 병합 → 12-3+1 = 10 leaf 셀.
        assert_eq!(leaf_count, 10, "병합 후 leaf 셀 수 불일치: {}", leaf_count);

        // 원본 표의 cellIdx→text 매핑 수집.
        let src_map = collect_table_cell_map(&core, tp, ctrl);
        assert_eq!(src_map.len(), leaf_count, "원본 매핑 누락: {:?}", src_map);

        // 표를 클립보드로 복제 → 본문 맨 끝 빈 문단에 붙여넣기.
        let copy = core.copy_control_native(0, tp, ctrl).unwrap();
        assert!(copy.contains("[표]"), "표 복사 실패: {}", copy);
        let last_para = core.get_paragraph_count_native(0).unwrap().saturating_sub(1);
        let last_len = core.get_paragraph_length_native(0, last_para).unwrap();
        let paste = core.paste_control_native(0, last_para, last_len).unwrap();
        let pv: serde_json::Value = serde_json::from_str(&paste).unwrap();
        assert_eq!(pv.get("ok").and_then(|b| b.as_bool()), Some(true), "붙여넣기 실패: {}", paste);
        let dest_para = pv.get("paraIdx").and_then(|c| c.as_u64()).unwrap() as usize;
        let dest_ctrl = pv.get("controlIdx").and_then(|c| c.as_u64()).unwrap() as usize;

        // 복제 표의 cellIdx→text 매핑이 원본과 완전히 동일해야 한다(행·열·병합 보존).
        let clone_map = collect_table_cell_map(&core, dest_para, dest_ctrl);
        assert_eq!(
            clone_map, src_map,
            "복제 표 구조/내용 불일치\n원본: {:?}\n복제: {:?}",
            src_map, clone_map
        );

        // hwp_table_fix 후처리 포함 저장 → 재파싱해도 원본·복제 셀 내용이 모두 보존.
        let bytes = crate::hwp_table_fix::fix_table_headers(core.export_hwp_native().unwrap());
        let path = std::env::temp_dir().join("hop_ai_clone_form_table_check.hwp");
        std::fs::write(&path, &bytes).unwrap();
        let reloaded =
            crate::state::editable_core_from_bytes(&bytes, "파싱 실패", "변환 실패").unwrap();
        let round = extract_all_text(&reloaded).unwrap();
        for i in 0..leaf_count {
            // 복제이므로 SRC{i} 마커는 본문에 정확히 2번(원본+복제) 나타나야 한다.
            let occurrences = round.matches(&format!("SRC{}", i)).count();
            assert!(
                occurrences >= 2,
                "저장 후 SRC{} 마커가 원본+복제로 2번 나타나지 않음(={}): {}",
                i,
                occurrences,
                round
            );
        }
    }

    /// [F-220afd AC-facb58 de-risk 보조] collect_form_tables가 라벨↔입력 역할을
    /// 정확히 추정하는지(텍스트-레이아웃 cellIdx와 컨트롤-레이아웃 cellIdx 정합) 확인한다.
    /// 2열 폼: 0열=라벨(채움), 1열=입력(빈칸). 라벨 칸은 'label', 빈 칸은 'input'이어야 하고
    /// 표 식별자(섹션/부모문단/controlIndex)와 화이트리스트 토큰이 노출돼야 한다.
    #[test]
    fn collect_form_tables_exposes_identity_and_roles() {
        let mut core = blank_core();
        core.insert_text_native(0, 0, 0, "양식").unwrap();
        let result = core.create_table_native(0, 0, 0, 3, 2).unwrap();
        let v: serde_json::Value = serde_json::from_str(&result).unwrap();
        let ctrl = v.get("controlIdx").and_then(|c| c.as_u64()).unwrap() as usize;
        let tp = v.get("paraIdx").and_then(|c| c.as_u64()).unwrap() as usize;
        // 0열(짝수 cellIdx: 0,2,4)에 라벨, 1열(홀수)은 비워 둔다.
        let labels = ["사업명", "기관명", "기간"];
        for (r, label) in labels.iter().enumerate() {
            core.insert_text_in_cell_native(0, tp, ctrl, r * 2, 0, 0, label).unwrap();
        }

        let tables = collect_form_tables(&core);
        assert_eq!(tables.len(), 1, "양식 표 1개를 노출해야 함: {:?}", tables);
        let ft = &tables[0];
        assert_eq!((ft.section, ft.paragraph, ft.control_index), (0, tp as u32, ctrl as u32));
        assert_eq!((ft.rows, ft.cols), (3, 2));
        // 0열 셀은 label, 1열 셀은 input.
        for cell in &ft.cells {
            if cell.col == 0 {
                assert_eq!(cell.role, "label", "0열은 라벨이어야 함: {:?}", cell);
                assert!(!cell.text.is_empty());
            } else {
                assert_eq!(cell.role, "input", "1열은 입력칸이어야 함: {:?}", cell);
            }
        }
        // 라벨 텍스트가 올바른 행에 매핑됐는지(cellIdx 정합 확인).
        let label_at = |row: u32| {
            ft.cells
                .iter()
                .find(|c| c.row == row && c.col == 0)
                .map(|c| c.text.clone())
                .unwrap_or_default()
        };
        assert_eq!(label_at(0), "사업명");
        assert_eq!(label_at(1), "기관명");
        assert_eq!(label_at(2), "기간");

        // 컨텍스트·화이트리스트에 양식 표 식별자가 들어간다.
        let (context, whitelist) = build_full_context(&core).unwrap();
        assert_eq!(context.document_metadata.form_tables.len(), 1);
        assert!(whitelist.contains(&form_table_token(0, tp as u32, ctrl as u32)));
    }

    /// [F-220afd AC-facb58 회귀 가드] 완전히 채워진 기존 항목 표(빈 입력칸 없음)도
    /// 복제 소스로 노출되는지 검증한다.
    ///
    /// 연구노트 문서의 가장 흔한 케이스: 기존 항목은 제목/내용/기록자/날짜가 전부 채워져 있다.
    /// 옛 코드는 has_input(빈 셀 존재)를 게이트로 사용해 이 표들을 form_tables에서 제외했다 →
    /// AI는 복제 대상이 없어 compose 폴백 → 새로 그린 항목이 원본 6행×3열과 달라짐.
    /// 개선: 채움 상태와 무관하게 구조적 판정(rows >= 2 && cols >= 1)으로 노출해
    /// 완전히 채워진 기존 항목도 복제 소스로 쓸 수 있게 한다.
    #[test]
    fn fully_filled_entry_table_is_surfaced_as_clone_source() {
        let mut core = blank_core();
        core.insert_text_native(0, 0, 0, "연구노트 — 기존 항목").unwrap();
        
        // 실제 연구노트 폼과 유사한 구조: 3행×2열
        let result = core.create_table_native(0, 0, 0, 3, 2).unwrap();
        let v: serde_json::Value = serde_json::from_str(&result).unwrap();
        let ctrl = v.get("controlIdx").and_then(|c| c.as_u64()).unwrap() as usize;
        let tp = v.get("paraIdx").and_then(|c| c.as_u64()).unwrap() as usize;
        
        // 모든 6개 셀을 완전히 채운다 — 빈 입력칸이 없다.
        let cell_values = [
            "제목", "새로운 연구 주제 발굴",
            "내용", "기계학습 알고리즘 성능 비교",
            "기록자", "2026-06-15"
        ];
        for (idx, value) in cell_values.iter().enumerate() {
            core.insert_text_in_cell_native(0, tp, ctrl, idx, 0, 0, value).unwrap();
        }
        
        // 액션: collect_form_tables()를 호출 — 완전히 채워진 표가 노출돼야 함.
        let tables = collect_form_tables(&core);
        
        // 단언 1: 표가 노출되었다 (has_input 게이트 없음).
        assert_eq!(tables.len(), 1, "완전히 채워진 표가 복제 소스로 노출돼야 함: {:?}", tables);
        
        let ft = &tables[0];
        
        // 단언 2: 표 식별자가 정확하다 (섹션/부모문단/controlIndex).
        assert_eq!((ft.section, ft.paragraph, ft.control_index), (0, tp as u32, ctrl as u32),
            "표 식별자 불일치");
        
        // 단언 3: 표 차원이 정확하다 (rows × cols).
        assert_eq!((ft.rows, ft.cols), (3, 2), "표 차원 불일치");
        
        // 단언 4: 모든 셀이 노출되었다 (빈 셀 없음, 모두 text 포함).
        assert_eq!(ft.cells.len(), 6, "모든 셀(6)이 노출돼야 함: {:?}", ft.cells);
        for cell in &ft.cells {
            // 모든 셀이 텍스트를 포함해야 함 (fully filled).
            assert!(!cell.text.is_empty(), "셀({},{})이 텍스트를 포함해야 함: {:?}", cell.row, cell.col, cell);
            // role은 정보성 힌트 — 모두 "label"이지만, 역할이 표 노출을 결정하지 않는다.
            assert!(
                cell.role == "label" || cell.role == "input",
                "셀({},{}) role은 'label' 또는 'input'이어야 함: {:?}",
                cell.row, cell.col, cell
            );
        }
        
        // 단언 5: 몇몇 셀의 (row, col) + text 매핑이 올바른지 확인.
        let text_at = |row: u32, col: u32| {
            ft.cells
                .iter()
                .find(|c| c.row == row && c.col == col)
                .map(|c| c.text.clone())
                .unwrap_or_default()
        };
        // 0행 0열은 "제목", 0행 1열은 "새로운 연구 주제 발굴"
        assert_eq!(text_at(0, 0), "제목");
        assert_eq!(text_at(0, 1), "새로운 연구 주제 발굴");
        // 1행 0열은 "내용"
        assert_eq!(text_at(1, 0), "내용");
        
        // 단언 6: 컨텍스트·화이트리스트에 표 식별자가 포함된다.
        let (context, whitelist) = build_full_context(&core).unwrap();
        assert_eq!(context.document_metadata.form_tables.len(), 1, "컨텍스트 form_tables에 1개 표");
        let token = form_table_token(0, tp as u32, ctrl as u32);
        assert!(whitelist.contains(&token), "화이트리스트에 표 토큰({}) 포함", token);
    }
    /// 한 표(parent_para_idx, control_idx)의 leaf 셀 cellIdx→text 매핑을 렌더 레이아웃에서
    /// 수집한다. 비어있지 않은(텍스트가 채워진) 셀만 잡히므로 호출 전 모든 셀에 마커를 채운다.
    fn collect_table_cell_map(
        core: &DocumentCore,
        parent_para_idx: usize,
        control_idx: usize,
    ) -> std::collections::BTreeMap<u64, String> {
        use std::collections::BTreeMap;
        let mut map: BTreeMap<u64, String> = BTreeMap::new();
        for page in 0..core.page_count() {
            let layout = match core.get_page_text_layout_native(page) {
                Ok(l) => l,
                Err(_) => continue,
            };
            let parsed: serde_json::Value = match serde_json::from_str(&layout) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let runs = match parsed.get("runs").and_then(|r| r.as_array()) {
                Some(r) => r,
                None => continue,
            };
            for run in runs {
                let pp = run.get("parentParaIdx").and_then(|v| v.as_u64());
                let ci = run.get("controlIdx").and_then(|v| v.as_u64());
                if pp != Some(parent_para_idx as u64) || ci != Some(control_idx as u64) {
                    continue;
                }
                let cell_idx = match run.get("cellIdx").and_then(|v| v.as_u64()) {
                    Some(c) => c,
                    None => continue,
                };
                let text = run.get("text").and_then(|v| v.as_str()).unwrap_or("");
                map.entry(cell_idx).or_default().push_str(text);
            }
        }
        map
    }

    /// 표 셀 INSERT(flat split+insert — ai-apply path-1 경로)와 글상자 편집 후 저장한
    /// HWP가 구조 검증을 통과하는지 확인용 파일을 만든다. hwp_table_check.py가 이
    /// 파일에서 exit 0이어야 한다(표 변경 검증 게이트).
    #[test]
    fn export_cell_split_doc_for_table_check() {
        let mut core = blank_core();
        core.insert_text_native(0, 0, 0, "본문").unwrap();
        // 표 2×2 생성 + 셀 채우기 + 셀 문단 분할(INSERT_AFTER의 flat 경로) 후 삽입.
        let result = core.create_table_native(0, 0, 0, 2, 2).unwrap();
        let ctrl = serde_json::from_str::<serde_json::Value>(&result)
            .ok()
            .and_then(|v| v.get("controlIdx").and_then(|c| c.as_u64()))
            .unwrap() as usize;
        let table_para = serde_json::from_str::<serde_json::Value>(&result)
            .ok()
            .and_then(|v| v.get("paraIdx").and_then(|c| c.as_u64()))
            .unwrap() as usize;
        core.insert_text_in_cell_native(0, table_para, ctrl, 0, 0, 0, "첫 셀").unwrap();
        let len = core.get_cell_paragraph_length_native(0, table_para, ctrl, 0, 0).unwrap();
        core.split_paragraph_in_cell_native(0, table_para, ctrl, 0, 0, len).unwrap();
        core.insert_text_in_cell_native(0, table_para, ctrl, 0, 1, 0, "둘째 문단").unwrap();
        // 글상자도 하나 만들어 편집(F-21a81b 경로).
        let shape = core
            .create_shape_control_native(
                0, table_para, 0, 8504, 8504, 0, 0, true, "Square", "textbox", false, false, &[],
            )
            .unwrap();
        let shape_ctrl = serde_json::from_str::<serde_json::Value>(&shape)
            .ok()
            .and_then(|v| v.get("controlIdx").and_then(|c| c.as_u64()))
            .unwrap() as usize;
        core.insert_text_in_cell_native(0, table_para, shape_ctrl, 0, 0, 0, "글상자 문구")
            .unwrap();

        // 실제 저장 경로(commit_staged_hwp_save)처럼 표 CTRL_HEADER 후처리까지 적용한다.
        let bytes = crate::hwp_table_fix::fix_table_headers(core.export_hwp_native().unwrap());
        let path = std::env::temp_dir().join("hop_ai_cell_split_check.hwp");
        std::fs::write(&path, &bytes).unwrap();
        // 재파싱으로 1차 검증(외부 스크립트는 별도 게이트로 실행).
        let reloaded = crate::state::editable_core_from_bytes(&bytes, "파싱 실패", "변환 실패").unwrap();
        let text = extract_all_text(&reloaded).unwrap();
        assert!(text.contains("첫 셀") && text.contains("둘째 문단") && text.contains("글상자 문구"));
    }

    /// 표 구조 편집(F-7a3dbe): 행/열 추가·삭제·병합이 셀 내용을 보존하고(AC1·AC2),
    /// 기존 병합과 부분 겹치는 병합은 거부되며(AC4), 저장 파일이 구조 검증을 통과한다(AC3).
    /// hwp_table_check.py가 내보낸 파일에서 exit 0이어야 한다.
    #[test]
    fn table_structure_edits_preserve_cells_and_roundtrip() {
        let mut core = blank_core();
        core.insert_text_native(0, 0, 0, "본문").unwrap();
        let result = core.create_table_native(0, 0, 0, 2, 2).unwrap();
        let v: serde_json::Value = serde_json::from_str(&result).unwrap();
        let ctrl = v.get("controlIdx").and_then(|c| c.as_u64()).unwrap() as usize;
        let tp = v.get("paraIdx").and_then(|c| c.as_u64()).unwrap() as usize;
        for (idx, text) in ["값0", "값1", "값2", "값3"].iter().enumerate() {
            core.insert_text_in_cell_native(0, tp, ctrl, idx, 0, 0, text).unwrap();
        }

        // 행 추가(0행 아래) → 그 행 삭제 → 열 추가(1열 오른쪽) → 새 열 세로 병합.
        core.insert_table_row_native(0, tp, ctrl, 0, true).unwrap();
        core.delete_table_row_native(0, tp, ctrl, 1).unwrap();
        core.insert_table_column_native(0, tp, ctrl, 1, true).unwrap();
        core.merge_table_cells_native(0, tp, ctrl, 0, 2, 1, 2).unwrap();

        // 기존 병합(0,2)-(1,2)과 부분 겹치는 병합은 거부된다(AC4) — 문서 무변경.
        assert!(core.merge_table_cells_native(0, tp, ctrl, 1, 1, 1, 2).is_err());

        // 구조 편집 후에도 기존 셀 내용이 모두 남아 있다(AC1).
        let text = extract_all_text(&core).unwrap();
        for value in ["값0", "값1", "값2", "값3"] {
            assert!(text.contains(value), "셀 내용 소실: {} not in {}", value, text);
        }

        // 실제 저장 경로(표 CTRL_HEADER 후처리 포함)로 내보내 검증 파일을 만든다(AC3 게이트).
        let bytes = crate::hwp_table_fix::fix_table_headers(core.export_hwp_native().unwrap());
        let path = std::env::temp_dir().join("hop_ai_table_struct_check.hwp");
        std::fs::write(&path, &bytes).unwrap();
        let reloaded =
            crate::state::editable_core_from_bytes(&bytes, "파싱 실패", "변환 실패").unwrap();
        let round = extract_all_text(&reloaded).unwrap();
        for value in ["값0", "값1", "값2", "값3"] {
            assert!(round.contains(value), "저장 후 셀 내용 소실: {}", value);
        }
    }

    /// 머리말/꼬리말(F-191fd6): placeholder 직렬화(없을 때) → 생성·편집 → 저장
    /// 라운드트립까지 검증한다.
    #[test]
    fn header_footer_serializes_edits_and_roundtrips() {
        let mut core = blank_core();
        core.insert_text_native(0, 0, 0, "본문").unwrap();

        // 머리말/꼬리말이 없으면 placeholder가 화이트리스트에 들어간다(AI가 생성 가능).
        let (_, whitelist) = build_full_context(&core).unwrap();
        assert!(whitelist.contains("sec[0].header[0].p[0]"));
        assert!(whitelist.contains("sec[0].footer[0].p[0]"));

        // 생성 + 텍스트 입력 → 직렬화에 실제 텍스트가 나온다.
        core.create_header_footer_native(0, true, 0).unwrap();
        core.insert_text_in_header_footer_native(0, true, 0, 0, 0, "회사 기밀").unwrap();
        let (context, _) = build_full_context(&core).unwrap();
        let header_text = context
            .content
            .iter()
            .find(|n| n.id() == "sec[0].header[0].p[0]")
            .map(|n| match n {
                ContentNode::Paragraph { text, .. } => text.clone(),
            });
        assert_eq!(header_text.as_deref(), Some("회사 기밀"));

        // REPLACE 흐름(삭제 후 삽입) → 저장 후 재파싱해도 유지된다(AC4 회귀 프록시).
        core.delete_text_in_header_footer_native(0, true, 0, 0, 0, 5).unwrap();
        core.insert_text_in_header_footer_native(0, true, 0, 0, 0, "대외비 문서").unwrap();
        let bytes = core.export_hwp_native().unwrap();
        let reloaded =
            crate::state::editable_core_from_bytes(&bytes, "파싱 실패", "변환 실패").unwrap();
        let json = reloaded.get_header_footer_native(0, true, 0).unwrap();
        assert!(json.contains("대외비 문서"), "저장 후 머리말 소실: {}", json);
    }

    /// 각주(F-191fd6): 본문 각주가 `sec[S].p[P].fn[C].p[I]`로 직렬화되고 편집·저장된다.
    #[test]
    fn footnote_serializes_edits_and_roundtrips() {
        let mut core = blank_core();
        core.insert_text_native(0, 0, 0, "각주가 달린 문장").unwrap();
        let result = core.insert_footnote_native(0, 0, 8).unwrap();
        let ctrl = serde_json::from_str::<serde_json::Value>(&result)
            .ok()
            .and_then(|v| v.get("controlIdx").and_then(|c| c.as_u64()))
            .unwrap() as usize;
        core.insert_text_in_footnote_native(0, 0, ctrl, 0, 0, "출처: 2026 통계연보").unwrap();

        let id = format!("sec[0].p[0].fn[{}].p[0]", ctrl);
        let (context, whitelist) = build_full_context(&core).unwrap();
        assert!(whitelist.contains(&id), "각주 ID 직렬화 누락");
        let fn_text = context.content.iter().find(|n| n.id() == id).map(|n| match n {
            ContentNode::Paragraph { text, .. } => text.clone(),
        });
        // 각주 문단 끝에 자동번호 자리 공백이 붙을 수 있어 starts_with로 본다.
        assert!(fn_text.as_deref().unwrap_or("").starts_with("출처: 2026 통계연보"), "{:?}", fn_text);

        // 저장 라운드트립.
        let bytes = core.export_hwp_native().unwrap();
        let reloaded =
            crate::state::editable_core_from_bytes(&bytes, "파싱 실패", "변환 실패").unwrap();
        let info = reloaded.get_footnote_info_native(0, 0, ctrl).unwrap();
        assert!(info.contains("출처"), "저장 후 각주 소실: {}", info);
    }

    #[test]
    fn field_nodes_show_value_or_guide() {
        let json = r#"[
            {"fieldId":3,"fieldType":"ClickHere","name":"사업명","guide":"사업명을 입력하세요","command":"","value":""},
            {"fieldId":7,"fieldType":"ClickHere","name":"기관","guide":"","command":"","value":"지금강(주)"}
        ]"#;
        let nodes = field_nodes_from_json(json);
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].0, "field[3:사업명]");
        assert_eq!(nodes[0].1, "(안내: 사업명을 입력하세요)"); // 빈 누름틀은 안내문 표시.
        assert_eq!(nodes[1].0, "field[7:기관]");
        assert_eq!(nodes[1].1, "지금강(주)"); // 채워진 누름틀은 현재값.
        assert!(field_nodes_from_json("garbage").is_empty());
    }

    #[test]
    fn full_context_ignores_window_threshold() {
        // 33,000자(임계치 초과)여도 전체 컨텍스트는 모든 문단을 직렬화한다.
        let core = doc_with_paragraphs(30, 1100);
        let (context, whitelist) = build_full_context(&core).unwrap();
        // 본문 30 + hf placeholder 2.
        assert_eq!(context.content.len(), 32);
        assert_eq!(whitelist.len(), 32);
        assert!(whitelist.contains("sec[0].p[0]"));
        assert!(whitelist.contains("sec[0].p[29]"));
    }

    #[test]
    fn scoped_context_serializes_only_requested_ids() {
        let core = doc_with_paragraphs(10, 10);
        let ids: HashSet<String> =
            ["sec[0].p[2]", "sec[0].p[5]"].iter().map(|s| s.to_string()).collect();
        let (context, whitelist) = build_scoped_context(&core, &ids).unwrap();
        assert_eq!(context.content.len(), 2);
        assert_eq!(context.content[0].id(), "sec[0].p[2]");
        assert_eq!(context.content[1].id(), "sec[0].p[5]");
        assert_eq!(whitelist, ids);
    }

    #[test]
    fn selection_only_forces_windowing_under_threshold() {
        let core = doc_with_paragraphs(20, 10); // 200자 — 임계치 미만이지만 selection_only=true
        let (context, _) = build_windowed_context(&core, Some((0, 10)), true).unwrap();
        // 윈도우 11문단 + hf placeholder 2.
        assert_eq!(context.content.len(), 13);
        assert_eq!(context.content[0].id(), "sec[0].p[5]");
    }
}

#[cfg(test)]
mod spacing_probe {
    /// 단위 계약 고정: applyParaFormat의 spacingBefore/After는 ParaShape에 그대로
    /// 쓰이는데, HWP 포맷은 간격을 'HWPUNIT의 2배 스케일'로 저장한다(렌더러가 /2).
    /// 즉 화면의 Npt = 값 N×200. 조회 API(getParaPropertiesAt)는 raw를 px로만 바꿔
    /// 보여주므로(/2 없음) 600 → 8px로 읽히지만 실제 렌더링은 그 절반(3pt)이다.
    /// ai-apply PARA_STYLES는 SPACING_PT=200 곱으로 이 계약을 따른다.
    #[test]
    fn para_spacing_unit_contract_hwpunit() {
        let mut core = rhwp::DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        core.insert_text_native(0, 0, 0, "본문 문단").unwrap();
        core.apply_para_format_native(
            0,
            0,
            r#"{"lineSpacingType":"Percent","lineSpacing":180,"spacingAfter":600,"spacingBefore":1200}"#,
        )
        .unwrap();
        let props = core.get_para_properties_at_native(0, 0).unwrap();
        let v: serde_json::Value = serde_json::from_str(&props).unwrap();
        assert_eq!(v["lineSpacing"].as_f64(), Some(180.0));
        // 조회 경로(raw→px): 600 → 8px, 1200 → 16px. 렌더링은 /2라 각각 3pt/6pt.
        assert!((v["spacingAfter"].as_f64().unwrap() - 8.0).abs() < 0.5, "{}", props);
        assert!((v["spacingBefore"].as_f64().unwrap() - 16.0).abs() < 0.5, "{}", props);
    }

    /// [진단용 임시] HOP_HWP 파일의 문단별 줄간격/문단간격 덤프.
    #[test]
    #[ignore]
    fn dump_para_spacing() {
        let path = std::env::var("HOP_HWP").unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let core = crate::state::editable_core_from_bytes(&bytes, "파싱 실패", "변환 실패").unwrap();
        let n = core.get_paragraph_count_native(0).unwrap();
        for p in 0..n.min(60) {
            let len = core.get_paragraph_length_native(0, p).unwrap();
            let text = core.get_text_range_native(0, p, 0, len.min(28)).unwrap();
            let props = core.get_para_properties_at_native(0, p).unwrap();
            let v: serde_json::Value = serde_json::from_str(&props).unwrap_or_default();
            eprintln!(
                "p[{:2}] ls={:?}/{:?} before={:?} after={:?} | {}",
                p,
                v.get("lineSpacingType"),
                v.get("lineSpacing"),
                v.get("spacingBefore"),
                v.get("spacingAfter"),
                text.replace('\n', " ")
            );
        }
    }
}

#[cfg(test)]
mod lineseg_probe {
    /// [진단] 다중 페이지 문서를 만들어 저장 → 저장된 줄 위치(vpos)가 페이지 상대인지
    /// 구역 누적인지 확인용 파일을 만든다. scripts/hwp_lineseg_dump.py로 검사.
    #[test]
    #[ignore]
    fn export_multipage_doc_for_lineseg_check() {
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
            // 생성 파이프라인과 동일하게 body 스타일(줄간격 180% + 아래 6pt)도 입힌다.
            core.apply_para_format_native(
                0,
                i + 1,
                r#"{"lineSpacingType":"Percent","lineSpacing":180,"spacingAfter":600}"#,
            )
            .unwrap();
        }
        core.reflow_linesegs_on_demand();
        eprintln!("page_count={}", core.page_count());
        let bytes = core.export_hwp_native().unwrap();
        let path = std::env::temp_dir().join("hop_lineseg_multipage.hwp");
        std::fs::write(&path, &bytes).unwrap();
        eprintln!("saved: {}", path.display());
    }
}
