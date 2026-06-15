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
    /// "insert_row" | "insert_col" | "delete_row" | "delete_col" | "merge_cells"
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

/// 화이트리스트에 없는 `target_id`(환각으로 간주) 목록을 반환한다. 빈 벡터면 통과.
pub fn collect_violations(script: &ActionScript, whitelist: &HashSet<String>) -> Vec<String> {
    script
        .edits
        .iter()
        .filter(|edit| !whitelist.contains(&edit.target_id))
        .map(|edit| edit.target_id.clone())
        .collect()
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
                                "type": { "type": "string", "enum": ["paragraph", "table", "image", "table_edit", "clone_table", "format", "chart"] },
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
                                "table_edit": {
                                    "type": "object",
                                    "description": "type=\"table_edit\"일 때: 기존 표의 구조 편집. target_id는 그 표 안의 아무 셀 ID(예: sec[0].p[2].tbl[0].cell[0].p[0]). command는 REPLACE를 쓴다.",
                                    "properties": {
                                        "op": { "type": "string", "enum": ["insert_row", "insert_col", "delete_row", "delete_col", "merge_cells"] },
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
    fn command_round_trips_to_screaming_snake_case() {
        let value = serde_json::to_value(EditCommand::InsertBefore).unwrap();
        assert_eq!(value, json!("INSERT_BEFORE"));
    }
}
