//! AI Agent 인라인 편집 — 네이티브 진입점(스펙 1장).
//!
//! studio-host(TS)와 Tauri IPC로 통신한다. 별도 `window.hopBridge` 전역을 만들지
//! 않고 `#[tauri::command]` + `app.emit` 이벤트로 동작한다. PR1은 직렬화·스키마·
//! 화이트리스트·이벤트 경로를 확립한다. 실제 provider 어댑터와 키 저장은
//! `adapters`/`secrets` 모듈이 담당한다(스펙 5·6장).

pub mod adapters;
pub mod docx;
#[cfg(test)]
mod live_smoke;
pub mod pdf_figures;
pub mod pdf_images;
pub mod pdf_pages;
pub mod pdf_pdfium;
#[cfg(target_os = "macos")]
pub mod pdf_render;
pub mod pdf_structure;
pub mod provider;
pub mod schema;
pub mod secrets;
pub mod serialize;
pub mod skills;
pub mod themes;

pub use secrets::{ai_delete_api_key, ai_has_api_key, ai_set_api_key};
pub use skills::{ai_list_skills, ai_open_skills_dir};
pub use themes::{ai_list_themes, ai_open_themes_dir};

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

/// AI 동기화용 임시 파일 이름 접두사. 프론트가 넘긴 경로가 우리가 만든 것인지 확인한다.
const AI_SYNC_PREFIX: &str = "hop-ai-sync-";

/// 프론트(WASM) 문서를 네이티브 세션에 넘길 임시 파일 경로를 만든다.
///
/// 문서 바이트는 IPC JSON으로 보내기엔 커서(수 MB), 저장과 같은 방식으로 파일을 거친다.
#[tauri::command]
pub fn ai_prepare_document_sync(app: AppHandle) -> Result<String, String> {
    let path = std::env::temp_dir().join(format!("{}{}.hwp", AI_SYNC_PREFIX, Uuid::new_v4()));
    crate::commands::allow_frontend_fs_file(&app, &path)?;
    Ok(path.to_string_lossy().to_string())
}

/// 프론트가 내보낸 현재 문서로 네이티브 세션 코어를 바꾼다(컨텍스트·화이트리스트의 원천).
///
/// 이게 없으면 AI는 마지막으로 열거나 저장한 시점의 문서를 본다 — 저장 전 새 문서에서
/// "표 하나 더"를 요청하면 방금 만든 내용을 모른 채 엉뚱한 위치를 겨눈다.
#[tauri::command]
pub fn ai_sync_document(
    doc_id: String,
    staged_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = std::path::PathBuf::from(&staged_path);
    let bytes = read_ai_sync_file(&path)?;
    sync_session_core(&state.sessions, &doc_id, &bytes)
}

fn read_ai_sync_file(path: &std::path::Path) -> Result<Vec<u8>, String> {
    let ours = path.parent() == Some(std::env::temp_dir().as_path())
        && path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(AI_SYNC_PREFIX) && name.ends_with(".hwp"));
    if !ours {
        return Err("AI 동기화 경로가 올바르지 않습니다".to_string());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("AI 동기화 파일을 읽지 못했습니다: {}", e));
    let _ = std::fs::remove_file(path);
    bytes
}

/// 바이트를 편집 가능 코어로 파싱해(잠금 밖에서) 세션 코어를 교체한다.
pub(crate) fn sync_session_core(
    sessions: &Mutex<crate::state::DocumentSessionManager>,
    doc_id: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let core = crate::state::editable_core_from_bytes(
        bytes,
        "AI 동기화: 문서 파싱 실패",
        "AI 동기화: 편집 가능 문서 변환 실패",
    )?;
    sessions
        .lock()
        .map_err(|_| "문서 세션 잠금 실패".to_string())?
        .session_mut(doc_id)?
        .replace_core_from_frontend(core);
    Ok(())
}

/// 현재 문서를 직렬화해 LLM 피딩용 컨텍스트를 반환한다(스펙 2장).
///
/// `current_selection_only`(Sliding Window)는 후속 PR에서 적용한다.
#[tauri::command]
pub fn ai_get_document_context(
    doc_id: String,
    current_selection_only: bool,
    cursor_path: Option<String>,
    full_document: Option<bool>,
    state: State<'_, AppState>,
) -> Result<serialize::DocumentContext, String> {
    let cursor = cursor_path.as_deref().and_then(serialize::parse_cursor_path);
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "문서 세션 잠금 실패".to_string())?;
    let core = sessions.session_mut(&doc_id)?.ensure_core_loaded()?;
    // full_document=true(교정 패스 등 전수 스캔)는 Sliding Window를 우회한다 —
    // 호출 측이 노드를 구간으로 나눠 ai_request_edit의 target_ids로 스코프 요청한다.
    let (context, _whitelist) = if full_document.unwrap_or(false) {
        serialize::build_full_context(core)?
    } else {
        serialize::build_windowed_context(core, cursor, current_selection_only)?
    };
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
    target_ids: Option<Vec<String>>,
    // Some(labels)이면 '양식 이어쓰기' 모드(F-ae778890): AI가 표를 그리지 않고 항목 내용
    // 리스트만 반환하도록 전용 시스템 프롬프트·스키마를 쓰고, 응답을 form-fill로 검증한다.
    // labels는 소스 양식 표의 필드 라벨(모델이 내용을 라벨로 키잉하게).
    form_fill_labels: Option<Vec<String>>,
    // true면 긴 문서 분할 작성의 '개요' 요청(F-866a1c71): 제목·절 목록만 받는다.
    outline: Option<bool>,
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
        // target_ids가 있으면(구간 교정 등) 그 ID들만 직렬화·허용한다(스코프 요청).
        let scope: Option<std::collections::HashSet<String>> = target_ids
            .filter(|ids| !ids.is_empty())
            .map(|ids| ids.into_iter().collect());
        let (context, whitelist) = match &scope {
            Some(ids) => serialize::build_scoped_context(core, ids)?,
            None => serialize::build_windowed_context(core, cursor, false)?,
        };
        let json = serde_json::to_string(&context)
            .map_err(|e| format!("문서 컨텍스트 직렬화 실패: {}", e))?;
        (json, whitelist)
    };

    let request_id = Uuid::new_v4().to_string();
    let cancel = state.ai.register(request_id.clone());

    // 양식 이어쓰기 모드면 전용 프롬프트·스키마를 쓰고 응답을 form-fill로 검증한다.
    // 그 외(일반 편집/질문/교정)는 기존 Action Script 경로 그대로.
    let (sys_prompt, out_schema, mode) = match (&form_fill_labels, outline.unwrap_or(false)) {
        (Some(labels), _) => (
            form_fill_system_prompt(labels),
            schema::form_fill_schema(),
            RequestMode::FormFill,
        ),
        (None, true) => (outline_system_prompt(), schema::outline_schema(), RequestMode::Outline),
        (None, false) => (system_prompt(), schema::action_script_schema(), RequestMode::Edit),
    };

    let req = LlmRequest {
        system_prompt: sys_prompt,
        user_prompt,
        document_context_json: context_json,
        output_schema: out_schema,
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
        mode,
    ));

    Ok(request_id)
}

/// 진행 중 요청을 취소한다(스펙 7장).
#[tauri::command]
pub fn ai_cancel_request(request_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.ai.cancel(&request_id);
    Ok(())
}

/// provider가 지금 서비스하는 모델 ID 목록을 조회한다(F-ec1f3481).
///
/// 하드코딩 목록은 릴리스마다 낡으므로, 사용자가 정확한 모델 ID를 외워 타이핑하지
/// 않도록 provider의 list-models 엔드포인트를 그대로 물어본다. 키는 보안 저장소에서
/// 읽어 네이티브 안에서만 쓰고, 프론트에는 ID 문자열만 돌려준다.
#[tauri::command]
pub async fn ai_list_models(
    provider_id: String,
    base_url: Option<String>,
) -> Result<Vec<String>, String> {
    let api_key = secrets::get_api_key(&provider_id)?;
    adapters::models::list_models(&provider_id, api_key, base_url).await
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

/// 첨부 텍스트 상한(자). 너무 큰 문서를 통째로 인라인하면 토큰 한도를 넘고
/// 응답이 느려지므로 앞부분만 자른다.
const MAX_ATTACH_CHARS: usize = 120_000;

/// 첨부용 — PDF·한글(HWP/HWPX)·워드(DOCX) 파일에서 평문 텍스트를 추출한다. 열린
/// 문서와 무관하게 임의 경로의 파일을 파싱하므로, 사용자가 끌어다 놓은 문서를
/// 프롬프트 컨텍스트로 인라인할 수 있다(모든 provider에서 동작).
///
/// 파싱은 CPU 부하가 크므로(특히 PDF) blocking 풀에서 실행해 UI/IPC를 막지 않는다.
#[tauri::command]
pub async fn ai_extract_text(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || extract_text_blocking(&path))
        .await
        .map_err(|e| format!("문서 분석 태스크 실패: {}", e))?
}

fn extract_text_blocking(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("파일을 읽을 수 없습니다: {}", e))?;
    let lower = path.to_lowercase();
    let text = if lower.ends_with(".pdf") {
        pdf_extract::extract_text_from_mem(&bytes)
            .map_err(|e| format!("PDF 텍스트 추출 실패: {}", e))?
    } else if lower.ends_with(".docx") {
        docx::extract_docx_text(&bytes)?
    } else if lower.ends_with(".hwp") || lower.ends_with(".hwpx") {
        let core = crate::state::editable_core_from_bytes(
            &bytes,
            "문서 파싱 실패",
            "편집 가능 문서 변환 실패",
        )?;
        serialize::extract_all_text(&core)?
    } else {
        return Err("PDF/HWP/HWPX/DOCX 파일만 텍스트 추출을 지원합니다.".to_string());
    };
    Ok(truncate_chars(text, MAX_ATTACH_CHARS))
}

