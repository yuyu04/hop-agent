//! 실제 LLM provider 어댑터(스펙 5장)와 공용 빌더.
//!
//! AI 코어(`ai/mod.rs`)는 `build_provider`로 `provider_id`에 맞는 어댑터를 만든다.
//! 어댑터는 `LlmProvider`를 구현하며 "원문 JSON 문자열"까지만 책임진다 —
//! 화이트리스트·스키마 검증은 코어에서 수행한다.

pub mod anthropic;
pub mod gemini;
pub mod openai;
pub mod sse;

use crate::ai::provider::{LlmProvider, LlmRequest, ProviderError};
use anthropic::AnthropicProvider;
use gemini::GeminiProvider;
use openai::{OpenAiProvider, StructuredMode};
use std::time::Duration;

const OPENAI_BASE_URL: &str = "https://api.openai.com";
const OLLAMA_BASE_URL: &str = "http://localhost:11434";

/// `provider_id`에 맞는 어댑터를 만든다. 키가 필요한 provider인데 키가 없으면
/// 명확한 에러를 반환한다. `"mock"`은 코어(`ai/mod.rs`)에서 직접 처리한다.
pub fn build_provider(
    provider_id: &str,
    model_id: String,
    api_key: Option<String>,
) -> Result<Box<dyn LlmProvider>, String> {
    match provider_id {
        "openai" => Ok(Box::new(OpenAiProvider {
            base_url: OPENAI_BASE_URL.to_string(),
            api_key: Some(require_key(provider_id, api_key)?),
            model: model_id,
            structured: StructuredMode::JsonSchema,
        })),
        "ollama" => Ok(Box::new(OpenAiProvider {
            base_url: OLLAMA_BASE_URL.to_string(),
            api_key: None,
            model: model_id,
            structured: StructuredMode::JsonObject,
        })),
        "anthropic" => Ok(Box::new(AnthropicProvider {
            api_key: require_key(provider_id, api_key)?,
            model: model_id,
        })),
        "gemini" => Ok(Box::new(GeminiProvider {
            api_key: require_key(provider_id, api_key)?,
            model: model_id,
        })),
        other => Err(format!("알 수 없는 provider입니다: {}", other)),
    }
}

fn require_key(provider_id: &str, api_key: Option<String>) -> Result<String, String> {
    api_key.filter(|key| !key.is_empty()).ok_or_else(|| {
        format!(
            "'{}' provider의 API 키가 설정되지 않았습니다. 키를 먼저 저장하세요.",
            provider_id
        )
    })
}

/// LLM에 보낼 사용자 메시지(지시 + 문서 컨텍스트)를 구성한다.
pub(crate) fn user_content(req: &LlmRequest) -> String {
    format!(
        "{}\n\n[문서 컨텍스트]\n{}",
        req.user_prompt, req.document_context_json
    )
}

/// 타임아웃이 설정된 공용 reqwest 클라이언트(스펙 7장).
pub(crate) fn http_client() -> Result<reqwest::Client, ProviderError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| ProviderError::Provider(format!("HTTP 클라이언트 생성 실패: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_provider_requires_key_for_cloud_providers() {
        assert!(build_provider("openai", "m".to_string(), None).is_err());
        assert!(build_provider("anthropic", "m".to_string(), Some(String::new())).is_err());
        assert!(build_provider("gemini", "m".to_string(), None).is_err());
    }

    #[test]
    fn build_provider_allows_ollama_without_key() {
        assert!(build_provider("ollama", "llama3".to_string(), None).is_ok());
    }

    #[test]
    fn build_provider_rejects_unknown() {
        assert!(build_provider("bogus", "m".to_string(), Some("k".to_string())).is_err());
    }

    #[test]
    fn user_content_includes_prompt_and_context() {
        let req = LlmRequest {
            system_prompt: "s".to_string(),
            user_prompt: "지시".to_string(),
            document_context_json: "{\"x\":1}".to_string(),
            output_schema: serde_json::json!({}),
        };
        let content = user_content(&req);
        assert!(content.contains("지시"));
        assert!(content.contains("{\"x\":1}"));
    }
}
