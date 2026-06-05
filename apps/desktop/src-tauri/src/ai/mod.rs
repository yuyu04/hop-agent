//! AI Agent 인라인 편집 — 네이티브 진입점(스펙 1장).
//!
//! studio-host(TS)와 Tauri IPC로 통신한다. 별도 `window.hopBridge` 전역을 만들지
//! 않고 `#[tauri::command]` + `app.emit` 이벤트로 동작한다. PR1은 직렬화·스키마·
//! 화이트리스트·이벤트 경로를 확립한다. 실제 provider 어댑터와 키 저장은
//! `adapters`/`secrets` 모듈이 담당한다(스펙 5·6장).

pub mod adapters;
pub mod provider;
pub mod schema;
pub mod secrets;
pub mod serialize;

pub use secrets::{ai_delete_api_key, ai_has_api_key, ai_set_api_key};

use crate::state::AppState;
use provider::{CancelToken, DeltaSink, LlmProvider, LlmRequest, MockProvider};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

/// 진행 중인 AI 요청의 취소 토큰을 보관한다(스펙 7장).
#[derive(Default)]
pub struct AiState {
    requests: Mutex<HashMap<String, CancelToken>>,
}

impl AiState {
    fn register(&self, request_id: String) -> CancelToken {
        let token: CancelToken = Arc::new(AtomicBool::new(false));
        if let Ok(mut requests) = self.requests.lock() {
            requests.insert(request_id, Arc::clone(&token));
        }
        token
    }

    fn cancel(&self, request_id: &str) {
        if let Ok(requests) = self.requests.lock() {
            if let Some(token) = requests.get(request_id) {
                token.store(true, Ordering::Relaxed);
            }
        }
    }