/// 연구노트형 docx를 구조(항목 + 목차)로 파싱해 JSON으로 반환한다(F-beb35fbb).
/// docx→HWP 일괄 변환의 결정적 경로: 내용은 여기서 추출되고 LLM은 관여하지 않는다.
/// 항목을 못 찾으면 parse_docx_structure가 사유와 함께 Err를 반환한다(빈 결과 위장 금지).
#[tauri::command]
pub async fn ai_parse_research_note_docx(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&path).map_err(|e| format!("파일을 읽을 수 없습니다: {}", e))?;
        let doc = docx::parse_docx_structure(&bytes)?;
        serde_json::to_string(&doc).map_err(|e| format!("연구노트 구조 직렬화 실패: {}", e))
    })
    .await
    .map_err(|e| format!("docx 구조 파싱 태스크 실패: {}", e))?
}

/// 연구노트형 PDF를 구조(항목 + 목차)로 파싱해 JSON으로 반환한다(docx와 동일 스키마).
/// PDF에는 표 구조가 없어 추출 텍스트의 줄 패턴으로 항목 경계를 복원하고, 표·그림은 해당
/// 페이지를 렌더해 그 영역만 잘라 항목에 인라인 이미지로 붙인다(스크린샷 방식, pdf_figures).
/// 항목을 못 찾으면 사유와 함께 Err — 호출 측이 LLM 경로로 폴백한다.
#[tauri::command]
pub async fn ai_parse_research_note_pdf(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let doc = pdf_structure::parse_pdf_structure_with_figures(&path)?;
        serde_json::to_string(&doc).map_err(|e| format!("연구노트 구조 직렬화 실패: {}", e))
    })
    .await
    .map_err(|e| format!("PDF 구조 파싱 태스크 실패: {}", e))?
}

/// 다운로드 이미지 최대 크기(바이트). 너무 큰 이미지는 거절한다.
const MAX_IMAGE_BYTES: usize = 20 * 1024 * 1024;

/// URL에서 이미지를 내려받아 base64+MIME로 반환한다(웹뷰 CORS 우회 — Rust에서 받음).
/// 반환: JSON `{"dataBase64":"...","mime":"image/..."}`. 이미지가 아니면 오류.
#[tauri::command]
pub async fn ai_fetch_image(url: String) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("http(s) URL만 가져올 수 있습니다.".to_string());
    }
    let client = crate::ai::adapters::http_client().map_err(|e| e.to_string())?;
    // 일부 CDN(나무위키 등)은 User-Agent/Referer 없는 요청을 막으므로 브라우저처럼 보낸다.
    let resp = client
        .get(&url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        )
        .header(reqwest::header::ACCEPT, "image/avif,image/webp,image/*,*/*")
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| format!("이미지 다운로드 실패: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("이미지 다운로드 실패: HTTP {}", resp.status()));
    }
    // Content-Type으로 이미지 여부 확인(확장자 없는 URL도 처리).
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or(s).trim().to_string())
        .unwrap_or_default();
    if !mime.starts_with("image/") {
        return Err(format!("이미지가 아닙니다(Content-Type: {}).", mime));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("이미지 본문 읽기 실패: {}", e))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("이미지가 너무 큽니다(최대 20MB).".to_string());
    }
    let data_base64 = STANDARD.encode(&bytes);
    Ok(format!(
        "{{\"dataBase64\":{},\"mime\":{}}}",
        serde_json::to_string(&data_base64).unwrap_or_default(),
        serde_json::to_string(&mime).unwrap_or_default()
    ))
}

/// 추출할 PDF 이미지 최대 개수(너무 많은 이미지로 토큰/메모리가 폭주하지 않도록).
const MAX_PDF_IMAGES: usize = 20;

/// PDF에서 내장 이미지를 추출해 base64+MIME 목록(JSON)으로 반환한다.
/// 반환: JSON `[{"dataBase64":"...","mime":"image/..."}, ...]`.
#[tauri::command]
pub async fn ai_extract_pdf_images(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || extract_pdf_images_blocking(&path))
        .await
        .map_err(|e| format!("PDF 이미지 추출 태스크 실패: {}", e))?
}

fn extract_pdf_images_blocking(path: &str) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    if !path.to_lowercase().ends_with(".pdf") {
        return Err("PDF 파일만 이미지 추출을 지원합니다.".to_string());
    }
    let bytes = std::fs::read(path).map_err(|e| format!("파일을 읽을 수 없습니다: {}", e))?;
    let images = pdf_images::extract_pdf_images(&bytes)?;
    let items: Vec<String> = images
        .into_iter()
        .take(MAX_PDF_IMAGES)
        .map(|img| {
            format!(
                "{{\"dataBase64\":{},\"mime\":{}}}",
                serde_json::to_string(&STANDARD.encode(&img.data)).unwrap_or_default(),
                serde_json::to_string(&img.mime).unwrap_or_default()
            )
        })
        .collect();
    Ok(format!("[{}]", items.join(",")))
}

/// PDF에서 쿼리(요청)와 관련 있는 페이지들을 렌더해 base64 PNG 목록(JSON)으로 반환한다.
/// 벡터/블렌드 그래프는 개별 추출이 안 되므로, 페이지를 통째로 렌더해 AI가 그림 영역을
/// 직접 잘라내도록 한다(crop). macOS=CoreGraphics(그림 영역 구조적 분리 포함),
/// 그 외=pdfium 동적 로딩(라이브러리 없으면 빈 목록 — F-4e2261).
/// 반환: `[{"dataBase64","mime","page","figureOnly"}]`.
#[tauri::command]
pub async fn ai_render_pdf_figure_pages(path: String, query: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || render_figure_pages_blocking(&path, &query))
        .await
        .map_err(|e| format!("PDF 페이지 렌더 태스크 실패: {}", e))?
}

fn render_figure_pages_blocking(path: &str, query: &str) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    if !path.to_lowercase().ends_with(".pdf") {
        return Err("PDF 파일만 지원합니다.".to_string());
    }
    // macOS: 구조적 분리 — 가능하면 그림 영역만(텍스트 제외) 잘라 보낸다(figure_only=true).
    #[cfg(target_os = "macos")]
    let pages = pdf_render::render_query_figures(path, query, 2.0, 4);
    // 그 외: pdfium으로 페이지 전체 렌더(AI가 crop으로 그림만 잘라냄). 라이브러리가
    // 없으면 빈 목록을 반환해 세션을 중단하지 않는다(AC3).
    #[cfg(not(target_os = "macos"))]
    let pages = pdf_pdfium::render_query_pages_pdfium(path, query, 2.0, 4);

    let mut items = Vec::new();
    for (page, figure_only, img) in pages {
        let mut png = Vec::new();
        if image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .is_ok()
        {
            items.push(format!(
                "{{\"dataBase64\":{},\"mime\":\"image/png\",\"page\":{},\"figureOnly\":{}}}",
                serde_json::to_string(&STANDARD.encode(&png)).unwrap_or_default(),
                page,
                figure_only
            ));
        }
    }
    Ok(format!("[{}]", items.join(",")))
}

/// 앞 `max`자만 남기고 잘라낸 뒤 안내 꼬리표를 붙인다.
fn truncate_chars(text: String, max: usize) -> String {
    if text.chars().count() <= max {
        return text;
    }
    let head: String = text.chars().take(max).collect();
    format!("{}\n\n…(문서가 길어 앞부분만 첨부됨)", head)
}

/// 요청 모드 — 응답을 어떤 스키마로 검증해 어떤 이벤트로 보낼지 결정한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RequestMode {
    /// 일반 편집/질문/교정 — Action Script로 파싱·화이트리스트 검증.
    Edit,
    /// 양식 이어쓰기(F-ae778890) — 내용 전용 form-fill JSON으로 파싱(표/compose 없음).
    FormFill,
    /// 긴 문서 분할 작성의 개요(F-866a1c71) — 제목·절 목록 JSON으로 파싱(본문 없음).
    Outline,
}

async fn run_edit_request(
    app: AppHandle,
    request_id: String,
    provider: Box<dyn LlmProvider>,
    req: LlmRequest,
    whitelist: std::collections::HashSet<String>,
    cancel: CancelToken,
    mode: RequestMode,
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
        Ok(raw) => match mode {
            RequestMode::Edit => emit_validated(&app, &request_id, &raw, &whitelist),
            RequestMode::FormFill => emit_form_fill(&app, &request_id, &raw),
            RequestMode::Outline => emit_outline(&app, &request_id, &raw),
        },
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
    match validate_edit_response(raw, whitelist) {
        Ok(script) => {
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
        }
        Err((message, code)) => emit_failed(app, request_id, message, code),
    }
}

/// 편집 응답을 편집 단위로 검증한다(스펙 7장 4항 — '해당 항목만 스킵' 정책).
///
/// 형식이 틀린 편집과 화이트리스트 밖 대상을 겨눈 편집은 그것만 버리고 나머지를
/// 미리보기로 보낸다 — 새 문서에서 아직 없는 ID를 하나 겨눴다고 100개 편집을 전부 잃지
/// 않게. 버린 건수는 message 끝에 안내한다. 다만 편집 대부분(과반)이 존재하지 않는 대상을
/// 겨눴다면 모델이 문서를 잘못 본 것이므로 안전하게 전체를 거부한다. 승인 전 미리보기
/// 단계가 있어 사용자가 최종 확인한다.
fn validate_edit_response(
    raw: &str,
    whitelist: &std::collections::HashSet<String>,
) -> Result<schema::ActionScript, (String, &'static str)> {
    // 끝이 잘린 응답(OpenAI 호환·Ollama의 길이 한도, CLI 시간 초과 등)이면 완결된 편집만 건져 쓴다.
    let parsed = match schema::parse_action_script_lenient(raw) {
        Ok(parsed) => parsed,
        Err(message) => match schema::salvage_truncated_script(raw) {
            Some(salvaged) => schema::parse_action_script_lenient(&salvaged).map_err(|m| (m, "PARSE_ERROR"))?,
            None => return Err((message, "PARSE_ERROR")),
        },
    };
    let mut script = parsed.script;
    let total = script.edits.len();
    let removed = schema::drop_violations(&mut script, whitelist);
    if !removed.is_empty() && removed.len() * 2 > total {
        return Err((
            format!("문서에 존재하지 않는 대상입니다: {}", removed.join(", ")),
            "WHITELIST_VIOLATION",
        ));
    }
    if total == 0 && !parsed.dropped.is_empty() {
        return Err((
            format!("편집 형식을 해석하지 못했습니다: {}", parsed.dropped.join(" / ")),
            "PARSE_ERROR",
        ));
    }
    let skipped = parsed.dropped.len() + removed.len();
    if skipped > 0 {
        let note = format!(
            "(응답 중 {}건은 형식 오류이거나 문서에 없는 대상이라 건너뛰었습니다.)",
            skipped
        );
        script.message = Some(match script.message.take() {
            Some(message) if !message.trim().is_empty() => format!("{} {}", message.trim(), note),
            _ => note,
        });
    }
    Ok(script)
}

