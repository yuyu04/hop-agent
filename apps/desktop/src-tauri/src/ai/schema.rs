//! LLM이 반환하는 Action Script의 데이터 모델과 파싱·검증.
//!
//! (스펙 3장) LLM은 자연어 설명 없이 아래 스키마를 만족하는 Raw JSON만 반환한다.
//! Rust 측은 serde로 역직렬화하고, 모든 `target_id`가 직렬화 시점의 화이트리스트에
//! 속하는지 검증한다(스펙 2·7장).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

/// Action Script가 지정하는 편집 명령.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EditCommand {
    InsertBefore,
    InsertAfter,
    Replace,
    Delete,
}

/// 표 편집용 payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableData {
    pub rows: u32,
    pub cols: u32,
    pub matrix: Vec<Vec<String>>,
    /// 병합할 셀 영역들(선택). 헤더 병합·세로 병합 등에 쓴다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub merges: Vec<MergeSpec>,
    /// 열별 상대 폭 가중치(선택, 길이=cols). 긴 텍스트 열은 크게, ○/× 같은 짧은
    /// 열은 작게 지정하면 표가 세로로 덜 늘어나 여러 쪽으로 쪼개지는 것을 줄인다.
    /// 예: [3,3,2,2,8] → 마지막(비고) 열이 가장 넓다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub col_weights: Vec<u32>,
}

/// 기존 표의 구조 편집 스펙(행/열 추가·삭제, 셀 병합). target_id는 그 표의 셀 ID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableEditSpec {
    /// "insert_row" | "insert_col" | "delete_row" | "delete_col" | "merge_cells" | "split_cell"
    pub op: String,
    /// 기준 행(0-기준). insert_row/delete_row에서 사용.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<u32>,
    /// 기준 열(0-기준). insert_col/delete_col에서 사용.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub col: Option<u32>,
    /// insert_row: 기준 행 아래에 넣을지(기본 true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub below: Option<bool>,
    /// insert_col: 기준 열 오른쪽에 넣을지(기본 true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<bool>,
    /// merge_cells: 병합 범위(0-기준, 끝 포함).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge: Option<MergeSpec>,
    /// split_cell: 셀을 몇 줄로 나눌지(생략 시 1). F-6daa56b3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub into_rows: Option<u32>,
    /// split_cell: 셀을 몇 칸으로 나눌지(생략 시 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub into_cols: Option<u32>,
    /// split_cell: 나뉜 줄 높이를 균등하게(생략 시 true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equal_row_height: Option<bool>,
    /// split_cell: 주면 이 범위 안의 셀들을 각각 into_rows×into_cols로 분할한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<MergeSpec>,
    /// insert_row/insert_col: 새 행/열의 셀 텍스트(왼→오 / 위→아래 순, 선택).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub texts: Vec<String>,
}

/// 복제할 원본 양식 표의 식별자(섹션/부모문단/컨트롤 인덱스).
/// serialize가 화이트리스트·컨텍스트에 노출한 양식 표 좌표를 그대로 참조한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloneSource {
    pub section: u32,
    pub paragraph: u32,
    pub control_index: u32,
}

/// 복제된 표의 한 입력칸 채우기 항목((row,col) → text). text는 `\n`을 포함할 수 있고
/// F-466f8e 다줄 셀 경로로 채워진다. 라벨칸은 채우지 않으면 원본 그대로 보존된다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CellFill {
    pub row: u32,
    pub col: u32,
    pub text: String,
}

/// type="clone_table"일 때: 기존 양식 표를 in-model 복제하고 입력칸만 채운다.
/// 새로 표를 그리지(compose) 않으므로 행·열·병합·테두리가 원본과 100% 동일하다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloneTableSpec {
    /// 복제할 원본 양식 표의 식별자.
    pub clone_from: CloneSource,
    /// 복제 후 채울 입력칸들(라벨칸은 생략 → 원본 보존).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cell_fills: Vec<CellFill>,
}

/// 차트 시리즈 하나(payload.type="chart").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChartSeries {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// labels와 같은 길이의 숫자 값들.
    pub values: Vec<f64>,
}

impl Eq for ChartSeries {}

/// 데이터 → 차트 이미지 생성 스펙. 프런트가 캔버스로 PNG 렌더 후 그림으로 삽입한다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChartData {
    /// "bar" | "line" | "pie"
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 가로축(범주) 라벨들.
    pub labels: Vec<String>,
    /// 시리즈 목록(pie는 1개만).
    pub series: Vec<ChartSeries>,
}

impl Eq for ChartData {}

/// 런 단위 부분 서식 스펙(payload.type="format"). 텍스트 내용은 바꾸지 않는다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CharFormatSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strikethrough: Option<bool>,
    /// 글자 크기(pt). 적용 시 HWPUNIT(pt×100)으로 변환된다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size_pt: Option<u32>,
    /// 글자 색 "#RRGGBB".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
}

/// 문서 전역 찾아 바꾸기 스펙(payload.type="replace_text", F-293e8c99).
///
/// 문단마다 REPLACE 편집을 나열하는 대신 rhwp의 전역 치환 프리미티브를 한 번 부른다 —
/// 100군데를 고칠 때 edit 100개 대신 1개면 된다(토큰·누락·승인 UI 문제 해소).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplaceTextSpec {
    /// 찾을 문자열(비어 있으면 적용하지 않고 사유를 보고한다).
    pub query: String,
    /// 바꿀 문자열(빈 문자열이면 삭제).
    pub new_text: String,
    /// 대소문자 구분(생략 시 false).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case_sensitive: Option<bool>,
    /// "all"(기본, 전부) | "first"(첫 건만).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// 표 셀 계산식 스펙(payload.type="table_formula", F-8eb1f86f).
///
/// AI가 암산한 숫자를 글자로 넣는 대신 rhwp 표 계산 엔진이 값을 구해 셀에 기입한다.
/// 주의: row/col은 0-기준 정수(다른 표 편집과 동일)지만, formula 안의 셀 참조는 A1 표기다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableFormulaSpec {
    /// 결과를 쓸 셀의 행(0-기준).
    pub row: u32,
    /// 결과를 쓸 셀의 열(0-기준).
    pub col: u32,
    /// 계산식. 예: "=SUM(B2:B5)", "=A1+B2*3". 셀 참조는 A1 표기를 쓴다.
    pub formula: String,
}

