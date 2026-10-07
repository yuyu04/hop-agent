//! Google Gemini 어댑터(스펙 5장).
//!
//! `responseMimeType: application/json` + `responseSchema`로 구조화 출력을
//! 강제한다. Gemini의 responseSchema는 OpenAPI 부분집합이라 draft `$schema` 등
//! 모르는 키를 받지 않으므로, 요청마다 **실제 출력 스키마**(`req.output_schema`)를
//! 그 부분집합으로 변환해 보낸다. (예전에는 편집 4종·문단 텍스트만 담은 간소 스키마를
//! 따로 들고 있어서, Gemini는 표·이미지·서식·찾아바꾸기 같은 확장 명령과 양식 채우기
//! 응답을 아예 만들 수 없었다.)

use super::sse::{map_reqwest_err, stream_sse};
use super::{http_client, user_content};
use crate::ai::provider::{CancelToken, DeltaSink, LlmProvider, LlmRequest, ProviderError};
use serde_json::{json, Map, Value};

/// thinking 토큰까지 포함한 출력 상한(현행 Gemini 2.5/3 계열 상한 64K 안쪽).
const MAX_OUTPUT_TOKENS: u32 = 32_768;

pub struct GeminiProvider {
    pub api_key: String,
    pub model: String,
}

impl GeminiProvider {
    pub fn build_body(&self, req: &LlmRequest) -> Value {
        let mut parts = vec![json!({ "text": user_content(req) })];
        // 이미지·문서(PDF 등) 모두 inline_data로 보낸다(Gemini는 application/pdf 지원).
        for media in req.images.iter().chain(req.documents.iter()) {
            parts.push(json!({
                "inline_data": { "mime_type": media.mime_type, "data": media.data_base64 }
            }));
        }
        json!({
            "systemInstruction": { "parts": [{ "text": req.system_prompt }] },
            "contents": [{ "role": "user", "parts": parts }],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": gemini_schema(&req.output_schema),
                "maxOutputTokens": MAX_OUTPUT_TOKENS,
            }
        })
    }

    fn endpoint(&self) -> String {
        format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:streamGenerateContent?alt=sse",
            self.model
        )
    }
}

/// JSON Schema(draft-07)를 Gemini responseSchema(OpenAPI 3 부분집합)로 바꾼다.
///
/// 아는 키만 남기고(`$schema`·`additionalProperties`·`title` 등은 버림), `type`이 배열
/// (`["string","null"]`)이면 첫 비-null 타입 + `nullable`로 접는다. 속성이 없는
/// 객체는 Gemini가 거부하므로 자유 문자열로 완화한다.
pub fn gemini_schema(schema: &Value) -> Value {
    let Some(object) = schema.as_object() else {
        return json!({ "type": "string" });
    };
    let mut out = Map::new();
    match object.get("type") {
        Some(Value::String(kind)) => {
            out.insert("type".into(), json!(kind));
        }
        Some(Value::Array(kinds)) => {
            let non_null: Vec<&str> = kinds
                .iter()
                .filter_map(Value::as_str)
                .filter(|kind| *kind != "null")
                .collect();
            out.insert("type".into(), json!(non_null.first().copied().unwrap_or("string")));
            if non_null.len() < kinds.len() {
                out.insert("nullable".into(), json!(true));
            }
        }
        _ => {}
    }
    for key in ["description", "format", "enum", "minItems", "maxItems", "minimum", "maximum"] {
        if let Some(value) = object.get(key) {
            out.insert(key.into(), value.clone());
        }
    }
    if let Some(items) = object.get("items") {
        out.insert("items".into(), gemini_schema(items));
    }
    if let Some(Value::Object(properties)) = object.get("properties") {
        let converted: Map<String, Value> = properties
            .iter()
            .map(|(name, value)| (name.clone(), gemini_schema(value)))
            .collect();
        if !converted.is_empty() {
            out.insert("properties".into(), Value::Object(converted));
            if let Some(required) = object.get("required") {
                out.insert("required".into(), required.clone());
            }
        }
    }
    if let Some(Value::Array(variants)) = object.get("anyOf").or_else(|| object.get("oneOf")) {
        out.insert(
            "anyOf".into(),
            Value::Array(variants.iter().map(gemini_schema).collect()),
        );
    }
    if out.get("type") == Some(&json!("object")) && !out.contains_key("properties") {
        out.insert("type".into(), json!("string"));
    }
    if !out.contains_key("type") && !out.contains_key("anyOf") {
        out.insert("type".into(), json!("string"));
    }
    Value::Object(out)
}

