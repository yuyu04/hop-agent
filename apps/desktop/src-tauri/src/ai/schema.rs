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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_data: Option<TableData>,
    /// INSERT 시 참이면 새 페이지에서 시작(본문 문단에만 적용).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_break: Option<bool>,
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
                                "type": { "type": "string", "enum": ["paragraph", "table"] },
                                "text": { "type": "string" },
                                "style": { "type": "string" },
                                "page_break": {
                                    "type": "boolean",
                                    "description": "참이면 삽입한 문단을 새 페이지에서 시작한다(INSERT에만 유효)."
                                },
                                "table_data": {
                                    "type": "object",
                                    "properties": {
                                        "rows": { "type": "integer" },
                                        "cols": { "type": "integer" },
                                        "matrix": {
                                            "type": "array",
                                            "items": { "type": "array", "items": { "type": "string" } }
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
    fn command_round_trips_to_screaming_snake_case() {
        let value = serde_json::to_value(EditCommand::InsertBefore).unwrap();
        assert_eq!(value, json!("INSERT_BEFORE"));
    }
}