/// 각주 달기/떼기 스펙(payload.type="footnote", F-3e2d0f9a).
///
/// 삽입: 본문 문단 ID + command=REPLACE (본문 내용은 그대로, 각주만 추가).
/// 삭제: 각주 ID + command=DELETE (각주 자체를 표식까지 제거).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FootnoteSpec {
    /// 삽입할 각주 내용. 삭제에는 필요 없다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 삽입 위치: 이 문자열 바로 뒤에 각주 표식을 단다(생략 시 문단 끝).
    /// 문단 안에서 유일해야 한다 — 여러 번 나오면 적용하지 않는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_text: Option<String>,
}

/// HTML 붙여넣기 스펙(payload.type="paste_html", F-4f6d826e).
///
/// 웹/워드에서 가져온 내용을 순수 텍스트로 풀어 쓰는 대신 서식(굵기·목록·표)을 유지한 채
/// 반입한다. rhwp가 HTML을 파싱해 문단·런으로 만든다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PasteHtmlSpec {
    /// 붙여넣을 HTML 조각. 비어 있으면 적용하지 않고 사유를 보고한다.
    pub html: String,
}

/// 이미지 크롭 영역(0~1 비율).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CropSpec {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Eq for CropSpec {}

/// 표 셀 병합 영역(0-기준 행/열 범위, 끝 포함).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeSpec {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

/// 편집 대상에 적용할 내용.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditPayload {
    /// 객체 종류("paragraph" | "table"). DELETE 명령에서는 생략될 수 있다.
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    /// type="image"일 때 삽입할 첨부 이미지의 0-기준 인덱스.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_index: Option<u32>,
    /// 이미지에서 잘라낼 영역(0~1 비율). PDF 페이지 렌더에서 그림만 잘라낼 때 쓴다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<CropSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_data: Option<TableData>,
    /// type="table_edit"일 때: 기존 표의 구조 편집(행/열 추가·삭제, 셀 병합).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_edit: Option<TableEditSpec>,
    /// type="clone_table"일 때: 기존 양식 표를 그대로 복제하고 입력칸만 채운다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clone_table: Option<CloneTableSpec>,
    /// type="chart"일 때: 차트 데이터(프런트가 PNG로 렌더해 그림으로 삽입).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart_data: Option<ChartData>,
    /// type="format"일 때: 문단 안에서 서식을 바꿀 정확한 문자열(생략=문단 전체).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_target: Option<String>,
    /// type="format"일 때: 적용할 글자 서식(바꿀 속성만 지정).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub char_format: Option<CharFormatSpec>,
    /// type="replace_text"일 때: 문서 전역 찾아 바꾸기(target_id="doc").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_text: Option<ReplaceTextSpec>,
    /// type="table_formula"일 때: 표 셀 계산식(엔진이 계산해 셀에 기입).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_formula: Option<TableFormulaSpec>,
    /// type="footnote"일 때: 각주 달기(본문 문단 target) / 떼기(각주 target).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub footnote: Option<FootnoteSpec>,
    /// type="paste_html"일 때: HTML을 서식 유지한 채 붙여넣는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paste_html: Option<PasteHtmlSpec>,
    /// INSERT 시 참이면 새 페이지에서 시작(본문 문단에만 적용).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_break: Option<bool>,
    /// 다시쓰기 대안들(선택, 2~3개). 사용자가 여러 변형을 요청할 때 채운다.
    /// text에는 추천안(보통 variations[0])을 넣고, UI에서 다른 안을 고를 수 있다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variations: Vec<String>,
    /// 교정 패스에서 이 편집이 고치는 이슈 설명(예: "맞춤법: '됬다'→'됐다'").
    /// 일반 편집에서는 생략된다. mod.rs가 파싱 결과를 재직렬화해 프런트로 보내므로
    /// 여기 없는 필드는 떨어져 나간다 — 그래서 스키마에 명시한다(col_weights와 동일 이유).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 단일 편집 항목.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edit {
    pub command: EditCommand,
    /// 문서 호스트가 직렬화 시 부여한 고유 ID (예: `sec[0].p[1]`).
    pub target_id: String,
    pub payload: EditPayload,
}

/// LLM이 반환하는 최상위 구조.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionScript {
    pub edits: Vec<Edit>,
    /// 사용자에게 보여줄 대화형 요약(무엇을 했는지/못 했으면 이유). 한국어 1~3문장.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// LLM 응답 문자열을 `ActionScript`로 파싱한다.
///
/// provider가 네이티브 구조화 출력을 쓰면 순수 JSON이 오지만, 방어적으로
/// Markdown 코드펜스(```json ... ```)를 감싸 보낸 경우도 벗겨낸다.
pub fn parse_action_script(raw: &str) -> Result<ActionScript, String> {
    let cleaned = strip_code_fences(raw).trim();
    if cleaned.is_empty() {
        return Err(
            "빈 응답을 받았습니다 — 모델이 출력을 내지 않았습니다(다른 모델/Provider로 시도하세요)."
                .to_string(),
        );
    }
    // 1차: 정리된 전체를 그대로 파싱.
    if let Ok(script) = serde_json::from_str::<ActionScript>(cleaned) {
        return Ok(script);
    }
    // 2차: 설명 문장에 둘러싸인 경우 가장 바깥 `{...}`만 떼어 파싱(특히 CLI 응답).
    if let Some(braced) = extract_braced_object(cleaned) {
        if let Ok(script) = serde_json::from_str::<ActionScript>(braced) {
            return Ok(script);
        }
    }
    Err(format!(
        "Action Script JSON 파싱 실패. 받은 응답 일부: {}",
        preview(cleaned, 200)
    ))
}

/// 텍스트에서 첫 `{`부터 마지막 `}`까지(가장 바깥 객체 후보)를 잘라낸다.
fn extract_braced_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end > start {
        Some(&text[start..=end])
    } else {
        None
    }
}

/// 진단 메시지용 — 앞 `max_chars`자만, 길면 말줄임표.
fn preview(text: &str, max_chars: usize) -> String {
    let collected: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        format!("{}…", collected)
    } else {
        collected
    }
}

