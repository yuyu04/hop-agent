//! AI Agent 인라인 편집 — 네이티브 진입점(스펙 1장).
//!
//! studio-host(TS)와 Tauri IPC로 통신한다. 별도 `window.hopBridge` 전역을 만들지
//! 않고 `#[tauri::command]` + `app.emit` 이벤트로 동작한다. PR1은 직렬화·스키마·
//! 화이트리스트·이벤트 경로를 확립한다. 실제 provider 어댑터와 키 저장은
//! `adapters`/`secrets` 모듈이 담당한다(스펙 5·6장).

pub mod adapters;
pub mod docx;
pub mod provider;
pub mod schema;
pub mod secrets;
pub mod serialize;

pub use secrets::{ai_delete_api_key, ai_has_api_key, ai_set_api_key};

use crate::state::AppState;
use provider::{CancelToken, DeltaSink, ImageInput, LlmProvider, LlmRequest, MockProvider};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

/// 진행 중인 AI 요청의 취소 토큰(스펙 7장)과 민감 문서 표시(스펙 6장)를 보관한다.
#[derive(Default)]
pub struct AiState {
    requests: Mutex<HashMap<String, CancelToken>>,
    /// 외부 provider 전송을 차단할 민감(기밀) 문서 doc_id 집합.
    sensitive_docs: Mutex<HashSet<String>>,
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

    fn set_sensitive(&self, doc_id: String, sensitive: bool) {
        if let Ok(mut docs) = self.sensitive_docs.lock() {
            if sensitive {
                docs.insert(doc_id);
            } else {
                docs.remove(&doc_id);
            }
        }
    }

    fn is_sensitive(&self, doc_id: &str) -> bool {
        self.sensitive_docs
            .lock()
            .map(|docs| docs.contains(doc_id))
            .unwrap_or(false)
    }
}

/// 민감 문서에서도 허용되는 provider — 문서 본문이 외부로 나가지 않는 것만(스펙 6장).
/// in-process `mock`과 로컬 `ollama`(localhost)만 로컬로 간주한다.
fn is_local_provider(provider_id: &str) -> bool {
    matches!(provider_id, "mock" | "ollama")
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
    cursor_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<serialize::DocumentContext, String> {
    let cursor = cursor_path.as_deref().and_then(serialize::parse_cursor_path);
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "문서 세션 잠금 실패".to_string())?;
    let core = sessions.session_mut(&doc_id)?.ensure_core_loaded()?;
    let (context, _whitelist) =
        serialize::build_windowed_context(core, cursor, current_selection_only)?;
    Ok(context)
}

/// 편집 요청을 시작한다. `request_id`를 즉시 반환하고 결과는 이벤트로 보낸다.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri 커맨드 인자(provider/model/cursor/base_url 등)는 평면 전달이 필요.
pub fn ai_request_edit(
    app: AppHandle,
    doc_id: String,
    user_prompt: String,
    provider_id: String,
    model_id: String,
    cursor_path: Option<String>,
    base_url: Option<String>,
    images: Option<Vec<ImageInput>>,
    documents: Option<Vec<ImageInput>>,
    file_paths: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // 민감 문서는 외부 provider 전송을 차단한다(스펙 6장 — 공문서 보호).
    if state.ai.is_sensitive(&doc_id) && !is_local_provider(&provider_id) {
        return Err("민감 문서로 표시되어 외부 AI 제공자 전송이 차단되었습니다. \
                    로컬 모델(ollama) 또는 mock만 사용할 수 있습니다."
            .to_string());
    }

    let provider = select_provider(&provider_id, model_id, base_url)?;
    let cursor = cursor_path.as_deref().and_then(serialize::parse_cursor_path);

    // 문서 컨텍스트와 화이트리스트는 세션 잠금이 필요하므로 spawn 전에 만든다.
    // Sliding Window(스펙 4장)로 화이트리스트가 좁혀지면 LLM은 윈도우 밖 문단을
    // 편집 대상으로 삼을 수 없다(7장 검증과 일관).
    let (context_json, whitelist) = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "문서 세션 잠금 실패".to_string())?;
        let core = sessions.session_mut(&doc_id)?.ensure_core_loaded()?;
        let (context, whitelist) = serialize::build_windowed_context(core, cursor, false)?;
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
        images: images.unwrap_or_default(),
        documents: documents.unwrap_or_default(),
        file_paths: file_paths.unwrap_or_default(),
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

/// 문서를 민감(기밀)으로 표시/해제한다(스펙 6장). 표시된 문서는 `ai_request_edit`에서
/// 외부 provider(Anthropic/OpenAI/Gemini 등) 전송이 차단되고 로컬 모델만 허용된다.
#[tauri::command]
pub fn ai_set_document_sensitivity(
    doc_id: String,
    sensitive: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.ai.set_sensitive(doc_id, sensitive);
    Ok(())
}

