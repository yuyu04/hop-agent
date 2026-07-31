//! provider가 실제로 서비스하는 모델 목록 조회(F-ec1f3481).
//!
//! 모델 ID는 하드코딩하는 순간 낡는다. 사용자가 "claude-opus-5"를 외워서 타이핑하게
//! 하지 않으려면 provider의 list-models 엔드포인트를 직접 물어보는 수밖에 없다.
//! 이 모듈은 provider별로 다른 응답 스키마를 **모델 ID 문자열 목록** 하나로 정규화한다.
//!
//! 키는 네이티브에만 머문다 — 프론트는 provider id만 넘기고 ID 목록만 받는다.

use super::http_client;
use serde_json::Value;

const ANTHROPIC_MODELS_URL: &str = "https://api.anthropic.com/v1/models?limit=100";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const OPENAI_MODELS_URL: &str = "https://api.openai.com/v1/models";
const GEMINI_MODELS_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const OLLAMA_TAGS_URL: &str = "http://localhost:11434/api/tags";

/// 모델 목록 API가 없는 provider — CLI 위임은 별칭(default/opus/…)만 받는다.
pub fn supports_listing(provider_id: &str) -> bool {
    !matches!(
        provider_id,
        "claude-cli" | "agy-cli" | "gemini-cli" | "mock"
    )
}

/// 네트워크를 타기 전에 전제를 검사한다: 목록 API가 있는 provider인가, 키가 필요한데
/// 있는가, openai-compat이면 Base URL이 있는가. 실패 사유는 사용자가 바로 고칠 수
/// 있는 문장으로 돌려준다.
pub fn check_prerequisites(
    provider_id: &str,
    api_key: Option<&str>,
    base_url: Option<&str>,
) -> Result<(), String> {
    if !supports_listing(provider_id) {
        return Err(format!(
            "'{}'는 모델 목록 API가 없습니다(CLI가 받는 별칭만 사용).",
            provider_id
        ));
    }
    match provider_id {
        "anthropic" | "openai" | "gemini" => {
            if api_key.is_none_or(str::is_empty) {
                return Err(format!(
                    "'{}' provider의 API 키가 없습니다. 키를 먼저 저장하면 모델 목록을 불러올 수 있습니다.",
                    provider_id
                ));
            }
        }
        "openai-compat" => {
            if normalized_base(base_url).is_none() {
                return Err(
                    "Base URL이 설정되지 않았습니다. 예: https://api.groq.com/openai".to_string(),
                );
            }
        }
        "ollama" => {}
        other => return Err(format!("알 수 없는 provider입니다: {}", other)),
    }
    Ok(())
}