// ── 양식 이어쓰기(form_fill) 응답 스키마 (F-ae778890) ──────────────────────
//
// 핵심 원칙: 이 모드에서 AI는 표 구조를 절대 결정하지 않는다. 응답은 '항목 내용
// 리스트'뿐이며, 각 항목은 라벨→값 쌍의 집합이다. 표/compose/edit 액션을 일절
// 포함하지 않는다(AC-0cd01fc1). 앱이 항목마다 소스 양식 표를 결정적으로 복제하고
// (cloneTableAt) 라벨↔인접 값칸 매핑으로 값칸만 채운다(AC-6bdb1e17/AC-86e329eb).

/// 한 항목의 라벨→값 쌍 하나(예: {label:"제목", value:"실험 A 재현"}).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormFillField {
    /// 소스 양식 표의 라벨 셀 이름(예: 제목/연구내용/기록자/확인자/기록 일자).
    pub label: String,
    /// 그 라벨에 대응하는 값칸에 채울 내용(여러 줄이면 `\n` 포함 가능).
    pub value: String,
}

/// 새로 추가할 항목 하나 — 라벨→값 쌍의 집합. 표 구조 정보는 일절 없다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormFillEntry {
    pub fields: Vec<FormFillField>,
}

/// 양식 이어쓰기 응답(내용 전용). entries.len() = 추가할 항목 수 N. 표/compose 없음.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormFillResponse {
    pub entries: Vec<FormFillEntry>,
    /// 사용자에게 보여줄 요약(선택, 한국어 1~3문장).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 양식 이어쓰기 응답 문자열을 `FormFillResponse`로 파싱한다. action_script와 동일하게
/// 코드펜스/설명 문장 래핑을 방어적으로 벗겨낸다.
pub fn parse_form_fill_response(raw: &str) -> Result<FormFillResponse, String> {
    let cleaned = strip_code_fences(raw).trim();
    if cleaned.is_empty() {
        return Err("빈 응답을 받았습니다 — 모델이 항목 내용을 내지 않았습니다.".to_string());
    }
    if let Ok(resp) = serde_json::from_str::<FormFillResponse>(cleaned) {
        return Ok(resp);
    }
    if let Some(braced) = extract_braced_object(cleaned) {
        if let Ok(resp) = serde_json::from_str::<FormFillResponse>(braced) {
            return Ok(resp);
        }
    }
    Err(format!(
        "양식 이어쓰기 응답 JSON 파싱 실패. 받은 응답 일부: {}",
        preview(cleaned, 200)
    ))
}

/// provider에 주입할 양식 이어쓰기 출력 JSON Schema(F-ae778890). 표/compose 구조를
/// 일절 노출하지 않으므로 AI가 표를 그릴 여지가 없다(AC-0cd01fc1).
pub fn form_fill_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "사용자에게 보여줄 요약(무엇을 추가했는지). 한국어 1~3문장."
            },
            "entries": {
                "type": "array",
                "description": "추가할 항목들. 배열 길이가 곧 추가할 항목(표) 수다. 각 항목은 라벨→값 쌍의 집합이며, 표 구조는 절대 포함하지 않는다(앱이 기존 양식 표를 그대로 복제한다).",
                "items": {
                    "type": "object",
                    "properties": {
                        "fields": {
                            "type": "array",
                            "description": "그 항목의 라벨→값 쌍. label은 소스 양식의 필드 라벨(제목/연구내용/기록자 등), value는 그 칸에 넣을 내용(여러 줄이면 \\n).",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "label": { "type": "string" },
                                    "value": { "type": "string" }
                                },
                                "required": ["label", "value"]
                            }
                        }
                    },
                    "required": ["fields"]
                }
            }
        },
        "required": ["entries"]
    })
}

/// 화이트리스트에 없는 `target_id`(환각으로 간주) 목록을 반환한다. 빈 벡터면 통과.
pub fn collect_violations(script: &ActionScript, whitelist: &HashSet<String>) -> Vec<String> {
    script
        .edits
        .iter()
        .filter(|edit| !is_allowed_target(edit, whitelist))
        .map(|edit| edit.target_id.clone())
        .collect()
}

/// 문서 전체를 가리키는 target_id 토큰(전역 찾아 바꾸기 전용, F-293e8c99).
///
/// 구간 스코프 요청(serialize::build_scoped_context)에서는 화이트리스트에 넣지 않는다 —
/// 구간 밖까지 바꾸는 전역 치환은 스코프 위반이기 때문이다.
pub const DOC_SCOPE_TARGET: &str = "doc";

/// 이 편집의 target_id가 허용되는가. 문단/셀 ID는 화이트리스트 membership으로 판정하고,
/// 문서 스코프 토큰은 "화이트리스트에 있고 + 실제로 전역 치환 payload일 때"만 허용한다
/// (다른 payload가 "doc"을 target으로 잡는 환각을 막는다).
fn is_allowed_target(edit: &Edit, whitelist: &HashSet<String>) -> bool {
    if edit.target_id == DOC_SCOPE_TARGET {
        return whitelist.contains(DOC_SCOPE_TARGET) && edit.payload.replace_text.is_some();
    }
    whitelist.contains(&edit.target_id)
}