    fn remove(&self, request_id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(request_id);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiStreamDelta {
    request_id: String,
    partial_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiEditReady {
    request_id: String,
    action_script_json: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiEditFailed {
    request_id: String,
    reason: String,
    code: String,
}

/// 현재 문서를 직렬화해 LLM 피딩용 컨텍스트를 반환한다(스펙 2장).
///
/// `current_selection_only`(Sliding Window)는 후속 PR에서 적용한다.
#[tauri::command]
pub fn ai_get_document_context(
    doc_id: String,
    current_selection_only: bool,
    state: State<'_, AppState>,
) -> Result<serialize::DocumentContext, String> {
    let _ = current_selection_only;
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "문서 세션 잠금 실패".to_string())?;
    let core = sessions.session_mut(&doc_id)?.ensure_core_loaded()?;
    let (context, _whitelist) = serialize::build_document_context(core)?;
    Ok(context)
}

/// 편집 요청을 시작한다. `request_id`를 즉시 반환하고 결과는 이벤트로 보낸다.
#[tauri::command]
pub fn ai_request_edit(
    app: AppHandle,
    doc_id: String,
    user_prompt: String,
    provider_id: String,
    model_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let provider = select_provider(&provider_id, model_id)?;

    // 문서 컨텍스트와 화이트리스트는 세션 잠금이 필요하므로 spawn 전에 만든다.
    let (context_json, whitelist) = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "문서 세션 잠금 실패".to_string())?;
        let core = sessions.session_mut(&doc_id)?.ensure_core_loaded()?;
        let (context, whitelist) = serialize::build_document_context(core)?;
        let json = serde_json::to_string(&context)
            .map_err(|e| format!("문서 컨텍스트 직렬화 실패: {}", e))?;
        (json, whitelist)
    };

    let request_id = Uuid::new_v4().to_string();
    let cancel = state.ai.register(request_id.clone());

    let req = LlmRequest {
        system_prompt: system_prompt(),
        user_prompt,
        document_context_json: context_json,
        output_schema: schema::action_script_schema(),
    };

    tauri::async_runtime::spawn(run_edit_request(
        app,
        request_id.clone(),
        provider,
        req,
        whitelist,
        cancel,
    ));

    Ok(request_id)
}

/// 진행 중 요청을 취소한다(스펙 7장).
#[tauri::command]
pub fn ai_cancel_request(request_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.ai.cancel(&request_id);
    Ok(())
}

async fn run_edit_request(
    app: AppHandle,
    request_id: String,
    provider: Box<dyn LlmProvider>,
    req: LlmRequest,
    whitelist: std::collections::HashSet<String>,
    cancel: CancelToken,
) {
    let on_delta: DeltaSink = {
        let app = app.clone();
        let request_id = request_id.clone();
        Box::new(move |partial_text| {
            let _ = app.emit(
                "hop-ai-stream-delta",
                AiStreamDelta {
                    request_id: request_id.clone(),
                    partial_text,
                },
            );
        })
    };

    match provider.generate_edit(req, on_delta, cancel).await {
        Ok(raw) => emit_validated(&app, &request_id, &raw, &whitelist),
        Err(error) => emit_failed(&app, &request_id, error.to_string(), error.code()),
    }

    // 트랜잭션 종료/취소 시 화이트리스트(취소 토큰)를 정리한다.
    app.state::<AppState>().ai.remove(&request_id);
}

fn emit_validated(
    app: &AppHandle,
    request_id: &str,
    raw: &str,
    whitelist: &std::collections::HashSet<String>,
) {
    let script = match schema::parse_action_script(raw) {
        Ok(script) => script,
        Err(message) => {
            emit_failed(app, request_id, message, "PARSE_ERROR");
            return;
        }
    };

    let violations = schema::collect_violations(&script, whitelist);
    if violations.is_empty() {
        let _ = app.emit(
            "hop-ai-edit-ready",
            AiEditReady {
                request_id: request_id.to_string(),
                action_script_json: raw.to_string(),
            },
        );
    } else {
        emit_failed(
            app,
            request_id,
            format!("문서에 존재하지 않는 대상입니다: {}", violations.join(", ")),
            "WHITELIST_VIOLATION",
        );
    }
}

fn emit_failed(app: &AppHandle, request_id: &str, reason: String, code: &str) {
    let _ = app.emit(
        "hop-ai-edit-failed",
        AiEditFailed {
            request_id: request_id.to_string(),
            reason,
            code: code.to_string(),
        },
    );
}

fn select_provider(provider_id: &str, model_id: String) -> Result<Box<dyn LlmProvider>, String> {
    if provider_id == "mock" {
        return Ok(Box::new(MockProvider));
    }
    // 키가 필요한 provider는 보안 저장소에서 키를 읽어 어댑터를 만든다.
    let api_key = secrets::get_api_key(provider_id)?;
    adapters::build_provider(provider_id, model_id, api_key)
}

fn system_prompt() -> String {
    "당신은 한글(HWP) 문서를 편집하는 보조자입니다. \
     반드시 제공된 JSON Schema를 만족하는 Action Script JSON만 출력하세요. \
     각 편집의 target_id는 입력 문서 컨텍스트에 존재하는 ID여야 합니다. \
     설명 문장이나 Markdown 없이 JSON만 반환하세요."
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_state_register_cancel_remove() {
        let state = AiState::default();
        let token = state.register("req-1".to_string());
        assert!(!token.load(Ordering::Relaxed));

        state.cancel("req-1");
        assert!(token.load(Ordering::Relaxed));

        state.remove("req-1");
        // 제거 후 취소는 무해해야 한다(패닉 없음).
        state.cancel("req-1");
    }

    #[test]
    fn select_provider_accepts_mock() {
        // 실제 provider는 보안 저장소를 거치므로(OS 의존) 여기서는 mock만 검증한다.
        // provider 분기/키 요구는 adapters::build_provider 테스트가 담당한다.
        assert!(select_provider("mock", "mock-1".to_string()).is_ok());
    }
}