/// 한 번의 Gemini 스트림에서 모은 상태.
#[derive(Debug, Default)]
pub struct GeminiStreamState {
    pub finish_reason: Option<String>,
    /// 프롬프트 자체가 막혔을 때(`promptFeedback.blockReason`) — 후보가 아예 없다.
    pub block_reason: Option<String>,
}

impl GeminiStreamState {
    /// SSE data 한 건에서 응답 텍스트를 모두 뽑는다(사고 요약 `thought` 파트는 제외).
    pub fn on_event(&mut self, data: &str) -> Option<String> {
        let value: Value = serde_json::from_str(data).ok()?;
        if let Some(reason) = value["promptFeedback"]["blockReason"].as_str() {
            self.block_reason = Some(reason.to_string());
        }
        let candidate = value.get("candidates")?.get(0)?;
        if let Some(reason) = candidate.get("finishReason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_string());
        }
        let text: String = candidate
            .get("content")?
            .get("parts")?
            .as_array()?
            .iter()
            .filter(|part| part.get("thought").and_then(Value::as_bool) != Some(true))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect();
        (!text.is_empty()).then_some(text)
    }
}

#[async_trait::async_trait]
impl LlmProvider for GeminiProvider {
    async fn generate_edit(
        &self,
        req: LlmRequest,
        on_delta: DeltaSink,
        cancel: CancelToken,
    ) -> Result<String, ProviderError> {
        let client = http_client()?;
        let response = client
            .post(self.endpoint())
            .header("x-goog-api-key", &self.api_key)
            .json(&self.build_body(&req))
            .send()
            .await
            .map_err(map_reqwest_err)?;
        let mut state = GeminiStreamState::default();
        let text = stream_sse(response, &on_delta, &cancel, |data| state.on_event(data)).await?;
        judge_gemini(&state, text)
    }
}