/// provider에 주입할 출력 JSON Schema(스펙 3장)를 생성한다.
pub fn action_script_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "사용자에게 보여줄 대화형 요약(무엇을 했는지, 못 했으면 이유). 한국어 1~3문장."
            },
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "enum": ["INSERT_BEFORE", "INSERT_AFTER", "REPLACE", "DELETE"]
                        },
                        "target_id": { "type": "string" },
                        "payload": {
                            "type": "object",
                            "properties": {
                                "type": { "type": "string", "enum": ["paragraph", "table", "image", "table_edit", "clone_table", "format", "chart", "replace_text", "table_formula", "footnote", "paste_html"] },
                                "text": { "type": "string" },
                                "style": {
                                    "type": "string",
                                    "enum": ["title", "heading", "subheading", "body", "caption", "quote", "emphasis"],
                                    "description": "문단의 의미 역할. 제목=title, 큰 제목=heading, 소제목=subheading, 본문=body, 그림/표 설명=caption, 인용=quote, 강조 한 줄=emphasis. 실제 글꼴 크기·정렬·간격은 앱이 일관되게 적용한다."
                                },
                                "image_index": {
                                    "type": "integer",
                                    "description": "type=\"image\"일 때 삽입할 첨부 이미지의 0-기준 인덱스(첨부된 순서)."
                                },
                                "crop": {
                                    "type": "object",
                                    "description": "이미지에서 잘라낼 영역(0~1 비율, 좌상단 기준). PDF 페이지 렌더에서 원하는 그림만 잘라낼 때 지정. 그림 전체면 생략.",
                                    "properties": {
                                        "x": { "type": "number" },
                                        "y": { "type": "number" },
                                        "w": { "type": "number" },
                                        "h": { "type": "number" }
                                    }
                                },
                                "page_break": {
                                    "type": "boolean",
                                    "description": "참이면 삽입한 문단을 새 페이지에서 시작한다(INSERT에만 유효)."
                                },
                                "variations": {
                                    "type": "array",
                                    "description": "다시쓰기 대안 2~3개(선택). 사용자가 여러 안을 원할 때만 채운다. text에는 추천안(보통 첫 번째)을 넣는다.",
                                    "items": { "type": "string" }
                                },
                                "reason": {
                                    "type": "string",
                                    "description": "교정 패스에서만: 이 편집이 고치는 이슈를 '분류: 설명' 형식 한국어 한 문장으로(분류는 맞춤법/문법/어색한 표현/일관성 중 하나). 일반 편집에서는 생략."
                                },
                                "chart_data": {
                                    "type": "object",
                                    "description": "type=\"chart\"일 때: 데이터로 차트 이미지를 만들어 본문에 삽입한다. command=INSERT_AFTER, target은 표 바깥 본문 문단 ID. 값은 반드시 숫자(단위·콤마 제거).",
                                    "properties": {
                                        "kind": { "type": "string", "enum": ["bar", "line", "pie"] },
                                        "title": { "type": "string" },
                                        "labels": { "type": "array", "items": { "type": "string" }, "description": "범주 라벨(가로축). pie면 조각 이름." },
                                        "series": {
                                            "type": "array",
                                            "description": "시리즈 목록(pie는 1개만). 각 values 길이는 labels와 같아야 한다.",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "name": { "type": "string" },
                                                    "values": { "type": "array", "items": { "type": "number" } }
                                                },
                                                "required": ["values"]
                                            }
                                        }
                                    },
                                    "required": ["kind", "labels", "series"]
                                },
                                "format_target": {
                                    "type": "string",
                                    "description": "type=\"format\"일 때: 그 문단 안에서 서식을 바꿀 정확한 문자열. 문단 전체면 생략. 문단 내에서 유일해야 한다(여러 번 나오면 적용되지 않음)."
                                },
                                "char_format": {
                                    "type": "object",
                                    "description": "type=\"format\"일 때: 적용할 글자 서식(바꿀 속성만). 텍스트 내용은 바뀌지 않는다(command=REPLACE, payload.text 불필요).",
                                    "properties": {
                                        "bold": { "type": "boolean" },
                                        "italic": { "type": "boolean" },
                                        "underline": { "type": "boolean" },
                                        "strikethrough": { "type": "boolean" },
                                        "font_size_pt": { "type": "integer", "description": "글자 크기(pt)" },
                                        "text_color": { "type": "string", "description": "글자 색 #RRGGBB" }
                                    }
                                },
                                "replace_text": {
                                    "type": "object",
                                    "description": "type=\"replace_text\"일 때: 문서 전체에서 찾아 바꾸기. 같은 문자열을 여러 문단에서 바꿀 때는 문단마다 REPLACE를 내지 말고 반드시 이걸 한 번 써라. command=REPLACE, target_id=\"doc\"(문서 전체를 뜻하는 고정값). 본문과 표 셀 안을 모두 바꾼다.",
                                    "properties": {
                                        "query": { "type": "string", "description": "찾을 문자열(정확히 일치). 비우면 적용되지 않는다." },
                                        "new_text": { "type": "string", "description": "바꿀 문자열. 빈 문자열이면 찾은 부분을 지운다." },
                                        "case_sensitive": { "type": "boolean", "description": "대소문자 구분(기본 false)" },
                                        "scope": { "type": "string", "enum": ["all", "first"], "description": "all=전부 바꾸기(기본), first=처음 한 건만" }
                                    },
                                    "required": ["query", "new_text"]
                                },
                                "paste_html": {
                                    "type": "object",
                                    "description": "type=\"paste_html\"일 때: HTML을 서식을 유지한 채 문서에 넣는다. 굵기·기울임·목록·표가 살아 있는 내용을 넣어야 할 때 쓴다(순수 텍스트면 그냥 payload.text를 쓰는 게 낫다). command=REPLACE면 그 문단 내용을 대신하고, INSERT_AFTER/INSERT_BEFORE면 새 문단을 만들어 거기에 넣는다. target_id는 본문 문단 ID 또는 최상위 표 셀 ID.",
                                    "properties": {
                                        "html": { "type": "string", "description": "붙여넣을 HTML 조각. 예: \"<p><b>제목</b></p><ul><li>항목</li></ul>\"" }
                                    },
                                    "required": ["html"]
                                },
                                "footnote": {
                                    "type": "object",
                                    "description": "type=\"footnote\"일 때: 각주를 달거나 뗀다. [달기] command=REPLACE, target_id는 각주를 달 본문 문단 ID, text에 각주 내용을 넣는다(문단 본문은 바뀌지 않는다). anchor_text를 주면 그 문자열 바로 뒤에 표식이 붙고, 생략하면 문단 끝에 붙는다. [떼기] command=DELETE, target_id는 각주 ID(sec[S].p[P].fn[C].p[I]) — 각주가 표식까지 사라진다. 각주 '내용만' 고칠 때는 payload.type 없이 그 각주 ID에 REPLACE 하면 된다.",
                                    "properties": {
                                        "text": { "type": "string", "description": "달 각주의 내용(달기에만 필요)" },
                                        "anchor_text": { "type": "string", "description": "이 문자열 바로 뒤에 각주 표식을 단다. 문단 안에서 유일해야 한다. 생략하면 문단 끝." }
                                    }
                                },
                                "table_formula": {
                                    "type": "object",
                                    "description": "type=\"table_formula\"일 때: 표의 값을 직접 계산해 셀에 적는다. 합계·평균·곱셈 같은 계산을 요청받으면 절대 직접 암산해서 숫자를 text로 넣지 말고 이걸 쓴다(원본 값이 바뀌어도 다시 계산할 수 있고 계산 실수가 없다). command=REPLACE, target_id는 그 표 안의 아무 셀 ID. 주의: row/col은 0-기준 정수지만 formula 안의 셀 참조는 A1 표기다(첫 행이 1, 첫 열이 A).",
                                    "properties": {
                                        "row": { "type": "integer", "description": "결과를 쓸 셀의 행(0-기준)" },
                                        "col": { "type": "integer", "description": "결과를 쓸 셀의 열(0-기준)" },
                                        "formula": { "type": "string", "description": "계산식. 예: \"=SUM(B2:B5)\", \"=A1+B2*3\". 셀 참조는 A1 표기." }
                                    },
                                    "required": ["row", "col", "formula"]
                                },
                                "table_edit": {
                                    "type": "object",
                                    "description": "type=\"table_edit\"일 때: 기존 표의 구조 편집. target_id는 그 표 안의 아무 셀 ID(예: sec[0].p[2].tbl[0].cell[0].p[0]). command는 REPLACE를 쓴다.",
                                    "properties": {
                                        "op": { "type": "string", "enum": ["insert_row", "insert_col", "delete_row", "delete_col", "merge_cells", "split_cell"] },
                                        "row": { "type": "integer", "description": "기준 행(0-기준) — insert_row/delete_row" },
                                        "col": { "type": "integer", "description": "기준 열(0-기준) — insert_col/delete_col" },
                                        "below": { "type": "boolean", "description": "insert_row: 기준 행 아래에 삽입(기본 true)" },
                                        "right": { "type": "boolean", "description": "insert_col: 기준 열 오른쪽에 삽입(기본 true)" },
                                        "merge": {
                                            "type": "object",
                                            "description": "merge_cells: 병합 범위(0-기준, 끝 포함)",
                                            "properties": {
                                                "start_row": { "type": "integer" },
                                                "start_col": { "type": "integer" },
                                                "end_row": { "type": "integer" },
                                                "end_col": { "type": "integer" }
                                            }
                                        },
                                        "texts": {
                                            "type": "array",
                                            "description": "insert_row/insert_col: 새 행/열에 채울 셀 텍스트(순서대로, 선택)",
                                            "items": { "type": "string" }
                                        },
                                        "into_rows": { "type": "integer", "description": "split_cell: 셀을 몇 줄로 나눌지(기본 1)" },
                                        "into_cols": { "type": "integer", "description": "split_cell: 셀을 몇 칸으로 나눌지(기본 1)" },
                                        "equal_row_height": { "type": "boolean", "description": "split_cell: 나뉜 줄 높이를 균등하게(기본 true)" },
                                        "range": {
                                            "type": "object",
                                            "description": "split_cell: 주면 이 범위 안의 셀들을 각각 into_rows×into_cols로 분할한다(0-기준, 끝 포함).",
                                            "properties": {
                                                "start_row": { "type": "integer" },
                                                "start_col": { "type": "integer" },
                                                "end_row": { "type": "integer" },
                                                "end_col": { "type": "integer" }
                                            }
                                        }
                                    },
                                    "required": ["op"]
                                },
                                "clone_table": {
                                    "type": "object",
                                    "description": "type=\"clone_table\"일 때: 반복 양식 문서에서 기존 표를 그대로 복제하고 입력칸만 채운다(새로 그리지 않음 → 행·열·병합·테두리 원본과 100% 동일). command=INSERT_AFTER, target_id는 새 항목을 넣을 위치의 본문 문단 ID. clone_from은 컨텍스트의 '복제 가능 양식 표' 좌표(formTables[])에서 고른다.",
                                    "properties": {
                                        "clone_from": {
                                            "type": "object",
                                            "description": "복제할 원본 양식 표의 좌표. 컨텍스트 document_metadata.form_tables의 항목을 그대로 쓴다.",
                                            "properties": {
                                                "section": { "type": "integer" },
                                                "paragraph": { "type": "integer" },
                                                "control_index": { "type": "integer" }
                                            },
                                            "required": ["section", "paragraph", "control_index"]
                                        },
                                        "cell_fills": {
                                            "type": "array",
                                            "description": "복제된 표에서 채울 입력칸들. 라벨칸은 넣지 말 것(생략하면 원본 라벨이 그대로 보존된다). text는 \\n으로 여러 줄을 넣을 수 있다.",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "row": { "type": "integer", "description": "0-기준 행" },
                                                    "col": { "type": "integer", "description": "0-기준 열" },
                                                    "text": { "type": "string" }
                                                },
                                                "required": ["row", "col", "text"]
                                            }
                                        }
                                    },
                                    "required": ["clone_from"]
                                },
                                "table_data": {
                                    "type": "object",
                                    "properties": {
                                        "rows": { "type": "integer" },
                                        "cols": { "type": "integer" },
                                        "matrix": {
                                            "type": "array",
                                            "items": { "type": "array", "items": { "type": "string" } }
                                        },
                                        "merges": {
                                            "type": "array",
                                            "description": "병합할 셀 영역(0-기준, 끝 포함). 헤더·세로 병합 등.",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "start_row": { "type": "integer" },
                                                    "start_col": { "type": "integer" },
                                                    "end_row": { "type": "integer" },
                                                    "end_col": { "type": "integer" }
                                                }
                                            }
                                        },
                                        "col_weights": {
                                            "type": "array",
                                            "description": "열별 상대 폭 가중치(길이=cols). 긴 설명/비고 열은 크게(예 8), ○/× 같은 짧은 열은 작게(예 2) 두어 표가 세로로 덜 늘어나게 한다.",
                                            "items": { "type": "integer" }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    "required": ["command", "target_id", "payload"]
                }
            }
        },
        "required": ["edits"]
    })
}