/// 첨부용 — 한글(HWP/HWPX)·워드(DOCX) 파일에서 평문 텍스트를 추출한다. 열린
/// 문서와 무관하게 임의 경로의 파일을 파싱하므로, 사용자가 끌어다 놓은 문서를
/// 프롬프트 컨텍스트로 인라인할 수 있다. PDF는 추출 대신 문서 첨부로 보낸다.
#[tauri::command]
pub fn ai_extract_text(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("파일을 읽을 수 없습니다: {}", e))?;
    let lower = path.to_lowercase();
    if lower.ends_with(".docx") {
        return docx::extract_docx_text(&bytes);
    }
    if lower.ends_with(".hwp") || lower.ends_with(".hwpx") {
        let core = crate::state::editable_core_from_bytes(
            &bytes,
            "문서 파싱 실패",
            "편집 가능 문서 변환 실패",
        )?;
        return serialize::extract_all_text(&core);
    }
    Err("HWP/HWPX/DOCX 파일만 텍스트 추출을 지원합니다.".to_string())
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
        // 원문(raw)은 설명 문장에 둘러싸였을 수 있으므로, 파싱된 스크립트를 다시
        // 정규 JSON으로 직렬화해 보낸다. 프론트의 단순 JSON.parse가 항상 통과한다.
        let canonical = serde_json::to_string(&script).unwrap_or_else(|_| raw.to_string());
        let _ = app.emit(
            "hop-ai-edit-ready",
            AiEditReady {
                request_id: request_id.to_string(),
                action_script_json: canonical,
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

fn select_provider(
    provider_id: &str,
    model_id: String,
    base_url: Option<String>,
) -> Result<Box<dyn LlmProvider>, String> {
    if provider_id == "mock" {
        return Ok(Box::new(MockProvider));
    }
    // 키가 필요한 provider는 보안 저장소에서 키를 읽어 어댑터를 만든다.
    // `base_url`은 openai-compat(커스텀 OpenAI 호환 엔드포인트)에서만 쓰인다.
    let api_key = secrets::get_api_key(provider_id)?;
    adapters::build_provider(provider_id, model_id, api_key, base_url)
}

fn system_prompt() -> String {
    "당신은 한글(HWP) 문서를 편집하는 보조자입니다. \
     반드시 제공된 JSON Schema를 만족하는 Action Script JSON만 출력하세요. \
     각 편집의 target_id는 입력 문서 컨텍스트에 존재하는 ID여야 합니다. \
     REPLACE·INSERT_BEFORE·INSERT_AFTER 명령은 payload.text에 새 문단의 전체 \
     텍스트를 반드시 채워야 합니다. text가 비어 있으면 안 됩니다. 내용을 비우려는 \
     경우에만 DELETE를 쓰세요. \
     표 셀은 `sec[s].p[p].tbl[c].cell[k].p[i]` 형식의 ID로 제공됩니다. 표 안의 값을 \
     바꿀 때는 그 셀 ID로 REPLACE, 셀 안에 내용을 새로 추가할 때는 그 셀 ID로 \
     INSERT_BEFORE/INSERT_AFTER를 쓰세요. \
     긴 새 내용(예: 사업계획서 본문, 새 절)을 추가할 때는 기존 표를 줄이지 말고, \
     문서의 마지막 본문 문단 ID에 INSERT_AFTER로 문단을 여러 개 추가하세요. \
     각 문단은 별도의 edit으로 INSERT_AFTER 하고, 새 페이지에서 시작해야 하면 \
     payload.page_break를 true로 설정하세요. \
     표를 새로 만들려면 본문 문단 ID에 INSERT_AFTER 하고 payload.type=\"table\", \
     payload.table_data에 rows, cols, matrix(행×열 문자열 2차원 배열)를 채우세요. \
     예: 예산 표는 첫 행을 머리글로 두고 matrix에 값을 넣습니다. \
     문서가 양식/템플릿(라벨 칸 + 빈 입력 칸으로 된 표)인 경우: '사 업 명', '과 제 명' \
     같은 라벨 셀은 그대로 두고, 그 옆/아래의 빈 셀(텍스트가 비어 있는 셀)을 요청 내용으로 \
     REPLACE 하여 채우세요. 라벨과 표 구조를 바꾸지 말고 기존 서식을 유지하세요. \
     비어 있지 않은 셀은 사용자가 바꿔 달라고 한 경우에만 수정하세요. \
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
        assert!(select_provider("mock", "mock-1".to_string(), None).is_ok());
    }

    #[test]
    fn only_mock_and_ollama_are_local_providers() {
        assert!(is_local_provider("mock"));
        assert!(is_local_provider("ollama"));
        assert!(!is_local_provider("openai"));
        assert!(!is_local_provider("anthropic"));
        assert!(!is_local_provider("gemini"));
        assert!(!is_local_provider("gateway"));
    }

    #[test]
    fn sensitive_docs_can_be_marked_and_cleared() {
        let state = AiState::default();
        assert!(!state.is_sensitive("doc-1"));

        state.set_sensitive("doc-1".to_string(), true);
        assert!(state.is_sensitive("doc-1"));
        assert!(!state.is_sensitive("doc-2"));

        state.set_sensitive("doc-1".to_string(), false);
        assert!(!state.is_sensitive("doc-1"));
    }

    #[test]
    fn system_prompt_guides_form_filling() {
        let prompt = system_prompt();
        assert!(prompt.contains("양식/템플릿"));
        assert!(prompt.contains("라벨"));
        assert!(prompt.contains("빈 셀"));
    }
}
