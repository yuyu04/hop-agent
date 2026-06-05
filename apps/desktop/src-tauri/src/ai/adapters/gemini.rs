//! Google Gemini 어댑터(스펙 5장).
//!
//! `responseMimeType: application/json` + `responseSchema`로 구조화 출력을
//! 강제한다. Gemini의 responseSchema는 OpenAPI 부분집합이라 draft `$schema`
//! 키를 받지 않으므로, 3장 스키마 대신 Gemini용 간소 스키마를 별도로 만든다.

use super::sse::{map_reqwest_err, stream_sse};
use super::{http_client, user_content};
use crate::ai::provider::{CancelToken, DeltaSink, LlmProvider, LlmRequest, ProviderError};
use serde_json::{json, Value};

pub struct GeminiProvider {
    pub api_key: String,
    pub model: String,
}

impl GeminiProvider {
    pub fn build_body(&self, req: &LlmRequest) -> Value {
        json!({
            "systemInstruction": { "parts": [{ "text": req.system_prompt }] },
            "contents": [{
                "role": "user",
                "parts": [{ "text": user_content(req) }]
            }],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": gemini_action_script_schema(),
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

/// Gemini responseSchema용 간소 스키마(OpenAPI 부분집합, `$schema` 없음).
fn gemini_action_script_schema() -> Value {
    json!({
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
                                "type": { "type": "string" },
                                "text": { "type": "string" },
                                "style": { "type": "string" }
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

/// SSE data JSON에서 `candidates[0].content.parts[0].text` fragment를 뽑는다.
pub fn extract_gemini_delta(data: &str) -> Option<String> {
    let value: Value = serde_json::from_str(data).ok()?;
    value
        .get("candidates")?
        .get(0)?
        .get("content")?
        .get("parts")?
        .get(0)?
        .get("text")?
        .as_str()
        .map(str::to_string)
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
        stream_sse(response, &on_delta, &cancel, extract_gemini_delta).await
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
        let body = provider().build_body(&request());
        let config = &body["generationConfig"];
        assert_eq!(config["responseMimeType"], json!("application/json"));
        // Gemini 스키마에는 draft `$schema` 키가 없어야 한다.
        assert!(config["responseSchema"].get("$schema").is_none());
        assert_eq!(config["responseSchema"]["type"], json!("object"));
        assert!(config["responseSchema"]["properties"]["edits"].is_object());
    }

    #[test]
    fn endpoint_uses_streaming_sse() {
        assert!(provider().endpoint().contains(":streamGenerateContent?alt=sse"));
        assert!(provider().endpoint().contains("/models/gemini-x:"));
    }

    #[test]
    fn extracts_part_text() {
        let data = "{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"XY\"}]}}]}";
        assert_eq!(extract_gemini_delta(data), Some("XY".to_string()));
        assert_eq!(extract_gemini_delta("{\"candidates\":[]}"), None);
        assert_eq!(extract_gemini_delta("nope"), None);
    }
}
