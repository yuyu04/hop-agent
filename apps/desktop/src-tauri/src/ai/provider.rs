//! AI Provider 추상화(스펙 5장).
//!
//! AI 코어는 `LlmProvider` trait만 의존한다. 실제 HTTP 어댑터(Anthropic/OpenAI/
//! Gemini/로컬 모델)는 후속 PR에서 구현하고, PR1은 결정적 동작을 위한
//! `MockProvider` 하나만 둔다. provider는 "원문 JSON 문자열"까지만 책임지며,
//! 화이트리스트·스키마 검증은 provider 바깥(AI 코어, `mod.rs`)에서 수행한다.

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 협조적 취소 토큰. `ai_cancel_request`가 true로 설정한다(스펙 7장).
pub type CancelToken = Arc<AtomicBool>;

/// 스트리밍 부분 응답 싱크. provider가 토큰을 받을 때마다 호출한다.
pub type DeltaSink = Box<dyn Fn(String) + Send + Sync>;

/// provider에 전달하는 단일 편집 요청. 모델 식별자는 provider 자신이 보유한다.
pub struct LlmRequest {
    pub system_prompt: String,
    pub user_prompt: String,
    /// 2장 직렬화 결과(`DocumentContext`)의 JSON 문자열.
    pub document_context_json: String,
    /// 3장 출력 스키마. 네이티브 구조화 출력에 주입한다.
    pub output_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderError {
    Cancelled,
    Timeout,
    Provider(String),
}

impl ProviderError {
    /// 프론트엔드 `hop-ai-edit-failed` 이벤트에 실리는 안정적 코드.
    pub fn code(&self) -> &'static str {
        match self {
            ProviderError::Cancelled => "CANCELLED",
            ProviderError::Timeout => "TIMEOUT",
            ProviderError::Provider(_) => "PROVIDER_ERROR",
        }
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProviderError::Cancelled => write!(f, "요청이 취소되었습니다"),
            ProviderError::Timeout => write!(f, "응답이 시간 내에 도착하지 않았습니다"),
            ProviderError::Provider(message) => write!(f, "{}", message),
        }
    }
}

#[async_trait::async_trait]
pub trait LlmProvider: Send + Sync {
    /// 스트리밍 델타는 `on_delta`로, 최종(미검증) Action Script JSON 문자열은
    /// 반환값으로 전달한다. 취소는 `cancel` 토큰으로 협조적으로 중단한다.
    async fn generate_edit(
        &self,
        req: LlmRequest,
        on_delta: DeltaSink,
        cancel: CancelToken,
    ) -> Result<String, ProviderError>;
}

/// PR1용 목 provider. 외부 호출 없이 결정적인 Action Script를 만든다.
///
/// 문서 컨텍스트의 첫 콘텐츠 ID 뒤에 예시 문단을 삽입하는 스크립트를 반환하여
/// 화이트리스트 통과(편집 준비) 경로를 실증한다. 콘텐츠가 없으면 빈 편집을 낸다.
pub struct MockProvider;

#[async_trait::async_trait]
impl LlmProvider for MockProvider {
    async fn generate_edit(
        &self,
        req: LlmRequest,
        on_delta: DeltaSink,
        cancel: CancelToken,
    ) -> Result<String, ProviderError> {
        let output = mock_action_script_json(&req.document_context_json);

        // 결과를 토막 내 스트리밍하는 것처럼 흉내 낸다. 매 토막마다 취소를 확인.
        for chunk in chunk_chars(&output, 24) {
            if cancel.load(Ordering::Relaxed) {
                return Err(ProviderError::Cancelled);
            }
            on_delta(chunk);
        }
        Ok(output)
    }
}

fn mock_action_script_json(context_json: &str) -> String {
    match first_content_id(context_json) {
        Some(target_id) => json!({
            "edits": [{
                "command": "INSERT_AFTER",
                "target_id": target_id,
                "payload": {
                    "type": "paragraph",
                    "text": "[AI 예시] 이 문단은 Mock provider가 생성했습니다."
                }
            }]
        })
        .to_string(),
        None => json!({ "edits": [] }).to_string(),
    }
}

fn first_content_id(context_json: &str) -> Option<String> {
    let value: Value = serde_json::from_str(context_json).ok()?;
    value
        .get("content")?
        .as_array()?
        .first()?
        .get("id")?
        .as_str()
        .map(str::to_string)
}

fn chunk_chars(text: &str, size: usize) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    chars
        .chunks(size.max(1))
        .map(|chunk| chunk.iter().collect())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn request(context_json: &str) -> LlmRequest {
        LlmRequest {
            system_prompt: "system".to_string(),
            user_prompt: "표를 추가해줘".to_string(),
            document_context_json: context_json.to_string(),
            output_schema: json!({}),
        }
    }

    fn context_with_one_paragraph() -> String {
        json!({
            "document_metadata": { "total_sections": 1 },
            "content": [{ "type": "paragraph", "id": "sec[0].p[0]", "text": "원문" }]
        })
        .to_string()
    }

    #[test]
    fn mock_produces_whitelisted_target_and_streams_deltas() {
        let deltas: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink_deltas = Arc::clone(&deltas);
        let on_delta: DeltaSink = Box::new(move |chunk| sink_deltas.lock().unwrap().push(chunk));
        let cancel: CancelToken = Arc::new(AtomicBool::new(false));

        let output = tauri::async_runtime::block_on(MockProvider.generate_edit(
            request(&context_with_one_paragraph()),
            on_delta,
            cancel,
        ))
        .unwrap();

        assert!(output.contains("sec[0].p[0]"));
        assert!(output.contains("INSERT_AFTER"));
        // 합친 델타가 최종 출력과 같아야 한다.
        let streamed = deltas.lock().unwrap().concat();
        assert_eq!(streamed, output);
    }

    #[test]
    fn mock_returns_empty_edits_when_no_content() {
        let context = json!({ "document_metadata": { "total_sections": 0 }, "content": [] })
            .to_string();
        let on_delta: DeltaSink = Box::new(|_| {});
        let cancel: CancelToken = Arc::new(AtomicBool::new(false));

        let output = tauri::async_runtime::block_on(MockProvider.generate_edit(
            request(&context),
            on_delta,
            cancel,
        ))
        .unwrap();

        assert_eq!(output, json!({ "edits": [] }).to_string());
    }

    #[test]
    fn mock_aborts_when_cancel_token_set() {
        let on_delta: DeltaSink = Box::new(|_| {});
        let cancel: CancelToken = Arc::new(AtomicBool::new(true));

        let result = tauri::async_runtime::block_on(MockProvider.generate_edit(
            request(&context_with_one_paragraph()),
            on_delta,
            cancel,
        ));

        assert_eq!(result, Err(ProviderError::Cancelled));
    }

    #[test]
    fn provider_error_codes_are_stable() {
        assert_eq!(ProviderError::Cancelled.code(), "CANCELLED");
        assert_eq!(ProviderError::Timeout.code(), "TIMEOUT");
        assert_eq!(ProviderError::Provider("x".into()).code(), "PROVIDER_ERROR");
    }
}