/// provider의 모델 목록을 조회해 ID만 돌려준다.
pub async fn list_models(
    provider_id: &str,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<Vec<String>, String> {
    check_prerequisites(provider_id, api_key.as_deref(), base_url.as_deref())?;
    let client = http_client().map_err(|e| e.to_string())?;
    let key = api_key.unwrap_or_default();
    let body = match provider_id {
        "anthropic" => {
            get_json(
                client
                    .get(ANTHROPIC_MODELS_URL)
                    .header("x-api-key", key)
                    .header("anthropic-version", ANTHROPIC_VERSION),
            )
            .await?
        }
        "openai" => get_json(client.get(OPENAI_MODELS_URL).bearer_auth(key)).await?,
        "gemini" => {
            get_json(
                client
                    .get(GEMINI_MODELS_URL)
                    .query(&[("key", key.as_str()), ("pageSize", "200")]),
            )
            .await?
        }
        "ollama" => get_json(client.get(OLLAMA_TAGS_URL)).await?,
        // 전제 검사에서 Base URL 존재를 이미 확인했다.
        "openai-compat" => {
            let base = normalized_base(base_url.as_deref()).unwrap_or_default();
            let mut req = client.get(format!("{}/v1/models", base));
            if !key.is_empty() {
                req = req.bearer_auth(key);
            }
            get_json(req).await?
        }
        other => return Err(format!("알 수 없는 provider입니다: {}", other)),
    };

    let models = parse_models(provider_id, &body);
    if models.is_empty() {
        return Err("모델 목록이 비어 있습니다(응답 형식을 해석하지 못했습니다).".to_string());
    }
    Ok(models)
}

/// provider별 응답에서 모델 ID를 뽑는다. 스키마가 셋으로 갈린다:
///  - OpenAI 계열: `{ data: [{ id }] }`
///  - Gemini:      `{ models: [{ name: "models/x", supportedGenerationMethods }] }`
///  - Ollama:      `{ models: [{ name: "llama3.1:latest" }] }`
pub fn parse_models(provider_id: &str, body: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if provider_id == "gemini" {
        for entry in body["models"].as_array().into_iter().flatten() {
            // 생성 계열만 남긴다 — embedding 모델은 편집에 쓸 수 없다.
            let generative = entry["supportedGenerationMethods"]
                .as_array()
                .is_none_or(|list| list.iter().any(|m| m.as_str() == Some("generateContent")));
            if !generative {
                continue;
            }
            if let Some(name) = entry["name"].as_str() {
                out.push(name.trim_start_matches("models/").to_string());
            }
        }
    } else if provider_id == "ollama" {
        for entry in body["models"].as_array().into_iter().flatten() {
            if let Some(name) = entry["name"].as_str() {
                out.push(name.to_string());
            }
        }
    } else {
        for entry in body["data"].as_array().into_iter().flatten() {
            if let Some(id) = entry["id"].as_str() {
                out.push(id.to_string());
            }
        }
    }
    out.retain(|id| !id.is_empty());
    out.sort();
    out.dedup();
    out
}

fn normalized_base(base_url: Option<&str>) -> Option<String> {
    base_url
        .map(|url| url.trim().trim_end_matches('/').to_string())
        .filter(|url| !url.is_empty())
}

async fn get_json(req: reqwest::RequestBuilder) -> Result<Value, String> {
    let res = req
        .send()
        .await
        .map_err(|e| format!("모델 목록 요청 실패: {}", e))?;
    let status = res.status();
    let text = res
        .text()
        .await
        .map_err(|e| format!("모델 목록 응답을 읽지 못했습니다: {}", e))?;
    if !status.is_success() {
        return Err(format!("모델 목록 조회 실패({}): {}", status, brief(&text)));
    }
    serde_json::from_str(&text).map_err(|e| format!("모델 목록 JSON 해석 실패: {}", e))
}

/// 에러 본문은 길 수 있어 앞부분만 보여준다(사용자가 원인을 알 정도로만).
fn brief(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= 200 {
        return trimmed.to_string();
    }
    trimmed.chars().take(200).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cli_providers_have_no_listing_endpoint() {
        assert!(!supports_listing("claude-cli"));
        assert!(!supports_listing("agy-cli"));
        assert!(!supports_listing("gemini-cli"));
        assert!(supports_listing("anthropic"));
        assert!(supports_listing("openai"));
        assert!(supports_listing("ollama"));
    }

    #[test]
    fn cli_provider_is_rejected_before_any_request() {
        let err = check_prerequisites("claude-cli", None, None).unwrap_err();
        assert!(err.contains("모델 목록 API가 없습니다"), "{}", err);
    }

    #[test]
    fn key_providers_report_missing_key() {
        for provider in ["anthropic", "openai", "gemini"] {
            let err = check_prerequisites(provider, None, None).unwrap_err();
            assert!(err.contains("API 키가 없습니다"), "{}: {}", provider, err);
            let err = check_prerequisites(provider, Some(""), None).unwrap_err();
            assert!(err.contains("API 키가 없습니다"), "{}: {}", provider, err);
            assert!(check_prerequisites(provider, Some("sk-x"), None).is_ok());
        }
    }

    #[test]
    fn ollama_needs_neither_key_nor_base_url() {
        assert!(check_prerequisites("ollama", None, None).is_ok());
    }

    #[test]
    fn openai_compat_requires_base_url() {
        let err = check_prerequisites("openai-compat", Some("k"), None).unwrap_err();
        assert!(err.contains("Base URL"), "{}", err);
        assert!(check_prerequisites("openai-compat", Some("k"), Some("   ")).is_err());
        assert!(check_prerequisites("openai-compat", None, Some("https://x/api")).is_ok());
    }

    #[test]
    fn parses_anthropic_and_openai_data_arrays() {
        let body = json!({ "data": [
            { "id": "claude-opus-5", "display_name": "Claude Opus 5" },
            { "id": "claude-haiku-4-5" },
        ]});
        assert_eq!(
            parse_models("anthropic", &body),
            vec!["claude-haiku-4-5", "claude-opus-5"]
        );
        assert_eq!(
            parse_models("openai", &json!({ "data": [{ "id": "gpt-4o-mini" }] })),
            vec!["gpt-4o-mini"]
        );
    }

    #[test]
    fn gemini_strips_prefix_and_drops_non_generative_models() {
        let body = json!({ "models": [
            { "name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"] },
            { "name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"] },
        ]});
        assert_eq!(parse_models("gemini", &body), vec!["gemini-2.5-flash"]);
    }

    #[test]
    fn ollama_keeps_tag_suffix_because_that_is_the_callable_id() {
        let body = json!({ "models": [{ "name": "llama3.1:latest" }] });
        assert_eq!(parse_models("ollama", &body), vec!["llama3.1:latest"]);
    }

    #[test]
    fn unparseable_response_yields_empty_list_not_garbage() {
        assert!(parse_models("openai", &json!({ "oops": 1 })).is_empty());
        assert!(parse_models("gemini", &json!([])).is_empty());
    }

    #[test]
    fn duplicate_ids_collapse() {
        let body = json!({ "data": [{ "id": "a" }, { "id": "a" }, { "id": "b" }] });
        assert_eq!(parse_models("openai", &body), vec!["a", "b"]);
    }
}