/// 스트림 종료 상태로 결과를 판정한다(네트워크 없이 테스트 가능한 순수 함수). 잘림·차단은
/// 잘린 JSON을 파싱하게 두지 않고 원인을 알리는 오류로 끝낸다.
pub fn judge_gemini(state: &GeminiStreamState, text: String) -> Result<String, ProviderError> {
    if state.block_reason.is_some() {
        return Err(ProviderError::Provider(
            "요청이 안전 정책으로 차단되었습니다. 요청을 바꿔 다시 시도하세요.".to_string(),
        ));
    }
    match state.finish_reason.as_deref() {
        // 끝까지 닫힌 편집이 있으면 그것만 건져 미리보기로 보낸다(없으면 원인을 알리는 오류).
        Some("MAX_TOKENS") => crate::ai::schema::salvage_truncated_script(&text).ok_or_else(|| {
            ProviderError::Provider(format!(
                "응답이 출력 한도({}토큰)에서 잘렸습니다. 요청을 나눠 다시 시도하세요.",
                MAX_OUTPUT_TOKENS
            ))
        }),
        Some("SAFETY") | Some("PROHIBITED_CONTENT") | Some("BLOCKLIST") | Some("SPII") => {
            Err(ProviderError::Provider(
                "모델이 안전 정책으로 응답을 중단했습니다. 요청을 바꿔 다시 시도하세요."
                    .to_string(),
            ))
        }
        _ => Ok(text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> LlmRequest {
        LlmRequest {
            system_prompt: "sys".to_string(),
            user_prompt: "문단 추가".to_string(),
            document_context_json: "{\"content\":[]}".to_string(),
            output_schema: json!({ "$schema": "draft-07", "type": "object" }),
            images: Vec::new(),
            documents: Vec::new(),
            file_paths: Vec::new(),
        }
    }

    fn provider() -> GeminiProvider {
        GeminiProvider {
            api_key: "k".to_string(),
            model: "gemini-x".to_string(),
        }
    }

    #[test]
    fn sets_json_mime_and_response_schema_without_draft_key() {
        let mut req = request();
        req.output_schema = crate::ai::schema::action_script_schema();
        let body = provider().build_body(&req);
        let config = &body["generationConfig"];
        assert_eq!(config["responseMimeType"], json!("application/json"));
        // Gemini 스키마에는 draft `$schema` 키가 없어야 한다.
        assert!(config["responseSchema"].get("$schema").is_none());
        assert_eq!(config["responseSchema"]["type"], json!("object"));
        assert!(config["responseSchema"]["properties"]["edits"].is_object());
    }

    #[test]
    fn response_schema_carries_the_real_action_script_vocabulary() {
        // 간소 스키마(문단 텍스트만) 대신 실제 스키마를 변환해 보낸다 — 표·서식·찾아바꾸기 등.
        let mut req = request();
        req.output_schema = crate::ai::schema::action_script_schema();
        let body = provider().build_body(&req);
        let payload = &body["generationConfig"]["responseSchema"]["properties"]["edits"]["items"]
            ["properties"]["payload"]["properties"];
        for key in ["table_data", "char_format", "para_format", "page_setup", "page_number", "replace_text", "table_edit", "footnote", "paste_html"] {
            assert!(payload.get(key).is_some(), "payload.{key} 누락");
        }
        assert!(
            body["generationConfig"]["responseSchema"]["properties"]
                .get("message")
                .is_some(),
            "message 필드도 전달"
        );
    }

    #[test]
    fn form_fill_schema_is_sent_as_is_not_replaced_by_edits_schema() {
        let mut req = request();
        req.output_schema = crate::ai::schema::form_fill_schema();
        let body = provider().build_body(&req);
        let schema = &body["generationConfig"]["responseSchema"];
        assert!(schema["properties"].get("entries").is_some());
        assert!(schema["properties"].get("edits").is_none());
    }

    #[test]
    fn gemini_schema_strips_unknown_keys_and_folds_nullable_types() {
        let converted = gemini_schema(&json!({
            "$schema": "draft-07",
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "a": { "type": ["string", "null"], "title": "x" },
                "b": { "type": "object" },
                "c": { "type": "array", "items": { "type": "integer", "minimum": 0 } }
            },
            "required": ["a"]
        }));
        assert_eq!(
            converted,
            json!({
                "type": "object",
                "properties": {
                    "a": { "type": "string", "nullable": true },
                    "b": { "type": "string" },
                    "c": { "type": "array", "items": { "type": "integer", "minimum": 0 } }
                },
                "required": ["a"]
            })
        );
    }

    #[test]
    fn stream_state_joins_text_parts_skips_thoughts_and_records_finish_reason() {
        let mut state = GeminiStreamState::default();
        let data = r#"{"candidates":[{"content":{"parts":[{"text":"생각","thought":true},{"text":"{\"ed"},{"text":"its\":[]}"}]},"finishReason":"MAX_TOKENS"}]}"#;
        assert_eq!(state.on_event(data), Some("{\"edits\":[]}".to_string()));
        assert_eq!(state.finish_reason.as_deref(), Some("MAX_TOKENS"));
    }

    #[test]
    fn endpoint_uses_streaming_sse() {
        assert!(provider().endpoint().contains(":streamGenerateContent?alt=sse"));
        assert!(provider().endpoint().contains("/models/gemini-x:"));
    }

    #[test]
    fn documents_are_sent_as_inline_data() {
        use crate::ai::provider::ImageInput;
        let mut req = request();
        req.documents = vec![ImageInput {
            mime_type: "application/pdf".to_string(),
            data_base64: "JVBERi0=".to_string(),
        }];
        let body = provider().build_body(&req);
        let parts = body["contents"][0]["parts"].as_array().unwrap();
        let has_pdf = parts.iter().any(|p| {
            p["inline_data"]["mime_type"] == json!("application/pdf")
                && p["inline_data"]["data"] == json!("JVBERi0=")
        });
        assert!(has_pdf, "PDF가 inline_data 파트로 포함되어야 한다");
    }

    #[test]
    fn extracts_part_text() {
        let data = "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"XY\"}]}}]}";
        assert_eq!(GeminiStreamState::default().on_event(data), Some("XY".to_string()));
        assert_eq!(GeminiStreamState::default().on_event("{\"candidates\":[]}"), None);
        assert_eq!(GeminiStreamState::default().on_event("nope"), None);
    }

    // ── F-73cbb137 AC-82aeb866: 한도 잘림·안전 차단은 잘린 JSON을 넘기지 않고 오류로 끝낸다 ──

    fn state_from(events: &[&str]) -> (GeminiStreamState, String) {
        let mut state = GeminiStreamState::default();
        let mut text = String::new();
        for event in events {
            if let Some(fragment) = state.on_event(event) {
                text.push_str(&fragment);
            }
        }
        (state, text)
    }

    fn provider_message(result: Result<String, ProviderError>) -> String {
        match result {
            Err(ProviderError::Provider(message)) => message,
            other => panic!("Err(Provider)가 아니다: {other:?}"),
        }
    }

    #[test]
    fn f73cbb137_ac_82aeb866_output_budget_covers_thinking_tokens() {
        let body = provider().build_body(&request());
        let budget = body["generationConfig"]["maxOutputTokens"]
            .as_u64()
            .expect("maxOutputTokens는 정수");
        assert!(budget >= 32_000, "출력 한도가 thinking을 감안하지 못함: {budget}");
    }

    #[test]
    fn f73cbb137_ac_82aeb866_max_tokens_truncation_is_an_error_not_partial_json() {
        let (state, text) = state_from(&[
            r#"{"candidates":[{"content":{"parts":[{"text":"{\"edits\":[{\"comm"}]}}]}"#,
            r#"{"candidates":[{"content":{"parts":[{"text":"and\":"}]},"finishReason":"MAX_TOKENS"}]}"#,
        ]);
        assert_eq!(text, r#"{"edits":[{"command":"#);
        let message = provider_message(judge_gemini(&state, text));
        assert!(message.contains("출력 한도"), "{message}");
    }

    #[test]
    fn f73cbb137_ac_82aeb866_safety_finish_reasons_are_errors() {
        for reason in ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"] {
            let event = format!(
                r#"{{"candidates":[{{"content":{{"parts":[{{"text":"{{\"ed"}}]}},"finishReason":"{reason}"}}]}}"#
            );
            let (state, text) = state_from(&[event.as_str()]);
            let message = provider_message(judge_gemini(&state, text));
            assert!(message.contains("안전 정책"), "{reason}: {message}");
        }
    }

    #[test]
    fn f73cbb137_ac_82aeb866_prompt_block_reason_is_an_error() {
        // 프롬프트가 막히면 후보가 아예 없고 promptFeedback.blockReason만 온다.
        let (state, text) = state_from(&[r#"{"promptFeedback":{"blockReason":"SAFETY"}}"#]);
        assert_eq!(state.block_reason.as_deref(), Some("SAFETY"));
        assert!(text.is_empty());
        let message = provider_message(judge_gemini(&state, text));
        assert!(message.contains("차단"), "{message}");
    }

    #[test]
    fn f73cbb137_ac_82aeb866_normal_stop_returns_the_joined_text() {
        let (state, text) = state_from(&[
            r#"{"candidates":[{"content":{"parts":[{"text":"{\"edits\""}]}}]}"#,
            r#"{"candidates":[{"content":{"parts":[{"text":":[]}"}]},"finishReason":"STOP"}]}"#,
        ]);
        assert_eq!(judge_gemini(&state, text).unwrap(), r#"{"edits":[]}"#);
    }

    // ── F-a7b2c7ba AC-ee075a19: MAX_TOKENS로 끊긴 응답은 완결된 편집만 살린다 ──

    /// 응답 텍스트 조각 하나를 담은 스트림 이벤트(마지막이면 finishReason 포함).
    fn text_event(fragment: &str, finish: Option<&str>) -> String {
        let mut candidate = json!({ "content": { "parts": [{ "text": fragment }] } });
        if let Some(reason) = finish {
            candidate["finishReason"] = json!(reason);
        }
        json!({ "candidates": [candidate] }).to_string()
    }

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_max_tokens_salvages_complete_edits() {
        let events = [
            text_event(r#"{"message":"앞부분을 썼습니다.","edits":[{"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"제목"}},"#, None),
            text_event(r#"{"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"type":"table","table_data":{"rows":1,"cols":2,"matrix":[["a","b"]]}}},"#, None),
            text_event(r#"{"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"끊긴"#, Some("MAX_TOKENS")),
        ];
        let refs: Vec<&str> = events.iter().map(String::as_str).collect();
        let (state, text) = state_from(&refs);
        assert_eq!(state.finish_reason.as_deref(), Some("MAX_TOKENS"));

        let json = judge_gemini(&state, text).expect("완결된 편집이 있으면 Ok");
        let script = crate::ai::schema::parse_action_script(&json).expect("살린 JSON은 유효하다");
        assert_eq!(script.edits.len(), 2);
        assert_eq!(script.edits[0].payload.text.as_deref(), Some("제목"));
        let table = script.edits[1].payload.table_data.as_ref().expect("표 편집 보존");
        assert_eq!(table.matrix, vec![vec!["a".to_string(), "b".to_string()]]);
        let message = script.message.unwrap_or_default();
        assert!(message.starts_with("앞부분을 썼습니다."), "{message}");
        assert!(message.contains("출력 한도"), "{message}");
        assert!(message.contains("앞의 2건"), "{message}");
    }

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_max_tokens_without_a_complete_edit_is_an_error() {
        for partial in [r#"{"message":"요약"#, r#"{"message":"요약","edits":[{"command":"REPLACE""#] {
            let event = text_event(partial, Some("MAX_TOKENS"));
            let (state, text) = state_from(&[event.as_str()]);
            let message = provider_message(judge_gemini(&state, text));
            assert!(message.contains("출력 한도"), "{partial}: {message}");
        }
    }
}