fn strip_code_fences(raw: &str) -> &str {
    let trimmed = raw.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    // ```json 또는 ``` 다음 첫 줄바꿈 이후가 본문이다.
    let body = match rest.find('\n') {
        Some(idx) => &rest[idx + 1..],
        None => rest,
    };
    body.trim().strip_suffix("```").unwrap_or(body).trim()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whitelist(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_insert_after_edit() {
        let raw = r#"{
            "edits": [
                {
                    "command": "INSERT_AFTER",
                    "target_id": "sec[0].p[1]",
                    "payload": { "type": "paragraph", "text": "추가 문장." }
                }
            ]
        }"#;

        let script = parse_action_script(raw).unwrap();
        assert_eq!(script.edits.len(), 1);
        assert_eq!(script.edits[0].command, EditCommand::InsertAfter);
        assert_eq!(script.edits[0].target_id, "sec[0].p[1]");
        assert_eq!(
            script.edits[0].payload.text.as_deref(),
            Some("추가 문장.")
        );
    }

    #[test]
    fn strips_markdown_code_fences() {
        let raw = "```json\n{\"edits\":[]}\n```";
        let script = parse_action_script(raw).unwrap();
        assert!(script.edits.is_empty());
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(parse_action_script("{not json").is_err());
    }

    #[test]
    fn empty_response_gives_clear_message() {
        let err = parse_action_script("   \n  ").unwrap_err();
        assert!(err.contains("빈 응답"));
    }

    #[test]
    fn extracts_json_object_wrapped_in_prose() {
        // CLI 등이 설명 문장으로 감싼 경우에도 가장 바깥 객체를 떼어 파싱한다.
        let raw = "물론이죠! 아래가 결과입니다:\n{\"edits\":[]}\n도움이 되었길 바랍니다.";
        let script = parse_action_script(raw).unwrap();
        assert!(script.edits.is_empty());
    }

    #[test]
    fn parse_failure_includes_received_preview() {
        let err = parse_action_script("죄송하지만 편집할 수 없습니다.").unwrap_err();
        assert!(err.contains("받은 응답 일부"));
        assert!(err.contains("죄송하지만"));
    }

    #[test]
    fn collect_violations_flags_unknown_target_ids() {
        let script = parse_action_script(
            r#"{"edits":[
                {"command":"DELETE","target_id":"sec[0].p[0]","payload":{}},
                {"command":"REPLACE","target_id":"sec[9].p[9]","payload":{"text":"x"}}
            ]}"#,
        )
        .unwrap();

        let violations = collect_violations(&script, &whitelist(&["sec[0].p[0]"]));
        assert_eq!(violations, vec!["sec[9].p[9]".to_string()]);
    }

    #[test]
    fn collect_violations_empty_when_all_known() {
        let script = parse_action_script(
            r#"{"edits":[{"command":"DELETE","target_id":"sec[0].p[0]","payload":{}}]}"#,
        )
        .unwrap();
        assert!(collect_violations(&script, &whitelist(&["sec[0].p[0]"])).is_empty());
    }

    #[test]
    fn parses_paste_html_and_round_trips() {
        let raw = r#"{"edits":[
            {"command":"INSERT_AFTER","target_id":"sec[0].p[3]",
             "payload":{"type":"paste_html","paste_html":{"html":"<p><b>제목</b></p><ul><li>항목</li></ul>"}}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        let spec = script.edits[0].payload.paste_html.as_ref().unwrap();
        assert!(spec.html.contains("<b>제목</b>"));
        let json = serde_json::to_string(&script).unwrap();
        assert_eq!(parse_action_script(&json).unwrap(), script);
    }

    #[test]
    fn action_script_schema_exposes_all_editing_kinds() {
        // AI가 낼 수 있는 편집 어휘 전체 — 여기 없는 건 AI가 할 수 없는 일이다.
        let schema = action_script_schema().to_string();
        for kind in [
            "paragraph",
            "table",
            "image",
            "table_edit",
            "clone_table",
            "format",
            "chart",
            "replace_text",
            "table_formula",
            "footnote",
            "paste_html",
        ] {
            assert!(schema.contains(kind), "스키마에 payload type이 없습니다: {}", kind);
        }
    }

    #[test]
    fn parses_footnote_and_round_trips() {
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[4]",
             "payload":{"type":"footnote","footnote":{"text":"한국연구재단(2026)","anchor_text":"유의미했다"}}},
            {"command":"DELETE","target_id":"sec[0].p[4].fn[1].p[0]","payload":{"type":"footnote"}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        let add = script.edits[0].payload.footnote.as_ref().unwrap();
        assert_eq!(add.text.as_deref(), Some("한국연구재단(2026)"));
        assert_eq!(add.anchor_text.as_deref(), Some("유의미했다"));
        // 떼기는 footnote 객체 없이 type만 오는 게 정상 — 갈래는 payload.type으로 가른다.
        assert_eq!(script.edits[1].payload.kind.as_deref(), Some("footnote"));
        assert!(script.edits[1].payload.footnote.is_none());
        let json = serde_json::to_string(&script).unwrap();
        assert_eq!(parse_action_script(&json).unwrap(), script);
    }

    #[test]
    fn footnote_content_only_edit_stays_untyped() {
        // F-191fd6 하위 호환: payload.type이 없으면 '각주 내용만' 수정하는 기존 경로다.
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[4].fn[1].p[0]","payload":{"text":"새 내용"}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        assert!(script.edits[0].payload.kind.is_none());
        assert!(script.edits[0].payload.footnote.is_none());
    }

    #[test]
    fn parses_table_formula_and_round_trips() {
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[3].tbl[0].cell[0].p[0]",
             "payload":{"type":"table_formula","table_formula":{"row":5,"col":1,"formula":"=SUM(B2:B5)"}}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        let spec = script.edits[0].payload.table_formula.as_ref().unwrap();
        assert_eq!((spec.row, spec.col), (5, 1));
        assert_eq!(spec.formula, "=SUM(B2:B5)");
        let json = serde_json::to_string(&script).unwrap();
        assert_eq!(parse_action_script(&json).unwrap(), script);
    }

    #[test]
    fn action_script_schema_warns_against_mental_arithmetic() {
        // 계산을 요청받았을 때 모델이 암산한 숫자를 text로 넣지 않도록 스키마가 막아야 한다.
        let schema = action_script_schema().to_string();
        assert!(schema.contains("table_formula") && schema.contains("formula"));
        assert!(schema.contains("암산"));
        // 0-기준 좌표와 A1 표기가 섞이는 실수를 막는 안내.
        assert!(schema.contains("A1 표기"));
    }

    #[test]
    fn parses_split_cell_and_round_trips() {
        // F-6daa56b3: merge_cells의 짝. 분할 수·균등 높이·범위가 모두 살아남아야 한다.
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[2].tbl[1].cell[0].p[0]",
             "payload":{"type":"table_edit","table_edit":{"op":"split_cell","row":1,"col":2,
              "into_rows":2,"into_cols":3,"equal_row_height":false,
              "range":{"start_row":1,"start_col":0,"end_row":3,"end_col":0}}}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        let spec = script.edits[0].payload.table_edit.as_ref().unwrap();
        assert_eq!(spec.op, "split_cell");
        assert_eq!(spec.into_rows, Some(2));
        assert_eq!(spec.into_cols, Some(3));
        assert_eq!(spec.equal_row_height, Some(false));
        assert_eq!(spec.range.as_ref().unwrap().end_row, 3);
        let json = serde_json::to_string(&script).unwrap();
        assert_eq!(parse_action_script(&json).unwrap(), script);
    }

    #[test]
    fn action_script_schema_offers_split_alongside_merge() {
        // 병합만 있고 분할이 없으면 모델이 셀을 나눠 달라는 요청에 표를 다시 그린다.
        let schema = action_script_schema().to_string();
        assert!(schema.contains("split_cell") && schema.contains("merge_cells"));
        assert!(schema.contains("into_rows") && schema.contains("into_cols"));
    }

    #[test]
    fn doc_scope_target_allowed_only_for_replace_text() {
        // F-293e8c99: "doc"은 전역 찾아 바꾸기 전용 스코프 토큰이다. 다른 payload가
        // 문서 전체를 target으로 잡는 환각은 화이트리스트 위반으로 걸러야 한다.
        let script = parse_action_script(
            r#"{"edits":[
                {"command":"REPLACE","target_id":"doc",
                 "payload":{"type":"replace_text","replace_text":{"query":"2025","new_text":"2026"}}},
                {"command":"REPLACE","target_id":"doc",
                 "payload":{"type":"paragraph","text":"문서 전체를 이걸로"}}
            ]}"#,
        )
        .unwrap();

        let violations = collect_violations(&script, &whitelist(&["doc"]));
        assert_eq!(violations, vec!["doc".to_string()]);
    }

    #[test]
    fn doc_scope_target_rejected_when_not_whitelisted() {
        // 구간 스코프 요청(build_scoped_context)은 "doc"을 화이트리스트에 넣지 않는다 —
        // 구간 밖까지 바꾸는 전역 치환은 스코프 위반이므로 거부돼야 한다.
        let script = parse_action_script(
            r#"{"edits":[
                {"command":"REPLACE","target_id":"doc",
                 "payload":{"type":"replace_text","replace_text":{"query":"a","new_text":"b"}}}
            ]}"#,
        )
        .unwrap();

        let violations = collect_violations(&script, &whitelist(&["sec[0].p[0]"]));
        assert_eq!(violations, vec!["doc".to_string()]);
    }

    #[test]
    fn parses_replace_text_and_round_trips() {
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"doc","payload":{"type":"replace_text",
             "replace_text":{"query":"2025년","new_text":"2026년","case_sensitive":true,"scope":"first"}}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        let spec = script.edits[0].payload.replace_text.as_ref().unwrap();
        assert_eq!(spec.query, "2025년");
        assert_eq!(spec.new_text, "2026년");
        assert_eq!(spec.case_sensitive, Some(true));
        assert_eq!(spec.scope.as_deref(), Some("first"));
        // 재직렬화 라운드트립 — mod.rs가 파싱 결과를 다시 직렬화해 프런트로 보낸다.
        let json = serde_json::to_string(&script).unwrap();
        let again = parse_action_script(&json).unwrap();
        assert_eq!(script, again);
    }

    #[test]
    fn action_script_schema_exposes_replace_text() {
        let schema = action_script_schema().to_string();
        assert!(schema.contains("replace_text"));
        assert!(schema.contains("case_sensitive"));
        // 모델이 문단마다 REPLACE를 나열하지 않도록 유도하는 안내가 스키마에 있어야 한다.
        assert!(schema.contains("문단마다 REPLACE를 내지 말고"));
    }

    #[test]
    fn parses_variations_and_round_trips() {
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[1]",
             "payload":{"type":"paragraph","text":"안 1","variations":["안 1","안 2","안 3"]}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        assert_eq!(script.edits[0].payload.variations, vec!["안 1", "안 2", "안 3"]);
        // 재직렬화 시 프런트로 그대로 전달되어야 한다.
        let json = serde_json::to_string(&script).unwrap();
        assert!(json.contains("variations"));
        // 빈 variations는 직렬화에서 생략된다.
        let raw2 = r#"{"edits":[{"command":"DELETE","target_id":"sec[0].p[0]","payload":{}}]}"#;
        let s2 = parse_action_script(raw2).unwrap();
        assert!(!serde_json::to_string(&s2).unwrap().contains("variations"));
    }

    #[test]
    fn parses_reason_and_round_trips() {
        // 교정 패스의 payload.reason은 재직렬화(emit_validated)에서 살아남아야 한다.
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[1]",
             "payload":{"type":"paragraph","text":"됐다","reason":"맞춤법: '됬다'→'됐다'"}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        assert_eq!(script.edits[0].payload.reason.as_deref(), Some("맞춤법: '됬다'→'됐다'"));
        let json = serde_json::to_string(&script).unwrap();
        assert!(json.contains("reason"));
        // reason 없는 일반 편집은 직렬화에서 생략된다.
        let raw2 = r#"{"edits":[{"command":"DELETE","target_id":"sec[0].p[0]","payload":{}}]}"#;
        let s2 = parse_action_script(raw2).unwrap();
        assert!(!serde_json::to_string(&s2).unwrap().contains("reason"));
    }

    #[test]
    fn parses_table_edit_and_round_trips() {
        // 표 구조 편집 payload는 재직렬화(emit_validated)에서 살아남아야 한다.
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[2].tbl[0].cell[0].p[0]",
             "payload":{"type":"table_edit","table_edit":{"op":"insert_row","row":1,"below":true,"texts":["가","나"]}}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        let spec = script.edits[0].payload.table_edit.as_ref().unwrap();
        assert_eq!(spec.op, "insert_row");
        assert_eq!(spec.row, Some(1));
        assert_eq!(spec.texts, vec!["가", "나"]);
        let json = serde_json::to_string(&script).unwrap();
        assert!(json.contains("table_edit") && json.contains("insert_row"));
        // merge 범위도 라운드트립된다.
        let raw2 = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[2].tbl[0].cell[0].p[0]",
             "payload":{"type":"table_edit","table_edit":{"op":"merge_cells","merge":{"start_row":0,"start_col":0,"end_row":1,"end_col":0}}}}
        ]}"#;
        let s2 = parse_action_script(raw2).unwrap();
        assert!(serde_json::to_string(&s2).unwrap().contains("merge_cells"));
    }

    #[test]
    fn parses_char_format_and_round_trips() {
        // 부분 서식 payload(format_target+char_format)는 재직렬화에서 살아남아야 한다.
        let raw = r##"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[1]",
             "payload":{"type":"format","format_target":"핵심 성과",
                        "char_format":{"bold":true,"text_color":"#C00000","font_size_pt":14}}}
        ]}"##;
        let script = parse_action_script(raw).unwrap();
        assert_eq!(script.edits[0].payload.format_target.as_deref(), Some("핵심 성과"));
        let spec = script.edits[0].payload.char_format.as_ref().unwrap();
        assert_eq!(spec.bold, Some(true));
        assert_eq!(spec.font_size_pt, Some(14));
        let json = serde_json::to_string(&script).unwrap();
        assert!(json.contains("char_format") && json.contains("format_target"));
    }

    #[test]
    fn parses_chart_data_and_round_trips() {
        let raw = r#"{"edits":[
            {"command":"INSERT_AFTER","target_id":"sec[0].p[3]",
             "payload":{"type":"chart","chart_data":{"kind":"bar","title":"분기별 매출",
               "labels":["1분기","2분기"],"series":[{"name":"매출","values":[120.5,98.0]}]}}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        let chart = script.edits[0].payload.chart_data.as_ref().unwrap();
        assert_eq!(chart.kind, "bar");
        assert_eq!(chart.labels.len(), 2);
        assert_eq!(chart.series[0].values, vec![120.5, 98.0]);
        // 재직렬화(emit_validated)에서 살아남아 프런트로 전달된다.
        let json = serde_json::to_string(&script).unwrap();
        assert!(json.contains("chart_data") && json.contains("분기별 매출"));
    }

    #[test]
    fn parses_form_fill_response_and_round_trips() {
        // 양식 이어쓰기 응답은 entries[].fields[]{label,value}만 가진다 — 표/compose 없음.
        let raw = r#"{
            "message": "연구노트 항목 2개를 추가했습니다.",
            "entries": [
                {"fields": [
                    {"label": "제목", "value": "실험 A 재현"},
                    {"label": "연구내용", "value": "첫째 줄\n둘째 줄"}
                ]},
                {"fields": [{"label": "제목", "value": "실험 B"}]}
            ]
        }"#;
        let resp = parse_form_fill_response(raw).unwrap();
        assert_eq!(resp.entries.len(), 2);
        assert_eq!(resp.entries[0].fields.len(), 2);
        assert_eq!(resp.entries[0].fields[1].label, "연구내용");
        assert_eq!(resp.entries[0].fields[1].value, "첫째 줄\n둘째 줄");
        assert_eq!(resp.message.as_deref(), Some("연구노트 항목 2개를 추가했습니다."));
        // 재직렬화 라운드트립.
        let json = serde_json::to_string(&resp).unwrap();
        let again = parse_form_fill_response(&json).unwrap();
        assert_eq!(resp, again);
    }

    #[test]
    fn form_fill_schema_has_no_table_or_compose_constructs() {
        // 스키마에 표/compose/edit 구성요소가 없어야 한다(AC-0cd01fc1 — AI가 표를 그릴 여지 제거).
        let schema = form_fill_schema().to_string();
        assert!(schema.contains("entries") && schema.contains("fields"));
        assert!(schema.contains("label") && schema.contains("value"));
        for forbidden in [
            "table_data",
            "clone_table",
            "table_edit",
            "matrix",
            "merges",
            "\"rows\"",
            "\"cols\"",
        ] {
            assert!(
                !schema.contains(forbidden),
                "form_fill 스키마가 표/compose 구성요소를 노출하면 안 됩니다: {}",
                forbidden
            );
        }
    }

    #[test]
    fn form_fill_response_struct_has_no_table_fields() {
        // 구조체 자체에도 표 관련 필드가 없음을 직렬화 키로 확인한다.
        let resp = FormFillResponse {
            entries: vec![FormFillEntry {
                fields: vec![FormFillField {
                    label: "제목".to_string(),
                    value: "x".to_string(),
                }],
            }],
            message: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        for forbidden in ["table", "clone", "matrix", "merge", "compose", "command"] {
            assert!(!json.contains(forbidden), "표/compose 키 노출 금지: {}", forbidden);
        }
    }

    #[test]
    fn parse_form_fill_response_rejects_empty_and_garbage() {
        assert!(parse_form_fill_response("   ").unwrap_err().contains("빈 응답"));
        assert!(parse_form_fill_response("not json").is_err());
        // 코드펜스 래핑도 벗겨낸다.
        let fenced = "```json\n{\"entries\":[]}\n```";
        assert!(parse_form_fill_response(fenced).unwrap().entries.is_empty());
    }

    #[test]
    fn command_round_trips_to_screaming_snake_case() {
        let value = serde_json::to_value(EditCommand::InsertBefore).unwrap();
        assert_eq!(value, json!("INSERT_BEFORE"));
    }
}
