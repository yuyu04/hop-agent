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
///
/// `"openai-compat"`은 Groq/OpenRouter/Together/LM Studio/사내 게이트웨이 등
/// 임의의 OpenAI 호환 엔드포인트를 위한 범용 어댑터다(스펙 5.3장). `base_url`은
/// 필수, 키는 선택(로컬 LM Studio 등은 키 불필요).
pub fn build_provider(
    provider_id: &str,
    model_id: String,
    api_key: Option<String>,
    base_url: Option<String>,
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
        "openai-compat" => Ok(Box::new(OpenAiProvider {
            base_url: require_base_url(base_url)?,
            api_key: api_key.filter(|key| !key.is_empty()),
            model: model_id,
            // 호환 게이트웨이는 strict json_schema 미지원이 흔하므로 json_object로 강제.
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

fn require_base_url(base_url: Option<String>) -> Result<String, String> {
    base_url
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
        .ok_or_else(|| {
            "OpenAI 호환 endpoint의 Base URL이 설정되지 않았습니다. \
             예: https://api.groq.com/openai"
                .to_string()
        })
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

/// `data:<mime>;base64,<data>` 형식의 data URL을 만든다(OpenAI image_url 등).
pub(crate) fn image_data_url(image: &crate::ai::provider::ImageInput) -> String {
    format!("data:{};base64,{}", image.mime_type, image.data_base64)
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
        assert!(build_provider("openai", "m".to_string(), None, None).is_err());
        assert!(build_provider("anthropic", "m".to_string(), Some(String::new()), None).is_err());
        assert!(build_provider("gemini", "m".to_string(), None, None).is_err());
    }

    #[test]
    fn build_provider_allows_ollama_without_key() {
        assert!(build_provider("ollama", "llama3".to_string(), None, None).is_ok());
    }

    #[test]
    fn build_provider_rejects_unknown() {
        assert!(build_provider("bogus", "m".to_string(), Some("k".to_string()), None).is_err());
    }

    #[test]
    fn build_provider_openai_compat_requires_base_url() {
        // Base URL 없으면(키만 있어도) 거부.
        assert!(build_provider("openai-compat", "m".to_string(), Some("k".to_string()), None).is_err());
        assert!(build_provider("openai-compat", "m".to_string(), None, Some("  ".to_string())).is_err());
        // Base URL이 있으면 키 없이도(LM Studio 등) 허용.
        assert!(build_provider(
            "openai-compat",
            "llama-3.1-8b-instant".to_string(),
            None,
            Some("https://api.groq.com/openai".to_string()),
        )
        .is_ok());
        // 키 + Base URL(Groq/OpenRouter) 조합도 허용.
        assert!(build_provider(
            "openai-compat",
            "llama-3.1-8b-instant".to_string(),
            Some("gsk_xxx".to_string()),
            Some("https://api.groq.com/openai".to_string()),
        )
        .is_ok());
    }

    #[test]
    fn user_content_includes_prompt_and_context() {
        let req = LlmRequest {
            system_prompt: "s".to_string(),
            user_prompt: "지시".to_string(),
            document_context_json: "{\"x\":1}".to_string(),
            output_schema: serde_json::json!({}),
            images: Vec::new(),
            documents: Vec::new(),
        };
        let content = user_content(&req);
        assert!(content.contains("지시"));
        assert!(content.contains("{\"x\":1}"));
    }
}