/// 양식 이어쓰기 응답을 검증해 `hop-ai-edit-ready`로 보낸다(F-ae778890). action_script와
/// 달리 화이트리스트 검증이 없다 — 응답에는 target_id가 없고, 표 구조는 앱이 결정적으로
/// 복제하므로 환각의 여지가 구조적으로 제거됐다(AC-0cd01fc1). 프런트는 actionScriptJson에
/// 담긴 form-fill JSON({entries})을 파싱해 항목마다 소스 표를 복제한다.
fn emit_form_fill(app: &AppHandle, request_id: &str, raw: &str) {
    match schema::parse_form_fill_response(raw) {
        Ok(resp) => {
            let canonical = serde_json::to_string(&resp).unwrap_or_else(|_| raw.to_string());
            let _ = app.emit(
                "hop-ai-edit-ready",
                AiEditReady {
                    request_id: request_id.to_string(),
                    action_script_json: canonical,
                },
            );
        }
        Err(message) => emit_failed(app, request_id, message, "PARSE_ERROR"),
    }
}

/// 개요 응답을 검증해 `hop-ai-edit-ready`로 보낸다(F-866a1c71). 화이트리스트 검증이 없다 —
/// 개요에는 대상 ID가 없고, 본문은 절별 요청이 일반 편집 경로(화이트리스트 검증)로 쓴다.
fn emit_outline(app: &AppHandle, request_id: &str, raw: &str) {
    match schema::parse_outline_response(raw) {
        Ok(outline) => {
            let canonical = serde_json::to_string(&outline).unwrap_or_else(|_| raw.to_string());
            let _ = app.emit(
                "hop-ai-edit-ready",
                AiEditReady {
                    request_id: request_id.to_string(),
                    action_script_json: canonical,
                },
            );
        }
        Err(message) => emit_failed(app, request_id, message, "PARSE_ERROR"),
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

/// 긴 문서 분할 작성의 개요 요청 시스템 프롬프트(F-866a1c71) — 본문 없이 제목·절 목록만.
fn outline_system_prompt() -> String {
    "당신은 한글(HWP) 문서 기획자입니다. 사용자의 작성 요청을 보고 문서의 제목과 절(장) \
     목차만 설계하세요 — 본문은 쓰지 않습니다(본문은 절마다 따로 요청합니다). 반드시 제공된 \
     JSON Schema를 만족하는 JSON만 출력하세요. sections는 문서 순서대로 4~12개이며, 문서 \
     유형의 표준 구성을 따르세요. 요청 앞에 '[작성 지침 목록]'이 있으면 문서 종류에 맞는 \
     지침 하나를 의미로 골라 그 구성을 따르고 skill에 그 이름(### 제목 그대로)을 적으세요. \
     heading은 번호를 포함한 절 제목('1. 사업 개요'), brief는 그 절에 쓸 핵심 내용 1~2문장, \
     target_chars는 그 절 본문의 목표 글자 수입니다 — 사용자가 'N쪽'을 요청했으면 모든 절의 \
     합이 N×1,300자 안팎이 되게(표가 있는 절은 표가 차지하는 만큼 줄여서), 없으면 문서 \
     유형에 맞게 정하세요. table은 그 절에 표(일정·예산·지표·인력 등)가 꼭 필요할 때만 \
     true입니다. title은 문서 제목, message는 개요를 한 문장으로 요약하세요."
        .to_string()
}

fn system_prompt() -> String {
    "당신은 한글(HWP) 문서를 편집하는 보조자입니다. \
     반드시 제공된 JSON Schema를 만족하는 Action Script JSON만 출력하세요. \
     각 편집의 target_id는 입력 문서 컨텍스트에 존재하는 ID여야 합니다 — 아직 없는 \
     ID(예: 방금 INSERT 할 문단의 다음 번호)를 지어내지 마세요. 그런 편집은 버려집니다. \
     payload.type이 없는 일반 문단 REPLACE·INSERT_BEFORE·INSERT_AFTER는 payload.text에 \
     새 문단의 전체 텍스트를 반드시 채워야 합니다(빈 text 금지). 표·차트·서식·찾아바꾸기 \
     같은 payload.type 편집은 아래 각 절의 필드를 채우세요. 내용을 비우려는 경우에만 \
     DELETE를 쓰세요. \
     [새 문서·빈 문서] 컨텍스트의 본문이 빈 문단 하나뿐이면(새 문서) 첫 제목은 그 문단 \
     ID(보통 sec[0].p[0])에 REPLACE 하고, 나머지 모든 문단·표·차트는 '같은 ID'에 \
     INSERT_AFTER로 쓰고 싶은 순서대로 나열하세요 — 같은 ID의 INSERT_AFTER는 입력 \
     순서대로 뒤에 붙습니다. 빈 첫 문단을 남겨 두지 마세요. \
     표 셀은 `sec[s].p[p].tbl[c].cell[k].p[i]` 형식의 ID로 제공됩니다. 표 안의 값을 \
     바꿀 때는 그 셀 ID로 REPLACE, 셀 안에 내용을 새로 추가할 때는 그 셀 ID로 \
     INSERT_BEFORE/INSERT_AFTER를 쓰세요. \
     글상자(텍스트 상자)·도형 안의 텍스트와 캡션도 같은 셀 형식 ID(`cell[0]`)로 제공됩니다 — \
     그 안의 문구를 바꿀 때도 그 ID로 REPLACE 하면 됩니다. 단, 글상자 안에는 표·이미지·긴 \
     본문을 넣지 마세요(짧은 문구 전용 상자입니다). \
     긴 새 내용(예: 사업계획서 본문, 새 절)이나 새 표를 추가할 때는 반드시 \
     '표 바깥 본문 문단' ID에 INSERT_AFTER 하세요. 본문 문단 ID는 `.tbl`이 없는 \
     `sec[s].p[p]` 형식입니다(예: sec[0].p[0]). \
     `.tbl[...].cell[...]`가 들어간 표 셀 ID에는 새 본문/절/표를 절대 넣지 마세요 — \
     표 셀은 늘어나지 않아 새 페이지를 만들지 못하고 내용이 화면에서 잘립니다. \
     문서가 표로만 차 있으면 가장 큰(마지막) `.tbl` 없는 `sec[s].p[p]`를 골라 그 뒤에 \
     INSERT_AFTER 하세요. 각 문단은 별도 edit으로 INSERT_AFTER 하고, 새 페이지에서 \
     시작해야 하면 payload.page_break를 true로 설정하세요. \
     [작성 지침] 요청 앞에 '[작성 지침 목록]'이 있으면, 요청 내용과 문서 상태(빈 새 문서에 \
     쓰는지, 있는 문서를 고치는지)에 가장 맞는 지침 하나를 의미로 골라 그 지침대로 쓰세요 — \
     낱말이 겹치는지가 아니라 사용자가 만들려는 문서의 종류로 판단합니다(예: 관계기관에 \
     보내는 알림·요청 문서는 공문). '편집 전용' 지침은 새로 쓰는 요청에 쓰지 마세요. \
     따른 지침의 이름(### 제목 그대로)을 응답의 skill에 적고, 따른 것이 없으면 빈 문자열로 \
     두세요. '[작성 스킬: 이름]'으로 지침 하나만 주어지면 그 지침을 따르고 skill에 그 이름을 \
     적으세요. \
     [위치] 내용이 있는 문서에 새 글을 쓰라는데 위치 지시가 없으면, 컨텍스트의 \
     current_cursor_path 문단 뒤에 INSERT_AFTER 하세요. 커서가 없으면 마지막 본문 문단 \
     (`.tbl` 없는 `sec[s].p[p]` 중 가장 뒤) 뒤에 쓰세요. \
     [분량] 사업계획서·보고서·제안서·계획서처럼 긴 문서를 '작성해줘'라는 요청이면 충분히 \
     풍부하게 쓰세요 — 각 절(개요·배경·필요성·목표·내용·추진체계·일정·기대효과 등)을 \
     한 문단으로 끝내지 말고, 도입 문단 + 2~4개의 상세 문단(구체적 수치·예시·근거·세부 \
     항목)으로 전개해 실제 제출 가능한 수준으로 쓰세요(요약하지 말고 구체적으로). 표·그림이 \
     내용을 보강하면 함께 넣으세요. 이 '길게' 규칙은 그런 긴 문서에만 적용합니다 — \
     공문·안내문·회의록·초대장·메모 같은 짧은 문서는 1~2쪽 안에서 끝내고, 요청하지 않은 \
     붙임·부록·표를 지어내지 마세요. 사용자가 '간단히/짧게'라고 하면 짧게 쓰세요. \
     쪽 예산: 기본 글꼴에서 한 쪽은 본문 약 1,300자입니다. 'N쪽'을 요청하면 본문 글자 수를 \
     N×1,300자 안팎으로 맞추고(표는 행 수만큼 쪽을 차지), 쪽을 채우려고 page_break나 \
     빈 문단을 넣지 마세요 — page_break는 표지 다음·큰 장의 시작처럼 꼭 필요한 곳에만. \
     한 번의 응답 분량에는 한도가 있습니다. 약 10쪽을 넘는 문서는 앞에서부터 절을 \
     끝까지 완결해 쓰고, 다 쓰지 못하겠으면 마지막으로 쓴 절을 매듭지은 뒤 message에 \
     '이어서 쓸 절: …'을 적으세요(사용자가 '이어서 써줘'라고 하면 그 뒤를 이어 씁니다). \
     [디자인] 결과가 보기 좋도록 문단마다 역할(payload.style)을 지정하세요: 문서·절 제목은 \
     title, 큰 제목은 heading, 소제목은 subheading, 일반 설명은 body, 인용문은 quote. \
     표 제목은 한국 문서 관례대로 표 '위'에 둡니다 — 표를 INSERT 하기 바로 앞에 \
     '<표 1> 추진 일정'처럼 style=caption 문단을 넣으세요. 그림·차트 설명은 그 '아래'에 \
     '[그림 1] …' 형식의 caption 문단으로 둡니다. 한 문장만 강조하려면 그 문장을 별도 문단으로 INSERT 하고 \
     style=emphasis. 글꼴 크기·정렬·줄간격은 앱이 일관되게 입히므로, 당신은 역할만 정확히 \
     고르면 됩니다(긴 글을 한 문단에 몰지 말고 제목/소제목/본문으로 구조화하세요). 단, \
     사용자가 정렬·줄간격·들여쓰기·번호 매기기를 명시적으로 요구하면 아래 [문단 서식·번호 \
     매기기]의 payload.para_format을 쓰세요. \
     style을 생략한 INSERT 문단은 body로 처리됩니다. 문단 사이 간격은 style이 자동으로 \
     만들어 주므로, 간격을 띄우려고 '빈 문단'을 INSERT 하지 마세요(빈 줄 금지). \
     표의 머리글 행은 앱이 자동으로 굵게+연한 배경+가운데로 꾸미므로 머리글 칸에 별도 \
     장식을 넣지 마세요. \
     표를 새로 만들려면 본문 문단 ID에 INSERT_AFTER 하고 payload.type=\"table\", \
     payload.table_data에 rows, cols, matrix(행×열 문자열 2차원 배열)를 채우세요. \
     원본/첨부 표를 옮길 때는 모든 열과 모든 값을 빠짐없이 포함하세요 — '증액가능여부', \
     '전용가능여부'처럼 ○/× 값이 든 열이나 어떤 열도 임의로 생략·축약하지 마세요. \
     cols는 원본 표의 실제 열 개수와 같아야 합니다. \
     예: 예산 표는 첫 행을 머리글로 두고 matrix에 값을 넣습니다. \
     머리글이 여러 열을 덮거나 같은 값이 세로로 이어지면 table_data.merges에 \
     {start_row,start_col,end_row,end_col}(0-기준, 끝 포함) 영역을 넣어 셀을 병합하세요. \
     머리글은 한 줄(단일 행)로 두는 것을 기본으로 하세요 — 가독성이 가장 좋습니다. \
     특히 긴 설명/제한 내용이 들어가는 열은 그 열 자체에 한 줄짜리 머리글(예 \
     '세목별 사용 용도 및 제한 내용')을 주고 그 열을 가장 넓게(col_weights 최대) 두세요. \
     긴 상위 머리글을 '○/×'·'여부'처럼 좁은 열들 위에 가로 병합으로 올리지 마세요 — \
     좁은 칸에 긴 글자가 끼어 줄바꿈되고 보기 나빠집니다(2단 머리글은 상위 제목이 짧고 \
     하위 열이 충분히 넓을 때만). '인건비'·'직접비'처럼 한 분류가 여러 세목을 포함하면 \
     줄마다 값을 반복하지 말고 그 분류 셀을 세로로 병합하세요(merges로 start_row~end_row). \
     그 분류에 대응하는 비고/설명 셀이 여러 세목 행에 걸쳐 같은 내용이면, 그 비고 셀도 \
     '분류 셀과 똑같은 행 범위'로 함께 세로 병합하세요(예: 인건비가 2개 세목이면 인건비 \
     분류 셀과 인건비 비고 셀 모두 그 2행을 병합). 병합한 셀의 텍스트는 대표(맨 위) 셀에 \
     한 번만 넣고 나머지 칸은 비워 두세요 — 그래야 빈 비고 칸이 생기지 않습니다. \
     각 셀에는 원본/첨부의 내용을 줄이지 말고 전체를 채우세요(비고·제한 내용도 끝까지). \
     긴 설명·비고 열이 있으면 table_data.col_weights(길이=cols, 열별 상대 폭)를 반드시 \
     지정하세요 — 긴 텍스트 열은 크게(예 8~10), '○/×'·'여부'·'세목' 같은 짧은 열은 작게 \
     (예 2)로 두면 긴 내용이 가로로 펼쳐져 표가 세로로 덜 늘어나고 여러 쪽으로 쪼개지지 \
     않습니다. 예: 5열(비용항목/세목/증액여부/전용여부/세목별 사용 용도 및 제한 내용)이면 \
     머리글 한 줄 + col_weights=[3,3,2,2,10] 로 마지막 긴 열을 가장 넓게. \
     [차트] 데이터를 차트로 그려 달라고 하면(또는 표 데이터의 시각화가 적절하면) 본문 문단 \
     ID에 INSERT_AFTER 하고 payload.type=\"chart\", payload.chart_data에 kind(bar/line/pie), \
     title, labels(범주), series([{name,values}])를 채우세요. values는 labels와 같은 길이의 \
     순수 숫자 배열이어야 합니다 — '10억', '1,200원' 같은 문자열 금지(콤마·단위를 빼고 숫자만, \
     단위는 title이나 series.name에 명시). 문서 안 표의 데이터로 요청하면 직렬화된 셀 값을 \
     읽어 숫자로 변환해 쓰세요. pie는 시리즈 1개만 가능합니다. 앱이 차트를 이미지로 그려 \
     삽입합니다. \
     [머리말/꼬리말/각주] 머리말·꼬리말 문단은 `sec[s].header[a].p[i]`/`sec[s].footer[a].p[i]` \
     ID로 제공됩니다(a: 0=양쪽, 1=짝수 쪽, 2=홀수 쪽). 내용을 바꾸려면 그 ID로 REPLACE \
     하세요. text가 빈 placeholder가 보이면 그 문서에 아직 머리말/꼬리말이 없다는 뜻이고, \
     거기에 REPLACE 하면 새로 만들어져 모든 해당 페이지에 표시됩니다(예: '페이지 머리말에 \
     회사명 넣어줘'). 줄을 추가하려면 INSERT_AFTER. 기존 각주는 `sec[s].p[p].fn[c].p[i]` \
     ID로 제공됩니다 — 내용 수정은 그 ID로 REPLACE, 새 각주 달기·떼기는 아래 \
     [각주 달기/떼기]를 따르세요. \
     [누름틀 템플릿] 컨텍스트에 `field[<번호>:<이름>]` ID가 보이면 이 문서는 사람이 \
     미리 디자인한 양식 템플릿입니다 — 최우선으로 누름틀만 REPLACE로 채우고, 본문 \
     문단 추가·표 생성 같은 구조 변경은 사용자가 명시적으로 요구할 때만 하세요. \
     text가 `(안내: …)` 형태인 누름틀은 비어 있는 것이며, 안내문에 맞는 내용을 채우세요. \
     누름틀에는 INSERT를 쓰지 마세요(값 교체만 가능). 서식은 템플릿이 이미 갖고 있으므로 \
     style도 지정하지 마세요. \
     [부분 서식] 텍스트 내용은 그대로 두고 서식만 바꾸려면 command=REPLACE, \
     payload.type=\"format\"을 쓰세요. format_target에 그 문단 안에서 서식을 바꿀 정확한 \
     문자열을 넣고(문단 전체면 생략), char_format에 바꿀 속성만 지정하세요: \
     {bold, italic, underline, strikethrough, font_size_pt, text_color(\"#RRGGBB\")}. \
     payload.text는 필요 없습니다. format_target은 그 문단에서 한 번만 나와야 합니다 — \
     여러 번 나오면 주변 단어를 포함해 더 길게 잡으세요. 사용자가 선택한 텍스트의 서식을 \
     바꿔 달라고 하면 그 선택 텍스트를 format_target으로 쓰세요(다시 쓰지 말 것). \
     본문 문단만 지원합니다(표 셀 내부 부분 서식은 아직 불가). char_format에는 \
     font_family(글꼴 이름, 예 \"맑은 고딕\"), highlight_color(형광펜 #RRGGBB), \
     superscript/subscript도 쓸 수 있습니다. \
     [문단 서식·번호 매기기] 텍스트는 그대로 두고 문단 모양만 바꾸려면 command=REPLACE, \
     payload.type=\"para_format\", payload.para_format={alignment, line_spacing_percent, \
     indent_pt, margin_left_pt, spacing_before_pt, spacing_after_pt, keep_with_next, list}를 \
     쓰세요(본문 문단 또는 표 셀 문단 ID, 바꿀 속성만). 새 문단을 INSERT/REPLACE 할 때도 \
     같은 para_format을 함께 넣으면 그 문단에 바로 적용됩니다. 공문서·보고서처럼 \
     '1. → 가. → 1) → 가)' 위계 번호가 필요하면 번호를 text에 직접 타이핑하지 말고 \
     para_format.list={kind:\"number\", level:0~6}(0=1수준 '1.', 1=2수준 '가.' …)로 \
     매기세요 — 문단을 넣고 빼도 번호가 자동으로 다시 매겨집니다. 글머리표는 \
     {kind:\"bullet\", bullet_char:\"●\"}, 번호 해제는 {kind:\"none\"}. 사용자가 요구하지 \
     않은 정렬·간격은 지정하지 마세요(style이 정합니다). \
     [쪽 설정·쪽 번호] 용지 방향·크기·여백을 바꾸려면 command=REPLACE, target_id=\"doc\", \
     payload.type=\"page_setup\", payload.page_setup={orientation(portrait/landscape), \
     paper(A4/A3/B5/Letter), margins_mm{top,bottom,left,right}}. 쪽 번호를 넣으려면 \
     target_id=\"doc\", payload.type=\"page_number\", payload.page_number={position \
     (footer/header), align(center/left/right), format(plain/dash/total)} — 꼬리말에 '1'을 \
     직접 쓰면 모든 쪽이 1이 되므로 반드시 이 편집을 쓰세요. 그 위치의 기존 머리말/꼬리말 \
     내용은 쪽 번호로 대체됩니다. \
     [찾아 바꾸기 — 문단마다 나열하지 말 것] 같은 문자열을 문서 여러 곳에서 바꿔야 하면 \
     (예: '2025년'을 전부 '2026년'으로, 회사명 일괄 변경) 문단마다 REPLACE 편집을 만들지 \
     마세요. command=REPLACE, target_id=\"doc\"(문서 전체를 뜻하는 고정값), \
     payload.type=\"replace_text\", payload.replace_text={query, new_text, case_sensitive, \
     scope}를 편집 '하나'로 내세요. 본문과 표 셀 안이 모두 바뀝니다. scope=\"first\"면 처음 \
     한 건만 바꿉니다(기본 \"all\"). 특정 문단 하나만 손보는 경우에는 기존처럼 그 문단 ID로 \
     REPLACE 하세요. \
     [표 구조 편집] 이미 있는 표에 행/열을 추가·삭제하거나 셀을 병합하려면, 그 표 안의 \
     아무 셀 ID를 target_id로 잡고 command=REPLACE, payload.type=\"table_edit\", \
     payload.table_edit={op,...}을 쓰세요. op: insert_row(row,below,texts) / \
     insert_col(col,right,texts) / delete_row(row) / delete_col(col) / \
     merge_cells(merge={start_row,start_col,end_row,end_col}) / \
     split_cell(row,col,into_rows,into_cols,equal_row_height,range). 행/열 번호는 0-기준이고 \
     texts에는 새 행/열의 셀 내용을 순서대로 넣을 수 있습니다. 기존 셀 내용은 보존되므로 \
     표 전체를 다시 만들지 말고 구조 편집을 우선 쓰세요. 기존 병합 영역과 부분적으로 \
     겹치는 병합·삭제는 적용되지 않습니다(범위를 병합 경계에 맞추세요). \
     셀을 나눌 때는 split_cell을 쓰세요: '이 칸을 두 개로' → {op:\"split_cell\",row,col,\
     into_cols:2}, '세 줄로' → {into_rows:3}. into_rows/into_cols를 둘 다 생략하면 그 셀의 \
     병합을 해제합니다. range를 주면 그 범위 안의 셀들을 각각 into_rows×into_cols로 \
     나눕니다(예: 한 열 전체를 두 칸씩). \
     [HTML 붙여넣기] 굵기·목록·표 같은 서식이 살아 있는 내용을 넣어야 하면 \
     payload.type=\"paste_html\", payload.paste_html={html}을 쓰세요 — 서식이 유지된 채 \
     들어갑니다. REPLACE는 그 문단 내용을 대신하고, INSERT_AFTER/INSERT_BEFORE는 새 문단을 \
     만들어 넣습니다. target_id는 본문 문단 ID 또는 최상위 표 셀 ID입니다. 서식 없는 \
     보통 문장이면 HTML로 감싸지 말고 그냥 payload.text를 쓰세요. \
     [각주 달기/떼기] 각주를 새로 달려면 command=REPLACE, target_id는 각주를 달 본문 \
     문단 ID, payload.type=\"footnote\", payload.footnote={text, anchor_text}를 쓰세요. \
     text가 각주 내용이고, anchor_text를 주면 그 문자열 바로 뒤에 표식이 붙습니다(생략하면 \
     문단 끝). 문단 본문은 바뀌지 않으므로 payload.text는 넣지 마세요. 각주를 떼려면 \
     command=DELETE, target_id는 각주 ID(sec[S].p[P].fn[C].p[I]), payload.type=\"footnote\". \
     각주 '내용만' 고칠 때는 payload.type 없이 그 각주 ID에 REPLACE 하세요(기존 동작). \
     [표 계산 — 암산 금지] 합계·평균·소계처럼 표의 값을 계산해 달라는 요청에는 절대 \
     직접 계산한 숫자를 text로 넣지 마세요. command=REPLACE, target_id는 그 표 안의 아무 \
     셀 ID, payload.type=\"table_formula\", payload.table_formula={row, col, formula}를 \
     쓰면 앱이 계산해 그 셀에 적습니다. row/col은 결과를 쓸 셀의 0-기준 좌표이고, \
     formula 안의 셀 참조는 A1 표기입니다(첫 행이 1, 첫 열이 A). \
     예: 2열의 2~5행 합계를 6행 2열에 → {row:5, col:1, formula:\"=SUM(B2:B5)\"}. \
     문서가 양식/템플릿(라벨 칸 + 빈 입력 칸으로 된 표)인 경우: '사 업 명', '과 제 명' \
     같은 라벨 셀은 그대로 두고, 그 옆/아래의 빈 셀(텍스트가 비어 있는 셀)을 요청 내용으로 \
     REPLACE 하여 채우세요. 라벨과 표 구조를 바꾸지 말고 기존 서식을 유지하세요. \
     비어 있지 않은 셀은 사용자가 바꿔 달라고 한 경우에만 수정하세요. \
     [양식 표 복제 — 새로 그리지 말고 복제] 문서가 반복되는 표 양식(연구노트 폼, \
     점검표, 기록부처럼 같은 표가 여러 번 반복되는 서식)이고 사용자가 '항목/줄/표를 \
     하나 더 추가'해 달라고 하면, 표를 새로 그리지(table_data로 compose) 마세요 — 그러면 \
     행·열·병합·테두리가 원본과 어긋납니다. 누름틀(field)과 동일한 '디자인 100% 보장' \
     원칙입니다: 기존 양식 표를 그대로 복제(clone)하고 입력칸만 채우세요. \
     컨텍스트 document_metadata.form_tables에 복제 가능한 양식 표 목록이 \
     {section, paragraph, control_index, rows, cols, cells:[{row,col,role,text}]} 형태로 \
     제공됩니다(role: label=안내 칸, input=채울 빈 칸). 새 항목을 넣을 위치의 본문 문단 ID에 \
     command=INSERT_AFTER, payload.type=\"clone_table\"을 쓰고, payload.clone_table.clone_from에 \
     복제할 양식 표의 {section, paragraph, control_index}를 그대로 넣으세요(form_tables의 \
     항목에서 고름). payload.clone_table.cell_fills에는 채울 입력칸만 \
     [{row, col, text}] 로 지정하세요 — role=label인 칸은 절대 넣지 말 것(원본 라벨이 \
     그대로 보존됩니다). 여러 줄이 필요하면 text에 \\n을 넣으세요. 새 페이지에서 시작해야 \
     하면 payload.page_break=true. 행·열·병합·테두리는 복제로 100% 보존되므로 \
     table_data·table_edit를 쓰지 마세요. \
     새 내용을 작성할 때는 문서 컨텍스트에 있는 기존 내용(사업명·기관명·과제명·기간· \
     금액 등)을 적극 활용해 일관된 어조·용어·형식으로 작성하세요. 일반론 대신 \
     이 문서의 실제 정보를 반영하세요. \
     첨부된 문서·이미지(PDF·한글·워드 등)가 있으면 그 내용을 반드시 읽고 \
     사용자 요청에 반영하세요. \
     첨부된 이미지를 문서에 넣어 달라고 하면, 본문 문단 ID에 INSERT_AFTER 하고 \
     payload.type=\"image\", image_index=N(첨부된 이미지의 0-기준 순서: 첫 이미지=0)으로 \
     지정하세요. 이미지는 표 셀이 아니라 표 바깥 본문 문단에 넣어야 합니다. \
     payload.text에 간단한 설명(대체 텍스트)을 넣을 수 있습니다. \
     첨부 PDF의 그림은 'PDF 페이지를 통째로 렌더한 이미지'로 제공될 수 있습니다(같은 \
     image_index 목록에 포함). 이런 PDF 페이지 렌더 이미지는 본문 텍스트·머리글·페이지번호가 \
     함께 들어 있으므로, 절대 페이지 전체를 그대로 넣지 마세요. 당신은 이미지를 직접 볼 수 있으니, \
     원하는 그림(그래프·도표)이 있는 페이지의 image_index를 고르고 payload.crop에 그 그림만 \
     꽉 감싸는 영역을 0~1 비율로 반드시 지정하세요 \
     (예: crop={\"x\":0.1,\"y\":0.25,\"w\":0.8,\"h\":0.4} — 페이지 왼쪽10%/위25% 지점부터 \
     폭80%/높이40%). 도표 주변의 본문 텍스트는 빼되, 그림이 잘리면 안 되므로 경계는 \
     넉넉하게(그림 가장자리보다 상하좌우로 조금 더 크게) 잡으세요 — 애매하면 좁게 말고 \
     넓게 잡으세요. \
     crop 좌표는 당신이 보이는 이미지를 보고 직접 정하고, 사용자에게 '잘라 넣을지' 되묻지 \
     마세요(이미 그렇게 하기로 했습니다). 일반 첨부 이미지나 URL 이미지를 통째로 넣을 때만 \
     crop을 생략하세요. \
     [문서 개요] 컨텍스트의 본문 문단에는 heading 필드(1~3)가 있을 수 있습니다 — 글자 \
     크기·굵기·번호 패턴으로 추정한 제목 수준입니다(1=장, 2=절, 3=소항목). \
     사용자가 '목차'를 요청하면 heading이 있는 문단들의 텍스트로 목차를 만들어 문서 맨 앞 \
     (첫 본문 문단 ID에 INSERT_BEFORE)에 넣으세요 — '목차' 제목 문단(style=heading) 하나 + \
     항목 문단들(style=body, 2·3수준은 앞에 공백 2·4칸 들여쓰기). heading 문단이 하나도 \
     없으면 목차를 만들지 말고 message로 '구조를 인식할 수 없다'고 답하세요. \
     사용자가 특정 장/절(예: '3장', '추진 체계 부분')의 요약·질문을 요청하면, 그 heading \
     문단부터 다음 같은 수준 heading 직전까지의 문단들만 근거로 삼아 답하세요. \
     사용자가 텍스트 일부를 '선택'해 보냈다면(프롬프트에 [사용자가 선택한 텍스트] 블록이 있으면) \
     그 선택 부분만 대상으로 삼아 해당 텍스트가 포함된 문단을 REPLACE하고, 선택 밖 내용은 \
     건드리지 마세요. \
     사용자가 여러 대안(변형)을 원하면, 한 edit의 payload.variations(문자열 배열 2~3개)에 서로 \
     다른 표현의 다시쓰기 안을 넣고 payload.text에는 그 중 추천안(보통 첫 번째)을 넣으세요. \
     그 외 일반 편집에서는 variations를 생략하세요. \
     프롬프트가 '편집하지 말고 질문에 답/요약하라'고 하면 edits를 반드시 빈 배열([])로 두고 \
     message에만 한국어로 답하세요(문서를 수정하지 않습니다). \
     항상 최상위 message 필드에 무엇을 했는지(또는 못 했으면 이유를) 한국어로 1~3문장 \
     적으세요 — 사용자에게 대화하듯 결과를 알려주는 요약입니다. \
     JSON 외의 설명 문장이나 Markdown은 쓰지 말고 JSON만 반환하세요(요약은 message 안에)."
        .to_string()
}

/// 양식 이어쓰기 모드(F-ae778890) 시스템 프롬프트. 이 모드에서 AI는 표를 절대 그리지
/// 않는다 — 주어진 양식의 필드 라벨에 맞춰 '항목 내용 리스트'만 반환한다. 표 구조 결정은
/// 앱이 결정적으로 한다(기존 양식 표를 그대로 복제). F-10a6a5/F-220afd의 clone-not-compose
/// 원칙을 모드 수준으로 끌어올린 것이다(AC-0cd01fc1/AC-86e329eb).
///
/// `labels`는 소스 양식 표의 필드 라벨 목록(예: 제목/연구내용/기록자/확인자/기록 일자)으로,
/// 모델이 내용을 라벨로 키잉하도록 프롬프트에 명시한다.
fn form_fill_system_prompt(labels: &[String]) -> String {
    let label_line = if labels.is_empty() {
        "(라벨 목록이 비어 있습니다 — 사용자 요청과 문서 맥락에서 필드 이름을 추론하세요.)".to_string()
    } else {
        labels.join(", ")
    };
    format!(
        "당신은 한글(HWP) 양식 문서에 '항목'을 이어 쓰는 보조자입니다. \
         이 모드에서는 절대 표를 그리지 마세요 — 표 구조(행 수·열 수·셀 병합·테두리)는 앱이 \
         기존 양식 표를 그대로 복제(clone)해 100% 동일하게 만듭니다. 누름틀(field)·양식 표 복제와 \
         똑같은 '디자인 100% 보장' 원칙입니다: 당신은 구조를 결정하지 말고, 주어진 양식의 필드 \
         라벨에 맞춰 각 항목의 '내용'만 반환하세요. \
         반드시 제공된 JSON Schema를 만족하는 JSON만 출력하세요. 형식은 \
         {{\"entries\": [{{\"fields\": [{{\"label\": \"<필드 라벨>\", \"value\": \"<그 칸 내용>\"}}, ...]}}, ...]}} \
         입니다. entries 배열의 길이가 곧 추가할 항목(표) 수입니다 — 사용자가 N개를 요청하면 \
         entries에 N개를 넣으세요. \
         각 항목의 label은 이 양식의 필드 라벨을 그대로 쓰세요. 이 양식의 필드 라벨: {labels}. \
         value에는 그 칸에 들어갈 내용을 채우고, 여러 줄이 필요하면 \\n으로 구분하세요. \
         양식에 라벨 없는 '본문 통칸'이 있으면(연구노트의 내용란 등) 그 항목의 body 배열에 \
         본문 단락들을 넣으세요 — 배열 원소 1개가 문단 1개입니다. 제목·날짜 칸만 채우고 \
         본문을 비우면 내용 없는 껍데기가 됩니다. \
         표/compose/table_data/clone_table/table_edit 같은 구조 액션은 절대 쓰지 마세요(스키마에 \
         존재하지도 않습니다). 라벨 칸의 텍스트는 바꾸지 말고, 값 칸 내용만 제공하세요. \
         문서 컨텍스트의 기존 항목과 일관된 어조·용어·형식으로 현실적인 내용을 작성하세요. \
         최상위 message에 무엇을 추가했는지 한국어 1~3문장으로 적으세요. JSON만 반환하세요.",
        labels = label_line
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_session_core_replaces_stale_native_core_with_frontend_bytes() {
        let mut manager = crate::state::DocumentSessionManager::default();
        let opened = manager.create_document().unwrap();
        // 화면(프론트) 쪽 문서: 새 문서에 본문을 쓴 상태.
        let mut frontend = hop_rhwp_adapter::DocumentCore::new_empty();
        frontend.create_blank_document_native().unwrap();
        frontend.insert_text_native(0, 0, 0, "AI가 방금 만든 제목").unwrap();
        let bytes = frontend.export_hwp_native().unwrap();
        let sessions = Mutex::new(manager);

        sync_session_core(&sessions, &opened.doc_id, &bytes).unwrap();

        let mut guard = sessions.lock().unwrap();
        let session = guard.session_mut(&opened.doc_id).unwrap();
        let revision_before = opened.revision;
        assert_eq!(session.revision, revision_before, "저장 상태는 건드리지 않는다");
        let core = session.ensure_core_loaded().unwrap();
        let text = core.get_text_range_native(0, 0, 0, 20).unwrap();
        assert!(text.contains("AI가 방금 만든 제목"), "{text}");
    }

    #[test]
    fn sync_session_core_rejects_unknown_document() {
        let sessions = Mutex::new(crate::state::DocumentSessionManager::default());
        let mut core = hop_rhwp_adapter::DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        let bytes = core.export_hwp_native().unwrap();
        assert!(sync_session_core(&sessions, "missing", &bytes).is_err());
    }

    fn whitelist(ids: &[&str]) -> std::collections::HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn one_hallucinated_target_skips_only_that_edit() {
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"제목"}},
            {"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"본문 1"}},
            {"command":"INSERT_AFTER","target_id":"sec[0].p[1]","payload":{"text":"본문 2"}}
        ],"message":"작성했습니다."}"#;
        let script = validate_edit_response(raw, &whitelist(&["sec[0].p[0]"])).unwrap();
        assert_eq!(script.edits.len(), 2);
        assert!(script.message.unwrap().contains("1건은"));
    }

    #[test]
    fn mostly_hallucinated_targets_reject_the_whole_script() {
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"a"}},
            {"command":"REPLACE","target_id":"sec[0].p[7]","payload":{"text":"b"}},
            {"command":"REPLACE","target_id":"sec[0].p[8]","payload":{"text":"c"}}
        ]}"#;
        let (message, code) = validate_edit_response(raw, &whitelist(&["sec[0].p[0]"])).unwrap_err();
        assert_eq!(code, "WHITELIST_VIOLATION");
        assert!(message.contains("sec[0].p[7]"));
    }

    #[test]
    fn malformed_edit_is_dropped_not_the_whole_response() {
        // chart values에 문자열("10억") — 예전에는 응답 전체가 PARSE_ERROR였다.
        let raw = r#"{"edits":[
            {"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"본문"}},
            {"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"type":"chart",
             "chart_data":{"kind":"bar","labels":["a"],"series":[{"name":"s","values":["10억"]}]}}}
        ]}"#;
        let script = validate_edit_response(raw, &whitelist(&["sec[0].p[0]"])).unwrap();
        assert_eq!(script.edits.len(), 1);
        assert!(script.message.unwrap().contains("건너뛰었습니다"));
    }

    #[test]
    fn table_dimensions_are_derived_from_matrix_and_fractional_font_size_parses() {
        let raw = r#"{"edits":[
            {"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"type":"table",
             "table_data":{"matrix":[["a","b","c"],["1","2"]]}}},
            {"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"type":"format",
             "char_format":{"font_size_pt":10.5}}}
        ]}"#;
        let script = validate_edit_response(raw, &whitelist(&["sec[0].p[0]"])).unwrap();
        let table = script.edits[0].payload.table_data.as_ref().unwrap();
        assert_eq!((table.rows, table.cols), (2, 3));
        let format = script.edits[1].payload.char_format.as_ref().unwrap();
        assert_eq!(format.font_size_pt, Some(10.5));
        assert!(script.message.is_none(), "건너뛴 것이 없으면 안내를 붙이지 않는다");
    }

    #[test]
    fn ai_sync_file_must_be_our_temp_file() {
        assert!(read_ai_sync_file(std::path::Path::new("/etc/passwd")).is_err());
        let foreign = std::env::temp_dir().join("other.hwp");
        assert!(read_ai_sync_file(&foreign).is_err());
        let ours = std::env::temp_dir().join(format!("{}test-{}.hwp", AI_SYNC_PREFIX, Uuid::new_v4()));
        std::fs::write(&ours, b"bytes").unwrap();
        assert_eq!(read_ai_sync_file(&ours).unwrap(), b"bytes".to_vec());
        assert!(!ours.exists(), "읽은 뒤 임시 파일을 지운다");
    }

    #[test]
    fn form_fill_prompt_forbids_tables_and_lists_labels() {
        let prompt = form_fill_system_prompt(&[
            "제목".to_string(),
            "연구내용".to_string(),
            "기록자".to_string(),
        ]);
        // 표를 그리지 말라는 지시 + 라벨→값 내용만 + clone-not-compose 정신.
        assert!(prompt.contains("표를 그리지"));
        assert!(prompt.contains("entries"));
        assert!(prompt.contains("label") && prompt.contains("value"));
        assert!(prompt.contains("복제"));
        // 소스 양식의 라벨이 프롬프트에 포함된다(모델이 내용을 라벨로 키잉하게).
        assert!(prompt.contains("제목") && prompt.contains("연구내용") && prompt.contains("기록자"));
        // 표/compose 구조 액션을 쓰지 말라는 명시.
        assert!(prompt.contains("table_data") && prompt.contains("clone_table"));
    }

    #[test]
    fn form_fill_prompt_handles_empty_labels() {
        let prompt = form_fill_system_prompt(&[]);
        assert!(prompt.contains("표를 그리지"));
        assert!(prompt.contains("추론"));
    }

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

    #[test]
    fn system_prompt_guides_chart_generation() {
        let prompt = system_prompt();
        assert!(prompt.contains("chart_data"));
        assert!(prompt.contains("bar/line/pie"));
        // 값은 순수 숫자여야 한다는 지시(AC4 예방).
        assert!(prompt.contains("순수 숫자"));
        // 문서 표 데이터로 차트를 만들 수 있다는 지시(AC — 표 데이터 근거).
        assert!(prompt.contains("직렬화된 셀 값"));
    }

    #[test]
    fn system_prompt_guides_header_footer_and_footnotes() {
        let prompt = system_prompt();
        assert!(prompt.contains("header[a]") || prompt.contains("header"));
        assert!(prompt.contains("placeholder"));
        assert!(prompt.contains("fn[c]"));
        // 기존 각주는 REPLACE로 고치고, 새 각주는 [각주 달기/떼기] 절로 안내한다 —
        // 예전의 "새 각주 추가는 지원하지 않습니다"는 각주 달기 기능 이후 모순이었다.
        assert!(!prompt.contains("새 각주 추가는 지원하지"));
        assert!(prompt.contains("[각주 달기/떼기]를 따르세요"));
    }

    #[test]
    fn system_prompt_guides_template_field_filling() {
        let prompt = system_prompt();
        assert!(prompt.contains("누름틀"));
        assert!(prompt.contains("field[<번호>:<이름>]"));
        // 템플릿 문서에선 구조 변경 대신 누름틀 채우기를 우선(AC3).
        assert!(prompt.contains("구조 변경은 사용자가 명시적으로 요구할 때만"));
    }

    #[test]
    fn system_prompt_guides_run_level_formatting() {
        let prompt = system_prompt();
        assert!(prompt.contains("format_target"));
        assert!(prompt.contains("char_format"));
        // 선택 영역을 format_target으로 쓰라는 지시(AC-264bfd).
        assert!(prompt.contains("선택 텍스트를 format_target"));
    }

    #[test]
    fn system_prompt_guides_outline_toc_and_chapter_summary() {
        let prompt = system_prompt();
        assert!(prompt.contains("heading"));
        assert!(prompt.contains("목차"));
        assert!(prompt.contains("INSERT_BEFORE"));
        // 헤딩이 없으면 목차를 강제하지 않는다(AC4와 일관).
        assert!(prompt.contains("구조를 인식할 수 없다"));
    }

    // ── F-45cee3df AC-e0560800: 새 서식 명령을 시스템 프롬프트에 노출 ──

    #[test]
    fn f45cee3df_ac_e0560800_system_prompt_guides_paragraph_formatting_and_numbering() {
        let prompt = system_prompt();
        assert!(prompt.contains("[문단 서식·번호 매기기]"));
        assert!(prompt.contains("payload.type=\"para_format\""));
        assert!(prompt.contains("para_format.list={kind:\"number\""));
        // 번호를 텍스트로 타이핑하지 말라는 지시가 핵심이다(감사 누락 명령 1).
        assert!(prompt.contains("번호를 text에 직접 타이핑하지 말고"));
        assert!(prompt.contains("{kind:\"none\"}"));
    }

    #[test]
    fn f45cee3df_ac_e0560800_system_prompt_guides_page_setup_and_page_numbers() {
        let prompt = system_prompt();
        assert!(prompt.contains("[쪽 설정·쪽 번호]"));
        assert!(prompt.contains("payload.type=\"page_setup\""));
        assert!(prompt.contains("payload.type=\"page_number\""));
        assert!(prompt.contains("target_id=\"doc\""));
        // 꼬리말에 '1'을 직접 쓰지 말고 자동 쪽 번호를 쓰라는 이유까지 안내한다.
        assert!(prompt.contains("모든 쪽이 1이 되므로"));
        // 부분 서식 절에 새 char_format 속성도 안내된다.
        assert!(prompt.contains("font_family"));
        assert!(prompt.contains("highlight_color"));
    }

    #[test]
    fn f45cee3df_ac_e0560800_doc_page_edits_survive_validation() {
        // 전체 문서 컨텍스트의 화이트리스트에는 "doc"이 들어 있다 — 쪽 설정·쪽 번호는 통과,
        // "doc"을 겨눈 일반 텍스트 편집은 그것만 버려진다.
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"doc","payload":{"type":"page_setup","page_setup":{"orientation":"landscape"}}},
            {"command":"REPLACE","target_id":"doc","payload":{"type":"page_number","page_number":{"align":"center"}}},
            {"command":"REPLACE","target_id":"doc","payload":{"text":"전부 이걸로"}}
        ]}"#;
        let script = validate_edit_response(raw, &whitelist(&["doc", "sec[0].p[0]"])).unwrap();
        let kinds: Vec<Option<&str>> = script.edits.iter().map(|e| e.payload.kind.as_deref()).collect();
        assert_eq!(kinds, vec![Some("page_setup"), Some("page_number")]);
        assert!(script.message.unwrap().contains("1건은"));
    }

    #[test]
    fn f45cee3df_ac_e0560800_type_only_page_number_survives_validation() {
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"doc","payload":{"type":"page_number"}}
        ],"message":"쪽 번호를 넣었습니다."}"#;
        let script = validate_edit_response(raw, &whitelist(&["doc", "sec[0].p[0]"])).unwrap();
        assert_eq!(script.edits.len(), 1);
        assert_eq!(script.edits[0].payload.kind.as_deref(), Some("page_number"));
        assert_eq!(script.message.as_deref(), Some("쪽 번호를 넣었습니다."), "건너뛴 것이 없다");
    }

    // ── F-bae302c6 AC-d29d54cb: 시스템 프롬프트의 모순 제거와 새 문서 규칙 ──

    #[test]
    fn fbae302c6_ac_d29d54cb_system_prompt_has_the_new_document_rule() {
        let prompt = system_prompt();
        assert!(prompt.contains("[새 문서·빈 문서]"));
        // 첫 제목은 빈 첫 문단에 REPLACE, 나머지는 같은 ID에 INSERT_AFTER로 순서대로.
        assert!(prompt.contains("첫 제목은 그 문단"));
        assert!(prompt.contains("sec[0].p[0]"));
        assert!(prompt.contains("'같은 ID'에"));
        assert!(prompt.contains("같은 ID의 INSERT_AFTER는 입력 순서대로 뒤에 붙습니다"));
        assert!(prompt.contains("빈 첫 문단을 남겨 두지 마세요"));
        // 아직 없는 ID(방금 INSERT 할 문단의 다음 번호 등)를 지어내지 말라는 지시.
        assert!(prompt.contains("아직 없는 ID("));
        assert!(prompt.contains("를 지어내지 마세요"));
    }

    #[test]
    fn fbae302c6_ac_d29d54cb_text_is_required_only_for_untyped_paragraph_edits() {
        let prompt = system_prompt();
        assert!(prompt.contains(
            "payload.type이 없는 일반 문단 REPLACE·INSERT_BEFORE·INSERT_AFTER는 payload.text에"
        ));
        assert!(prompt.contains("payload.type 편집은 아래 각 절의 필드를 채우세요"));
        // 예전의 "모든 REPLACE·INSERT는 text 필수" 문장은 서식·표 편집 지시와 모순이었다.
        assert!(!prompt.contains("REPLACE·INSERT_BEFORE·INSERT_AFTER 명령은 payload.text에"));
        assert!(!prompt.contains("text가 비어 있으면 안 됩니다"));
    }

    // ── F-a7b2c7ba AC-5fdd07ba: 문서 유형별 분량·쪽 예산·캡션 위치·쓰기 위치·긴 문서 분할 ──

    /// 프롬프트에서 `start` 표지부터 `end` 표지 직전까지(해당 절 본문).
    fn prompt_section(prompt: &str, start: &str, end: &str) -> String {
        let from = prompt.find(start).unwrap_or_else(|| panic!("{start} 절이 없다"));
        let rest = &prompt[from..];
        let to = rest.find(end).unwrap_or_else(|| panic!("{start} 뒤에 {end} 절이 없다"));
        rest[..to].to_string()
    }

    fn position(haystack: &str, needle: &str) -> usize {
        haystack
            .find(needle)
            .unwrap_or_else(|| panic!("'{needle}' 문구가 없다:\n{haystack}"))
    }

    #[test]
    fn f_a7b2c7ba_ac_5fdd07ba_long_form_rule_applies_only_to_business_plans_reports_proposals() {
        let prompt = system_prompt();
        let volume = prompt_section(&prompt, "[분량]", "[디자인]");
        // '충분히 길게' 규칙의 대상이 긴 문서 유형으로 한정된다.
        let rich = position(&volume, "사업계획서·보고서·제안서·계획서처럼 긴 문서를 '작성해줘'라는 요청이면 충분히 풍부하게 쓰세요");
        let scope = position(&volume, "이 '길게' 규칙은 그런 긴 문서에만 적용합니다");
        assert!(rich < scope, "범위 한정 문장은 '길게' 규칙 뒤에 와야 한다");
        // 예전의 무조건 '길게·많이' 지시는 사라졌다.
        assert!(!prompt.contains("풍부하고 길게 쓰세요"));
        assert!(!prompt.contains("가능한 한 많은 절과 문단"));
    }

    #[test]
    fn f_a7b2c7ba_ac_5fdd07ba_short_documents_stay_within_two_pages_without_invented_attachments() {
        let volume = prompt_section(&system_prompt(), "[분량]", "[디자인]");
        let short = position(&volume, "공문·안내문·회의록");
        let pages = position(&volume, "짧은 문서는 1~2쪽 안에서 끝내고");
        let no_attach = position(&volume, "요청하지 않은 붙임·부록·표를 지어내지 마세요");
        assert!(short < pages && pages < no_attach);
    }

    #[test]
    fn f_a7b2c7ba_ac_5fdd07ba_page_budget_is_1300_chars_per_page_without_padding() {
        let volume = prompt_section(&system_prompt(), "[분량]", "[디자인]");
        assert!(volume.contains("한 쪽은 본문 약 1,300자입니다"), "{volume}");
        assert!(volume.contains("'N쪽'을 요청하면 본문 글자 수를 N×1,300자 안팎으로 맞추고"), "{volume}");
        // 쪽을 채우려는 쪽 나눔·빈 문단 금지.
        assert!(volume.contains("쪽을 채우려고 page_break나 빈 문단을 넣지 마세요"), "{volume}");
    }

    #[test]
    fn f_a7b2c7ba_ac_5fdd07ba_table_caption_above_figure_caption_below() {
        let prompt = system_prompt();
        let design = prompt_section(&prompt, "[디자인]", "[차트]");
        let table_caption = position(&design, "표 제목은 한국 문서 관례대로 표 '위'에 둡니다");
        let example = position(&design, "표를 INSERT 하기 바로 앞에 '<표 1> 추진 일정'처럼 style=caption 문단을 넣으세요");
        let figure = position(&design, "그림·차트 설명은 그 '아래'에 '[그림 1] …' 형식의 caption 문단으로 둡니다");
        assert!(table_caption < example && example < figure);
        // 예전의 '그림/표 아래 설명은 caption'(표 캡션을 아래로 보내던 모순 문장)은 없다.
        assert!(!prompt.contains("그림/표 아래 설명은"));
        assert!(!prompt.contains("표 아래 설명"));
    }

    #[test]
    fn f_a7b2c7ba_ac_5fdd07ba_unplaced_writing_goes_after_cursor_else_last_body_paragraph() {
        let placement = prompt_section(&system_prompt(), "[위치]", "[분량]");
        let condition = position(&placement, "내용이 있는 문서에 새 글을 쓰라는데 위치 지시가 없으면");
        let cursor = position(&placement, "current_cursor_path 문단 뒤에 INSERT_AFTER 하세요");
        let fallback = position(&placement, "커서가 없으면 마지막 본문 문단");
        assert!(condition < cursor && cursor < fallback);
        assert!(placement.contains("`.tbl` 없는 `sec[s].p[p]` 중 가장 뒤) 뒤에 쓰세요"), "{placement}");
    }

    #[test]
    fn f_a7b2c7ba_ac_5fdd07ba_very_long_documents_finish_whole_sections_and_name_the_next_one() {
        let volume = prompt_section(&system_prompt(), "[분량]", "[디자인]");
        let complete = position(&volume, "앞에서부터 절을 끝까지 완결해 쓰고");
        let next = position(&volume, "message에 '이어서 쓸 절: …'을 적으세요");
        assert!(complete < next);
        assert!(volume.contains("마지막으로 쓴 절을 매듭지은 뒤"), "{volume}");
    }

    // ── F-a7b2c7ba AC-ee075a19: 잘린 응답은 PARSE_ERROR 대신 완결된 편집만 살린다 ──

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_truncated_response_is_salvaged_not_a_parse_error() {
        let raw = r#"{"message":"보고서를 작성했습니다.","edits":[
            {"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"결과 보고서","style":"title"}},
            {"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"1. 개요","style":"heading"}},
            {"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"본문이 쓰이다 끊"#;
        let script = validate_edit_response(raw, &whitelist(&["sec[0].p[0]"]))
            .expect("완결된 편집 2건이 있으면 미리보기로 보내야 한다");
        let texts: Vec<_> = script.edits.iter().map(|e| e.payload.text.clone().unwrap_or_default()).collect();
        assert_eq!(texts, vec!["결과 보고서", "1. 개요"]);
        let message = script.message.unwrap_or_default();
        assert!(message.starts_with("보고서를 작성했습니다."), "{message}");
        assert!(message.contains("출력 한도"), "{message}");
        assert!(message.contains("앞의 2건"), "{message}");
        assert!(message.contains("이어서 써줘"), "{message}");
    }

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_truncated_response_without_a_complete_edit_is_still_a_parse_error() {
        let raw = r#"{"message":"작성 중","edits":[{"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"te"#;
        let (_, code) = validate_edit_response(raw, &whitelist(&["sec[0].p[0]"])).unwrap_err();
        assert_eq!(code, "PARSE_ERROR");
    }

    // ── F-fb6592e9 AC-ae417d5d: 시스템 프롬프트가 지침 선택·skill 기입을 시키고, 검증을 거친
    //    스크립트(프런트로 보내는 정규 JSON)에 skill이 남는다 ──

    /// `[작성 지침]` 문단만(다음 `[…]` 절 앞까지) 떼어 본다 — 다른 절의 같은 낱말에 속지 않게.
    fn authoring_guideline_rule(prompt: &str) -> &str {
        let head = "[작성 지침]";
        let start = prompt.find(head).expect("시스템 프롬프트에 [작성 지침] 절이 있어야 한다");
        let rest = &prompt[start + head.len()..];
        let end = rest.find(" [").unwrap_or(rest.len());
        &rest[..end]
    }

    #[test]
    fn f_fb6592e9_ac_ae417d5d_system_prompt_has_the_guideline_choice_rule() {
        let prompt = system_prompt();
        let rule = authoring_guideline_rule(&prompt);
        // 목록이 있을 때 하나를 의미로 고른다(낱말 일치가 아니라 만들려는 문서 종류로).
        assert!(rule.contains("'[작성 지침 목록]'이 있으면"), "{rule}");
        assert!(rule.contains("지침 하나를 의미로 골라"), "{rule}");
        assert!(rule.contains("낱말이 겹치는지가 아니라"), "{rule}");
        // 편집 전용 지침은 새로 쓰는 요청에 쓰지 않는다.
        assert!(rule.contains("'편집 전용' 지침은 새로 쓰는 요청에 쓰지 마세요"), "{rule}");
        // 따른 지침 이름을 skill에, 없으면 빈 문자열.
        assert!(rule.contains("응답의 skill에 적고"), "{rule}");
        assert!(rule.contains("따른 것이 없으면 빈 문자열"), "{rule}");
        // 직접 고른 스킬 하나만 주어진 경우.
        assert!(rule.contains("'[작성 스킬: 이름]'으로 지침 하나만 주어지면"), "{rule}");
        assert!(rule.contains("skill에 그 이름을"), "{rule}");
    }

    #[test]
    fn f_fb6592e9_ac_ae417d5d_validated_script_json_carries_skill_to_the_frontend() {
        let raw = r#"{"message":"공문을 작성했습니다.","skill":"공문","edits":[
            {"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"협조 요청"}}
        ]}"#;
        let script = validate_edit_response(raw, &whitelist(&["sec[0].p[0]"])).unwrap();
        assert_eq!(script.skill.as_deref(), Some("공문"));
        // emit_validated가 hop-ai-edit-ready로 보내는 것과 같은 직렬화.
        let json = serde_json::to_string(&script).unwrap();
        assert!(json.contains(r#""skill":"공문""#), "{json}");
    }

    #[test]
    fn f_fb6592e9_ac_ae417d5d_skill_survives_dropping_a_whitelist_violation() {
        // 편집 3건 중 1건이 없는 대상 → 그것만 버리고(과반 아님) 나머지와 skill은 보낸다.
        let raw = r#"{"skill":"보고서","edits":[
            {"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"제목"}},
            {"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"본문"}},
            {"command":"INSERT_AFTER","target_id":"sec[0].p[9]","payload":{"text":"없는 대상"}}
        ]}"#;
        let script = validate_edit_response(raw, &whitelist(&["sec[0].p[0]"])).unwrap();
        assert_eq!(script.edits.len(), 2);
        assert_eq!(script.skill.as_deref(), Some("보고서"));
        let json = serde_json::to_string(&script).unwrap();
        assert!(json.contains(r#""skill":"보고서""#), "{json}");
    }

    #[test]
    fn f_fb6592e9_ac_ae417d5d_skill_survives_truncation_salvage() {
        let raw = r#"{"skill":"사업계획서","message":"작성 중","edits":[
            {"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"사업계획서","style":"title"}},
            {"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"본문이 쓰이다 끊"#;
        let script = validate_edit_response(raw, &whitelist(&["sec[0].p[0]"]))
            .expect("완결된 편집 1건이 있으면 살린다");
        assert_eq!(script.edits.len(), 1);
        assert_eq!(script.skill.as_deref(), Some("사업계획서"));
        let json = serde_json::to_string(&script).unwrap();
        assert!(json.contains(r#""skill":"사업계획서""#), "{json}");
    }

    #[test]
    fn f_fb6592e9_ac_ae417d5d_skill_survives_a_prose_wrapped_cli_response() {
        let raw = "다음과 같이 작성했습니다.\n{\"skill\":\"공문\",\"edits\":[{\"command\":\"REPLACE\",\"target_id\":\"sec[0].p[0]\",\"payload\":{\"text\":\"협조 요청\"}}]}\n이상입니다.";
        let script = validate_edit_response(raw, &whitelist(&["sec[0].p[0]"])).unwrap();
        assert_eq!(script.skill.as_deref(), Some("공문"));
    }

    #[test]
    fn f_fb6592e9_ac_ae417d5d_response_without_skill_emits_no_skill_key() {
        let raw = r#"{"edits":[{"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"x"}}]}"#;
        let script = validate_edit_response(raw, &whitelist(&["sec[0].p[0]"])).unwrap();
        assert_eq!(script.skill, None);
        let json = serde_json::to_string(&script).unwrap();
        assert!(!json.contains("skill"), "{json}");
    }

    // ── F-866a1c71 긴 문서 분할 작성 — 개요 요청 시스템 프롬프트(AC-a622a229) ──────

    #[test]
    fn f_866a1c71_ac_a622a229_outline_prompt_asks_for_title_and_sections_only() {
        let prompt = outline_system_prompt();
        assert!(prompt.contains("제목과 절(장)"), "{prompt}");
        assert!(prompt.contains("본문은 쓰지 않습니다"), "본문 없이 개요만: {prompt}");
        // 개요 단계는 Action Script(편집)를 내지 않는다 — 편집 프롬프트와 섞이지 않았다.
        assert!(!prompt.contains("Action Script"), "{prompt}");
        assert!(prompt.contains("JSON Schema"), "{prompt}");
    }

    #[test]
    fn f_866a1c71_ac_a622a229_outline_prompt_asks_for_4_to_12_sections() {
        let prompt = outline_system_prompt();
        assert!(prompt.contains("4~12개"), "{prompt}");
    }

    #[test]
    fn f_866a1c71_ac_a622a229_outline_prompt_picks_a_skill_from_the_catalog() {
        let prompt = outline_system_prompt();
        assert!(prompt.contains("'[작성 지침 목록]'"), "{prompt}");
        assert!(prompt.contains("skill에 그 이름"), "고른 지침 이름을 skill에 적게 한다: {prompt}");
    }

    #[test]
    fn f_866a1c71_ac_a622a229_outline_prompt_budgets_n_pages_times_1300_chars() {
        let prompt = outline_system_prompt();
        assert!(prompt.contains("'N쪽'"), "{prompt}");
        assert!(prompt.contains("N×1,300자"), "{prompt}");
        assert!(prompt.contains("target_chars"), "{prompt}");
    }

    #[test]
    fn f_866a1c71_ac_a622a229_outline_prompt_asks_for_tables_only_when_needed() {
        let prompt = outline_system_prompt();
        assert!(prompt.contains("table은"), "{prompt}");
        assert!(prompt.contains("꼭 필요할 때만 true"), "{prompt}");
    }
}
