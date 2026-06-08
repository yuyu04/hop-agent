//! OpenAI 호환 어댑터(스펙 5장).
//!
//! OpenAI(`api.openai.com`)와 Ollama(`localhost:11434`), 사내 게이트웨이를 하나의
//! `/v1/chat/completions` 엔드포인트로 처리한다. 구조화 출력은 OpenAI는
//! `json_schema`(strict), Ollama는 `json_object`로 강제한다.

use super::sse::{map_reqwest_err, stream_sse};
use super::{http_client, image_data_url, user_content};
use crate::ai::provider::{CancelToken, DeltaSink, LlmProvider, LlmRequest, ProviderError};
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StructuredMode {
    /// OpenAI 등: `response_format.json_schema` (strict).
    JsonSchema,
    /// Ollama 등 json_schema 미지원: `response_format.json_object`.
    JsonObject,
}

pub struct OpenAiProvider {
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
    pub structured: StructuredMode,
}

impl OpenAiProvider {
    pub fn build_body(&self, req: &LlmRequest) -> Value {
        let response_format = match self.structured {
            StructuredMode::JsonSchema => json!({
                "type": "json_schema",
                "json_schema": {
                    "name": "action_script",
                    "strict": true,
                    "schema": req.output_schema,
                }
            }),
            StructuredMode::JsonObject => json!({ "type": "json_object" }),
        };
        // 이미지가 없으면 평문 content, 있으면 OpenAI 멀티모달 content 배열.
        let user_message = if req.images.is_empty() {
            json!(user_content(req))
        } else {
            let mut parts = vec![json!({ "type": "text", "text": user_content(req) })];
            for image in &req.images {
                parts.push(json!({
                    "type": "image_url",
                    "image_url": { "url": image_data_url(image) }
                }));
            }
            json!(parts)
        };
        json!({
            "model": self.model,
            "stream": true,
            "messages": [
                { "role": "system", "content": req.system_prompt },
                { "role": "user", "content": user_message }
            ],
            "response_format": response_format,
        })
    }

    fn endpoint(&self) -> String {
        format!("{}/v1/chat/completions", self.base_url.trim_end_matches('/'))
    }
}

/// SSE data JSON 한 건에서 `choices[0].delta.content` fragment를 뽑는다.
pub fn extract_openai_delta(data: &str) -> Option<String> {
    let value: Value = serde_json::from_str(data).ok()?;
    value
        .get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()
        .map(str::to_string)
}

#[async_trait::async_trait]
impl LlmProvider for OpenAiProvider {
    async fn generate_edit(
        &self,
        req: LlmRequest,
        on_delta: DeltaSink,
        cancel: CancelToken,
    ) -> Result<String, ProviderError> {
        let client = http_client()?;
        let mut builder = client.post(self.endpoint()).json(&self.build_body(&req));
        if let Some(key) = &self.api_key {
            builder = builder.bearer_auth(key);
        }
        let response = builder.send().await.map_err(map_reqwest_err)?;
        stream_sse(response, &on_delta, &cancel, extract_openai_delta).await
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
            output_schema: json!({ "type": "object" }),
            images: Vec::new(),
            documents: Vec::new(),
            file_paths: Vec::new(),
        }
    }

    fn provider(structured: StructuredMode) -> OpenAiProvider {
        OpenAiProvider {
            base_url: "https://api.openai.com".to_string(),
            api_key: Some("k".to_string()),
            model: "gpt-x".to_string(),
            structured,
        }
    }

    #[test]
    fn json_schema_mode_injects_strict_schema() {
        let body = provider(StructuredMode::JsonSchema).build_body(&request());
        assert_eq!(body["model"], json!("gpt-x"));
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["response_format"]["type"], json!("json_schema"));
        assert_eq!(body["response_format"]["json_schema"]["strict"], json!(true));
        assert_eq!(
            body["response_format"]["json_schema"]["schema"],
            json!({ "type": "object" })
        );
    }

    #[test]
    fn json_object_mode_for_ollama() {
        let body = provider(StructuredMode::JsonObject).build_body(&request());
        assert_eq!(body["response_format"], json!({ "type": "json_object" }));
    }

    #[test]
    fn endpoint_trims_trailing_slash() {
        let mut p = provider(StructuredMode::JsonObject);
        p.base_url = "http://localhost:11434/".to_string();
        assert_eq!(p.endpoint(), "http://localhost:11434/v1/chat/completions");
    }

    #[test]
    fn extracts_content_delta() {
        assert_eq!(
            extract_openai_delta("{\"choices\":[{\"delta\":{\"content\":\"AB\"}}]}"),
            Some("AB".to_string())
        );
        assert_eq!(extract_openai_delta("{\"choices\":[{\"delta\":{}}]}"), None);
        assert_eq!(extract_openai_delta("not json"), None);
    }
}
