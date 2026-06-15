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
pub mod pdf_images;
pub mod pdf_pages;
pub mod pdf_pdfium;
#[cfg(target_os = "macos")]
pub mod pdf_render;
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
    let (sys_prompt, out_schema, mode) = match &form_fill_labels {
        Some(labels) => (
            form_fill_system_prompt(labels),
            schema::form_fill_schema(),
            RequestMode::FormFill,
        ),
        None => (system_prompt(), schema::action_script_schema(), RequestMode::Edit),
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
     [분량] 사업계획서·보고서·제안서처럼 '문서를 작성/작성해줘'라는 요청이면 충분히 \
     풍부하고 길게 쓰세요 — 각 절(개요·배경·필요성·목표·내용·추진체계·일정·기대효과 등)을 \
     한 문단으로 끝내지 말고, 도입 문단 + 2~4개의 상세 문단(구체적 수치·예시·근거·세부 \
     항목)으로 전개하세요. 가능한 한 많은 절과 문단을 별도 edit으로 INSERT_AFTER 하여 \
     실제 제출 가능한 수준의 분량으로 작성하세요(요약하지 말고 끝까지 구체적으로). 표·그림이 \
     내용을 보강하면 함께 넣으세요. 단, 사용자가 '간단히/짧게'라고 하면 짧게 쓰세요. \
     [디자인] 결과가 보기 좋도록 문단마다 역할(payload.style)을 지정하세요: 문서·절 제목은 \
     title, 큰 제목은 heading, 소제목은 subheading, 일반 설명은 body, 그림/표 아래 설명은 \
     caption, 인용문은 quote. 한 문장만 강조하려면 그 문장을 별도 문단으로 INSERT 하고 \
     style=emphasis. 글꼴 크기·정렬·줄간격은 앱이 일관되게 입히므로, 당신은 역할만 정확히 \
     고르면 됩니다(긴 글을 한 문단에 몰지 말고 제목/소제목/본문으로 구조화하세요). \
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
     회사명 넣어줘'). 줄을 추가하려면 INSERT_AFTER. 각주는 `sec[s].p[p].fn[c].p[i]` ID로 \
     제공되며 REPLACE(내용 수정)·DELETE(비우기)만 가능합니다 — 새 각주 추가는 지원하지 \
     않습니다. \
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
     본문 문단만 지원합니다(표 셀 내부 부분 서식은 아직 불가). \
     [표 구조 편집] 이미 있는 표에 행/열을 추가·삭제하거나 셀을 병합하려면, 그 표 안의 \
     아무 셀 ID를 target_id로 잡고 command=REPLACE, payload.type=\"table_edit\", \
     payload.table_edit={op,...}을 쓰세요. op: insert_row(row,below,texts) / \
     insert_col(col,right,texts) / delete_row(row) / delete_col(col) / \
     merge_cells(merge={start_row,start_col,end_row,end_col}). 행/열 번호는 0-기준이고 \
     texts에는 새 행/열의 셀 내용을 순서대로 넣을 수 있습니다. 기존 셀 내용은 보존되므로 \
     표 전체를 다시 만들지 말고 구조 편집을 우선 쓰세요. 기존 병합 영역과 부분적으로 \
     겹치는 병합·삭제는 적용되지 않습니다(범위를 병합 경계에 맞추세요). \
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
        // 각주는 내용 수정/비우기만 — 새 각주 추가는 미지원임을 명시.
        assert!(prompt.contains("새 각주 추가는 지원하지"));
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

}
