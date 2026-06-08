//! Anthropic(Claude) 어댑터(스펙 5장).
//!
//! `tools` + `tool_choice`로 Action Script 스키마를 강제 호출하게 하여 구조화
//! 출력을 보장한다. 스트리밍 시 `content_block_delta`의 `input_json_delta`
//! (`partial_json`) 조각을 누적하면 최종 도구 입력 JSON이 된다.

use super::sse::{map_reqwest_err, stream_sse};
use super::{http_client, user_content};
use crate::ai::provider::{CancelToken, DeltaSink, LlmProvider, LlmRequest, ProviderError};
use serde_json::{json, Value};

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const TOOL_NAME: &str = "emit_action_script";

pub struct AnthropicProvider {
    pub api_key: String,
    pub model: String,
}

impl AnthropicProvider {
    pub fn build_body(&self, req: &LlmRequest) -> Value {
        let user_message = if req.images.is_empty() && req.documents.is_empty() {
            json!(user_content(req))
        } else {
            let mut blocks = vec![json!({ "type": "text", "text": user_content(req) })];
            for image in &req.images {
                blocks.push(json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": image.mime_type,
                        "data": image.data_base64,
                    }
                }));
            }
            // PDF 등 문서는 document 블록으로(Anthropic은 application/pdf 지원).
            for doc in &req.documents {
                blocks.push(json!({
                    "type": "document",
                    "source": {
                        "type": "base64",
                        "media_type": doc.mime_type,
                        "data": doc.data_base64,
                    }
                }));
            }
            json!(blocks)
        };
        json!({
            "model": self.model,
            "max_tokens": 4096,
            "stream": true,
            "system": req.system_prompt,
            "messages": [
                { "role": "user", "content": user_message }
            ],
            "tools": [{
                "name": TOOL_NAME,
                "description": "검증된 Action Script(JSON)를 반환한다.",
                "input_schema": req.output_schema,
            }],
            "tool_choice": { "type": "tool", "name": TOOL_NAME },
        })
    }
}

/// `content_block_delta`의 `input_json_delta.partial_json` 조각을 뽑는다.
pub fn extract_anthropic_delta(data: &str) -> Option<String> {
    let value: Value = serde_json::from_str(data).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("content_block_delta") {
        return None;
    }
    value
        .get("delta")?
        .get("partial_json")?
        .as_str()
        .map(str::to_string)
}

#[async_trait::async_trait]
impl LlmProvider for AnthropicProvider {
    async fn generate_edit(
        &self,
        req: LlmRequest,
        on_delta: DeltaSink,
        cancel: CancelToken,
    ) -> Result<String, ProviderError> {
        let client = http_client()?;
        let response = client
            .post(ANTHROPIC_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&self.build_body(&req))
            .send()
            .await
            .map_err(map_reqwest_err)?;
        stream_sse(response, &on_delta, &cancel, extract_anthropic_delta).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> LlmRequest {
        LlmRequest {
            system_prompt: "sys".to_string(),
            user_prompt: "표 추가".to_string(),
            document_context_json: "{\"content\":[]}".to_string(),
            output_schema: json!({ "type": "object", "marker": 7 }),
            images: Vec::new(),
            documents: Vec::new(),
        }
    }

    fn provider() -> AnthropicProvider {
        AnthropicProvider {
            api_key: "k".to_string(),
            model: "claude-x".to_string(),
        }
    }

    #[test]
    fn forces_tool_choice_with_injected_schema() {
        let body = provider().build_body(&request());
        assert_eq!(body["model"], json!("claude-x"));
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["tool_choice"], json!({ "type": "tool", "name": TOOL_NAME }));
        assert_eq!(body["tools"][0]["name"], json!(TOOL_NAME));
        assert_eq!(
            body["tools"][0]["input_schema"],
            json!({ "type": "object", "marker": 7 })
        );
    }

    #[test]
    fn documents_are_sent_as_document_blocks() {
        use crate::ai::provider::ImageInput;
        let mut req = request();
        req.documents = vec![ImageInput {
            mime_type: "application/pdf".to_string(),
            data_base64: "JVBERi0=".to_string(),
        }];
        let body = provider().build_body(&req);
        let blocks = body["messages"][0]["content"].as_array().unwrap();
        let has_doc = blocks.iter().any(|b| {
            b["type"] == json!("document")
                && b["source"]["media_type"] == json!("application/pdf")
                && b["source"]["data"] == json!("JVBERi0=")
        });
        assert!(has_doc, "PDF가 document 블록으로 포함되어야 한다");
    }

    #[test]
    fn extracts_partial_json_from_content_block_delta() {
        let data = "{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"ed\"}}";
        assert_eq!(extract_anthropic_delta(data), Some("{\"ed".to_string()));
    }

    #[test]
    fn ignores_non_delta_events() {
        assert_eq!(
            extract_anthropic_delta("{\"type\":\"message_start\",\"message\":{}}"),
            None
        );
        assert_eq!(extract_anthropic_delta("not json"), None);
    }
}
