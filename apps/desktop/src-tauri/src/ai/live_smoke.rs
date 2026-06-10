//! 라이브 E2E 스모크 테스트 — 실제 LLM(Claude Code CLI)으로 전체 파이프라인을 검증한다.
//!
//! 실제 문서 생성 → 직렬화(컨텍스트+화이트리스트) → 시스템 프롬프트로 실제 LLM 호출
//! → Action Script 파싱·화이트리스트 검증 → (가능한 경우) 네이티브 적용 → 저장
//! 라운드트립. 네트워크·구독이 필요하므로 `--ignored`로만 실행한다:
//!
//! ```sh
//! rustup run 1.95.0 cargo test --lib ai::live_smoke -- --ignored --nocapture --test-threads=1
//! ```

#![cfg(test)]

use super::adapters::cli::CliProvider;
use super::provider::{CancelToken, LlmProvider, LlmRequest};
use super::{schema, serialize, system_prompt};
use rhwp::DocumentCore;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

/// CLI 모델 — 빠르고 저렴한 haiku로 스모크를 돈다.
const MODEL: &str = "haiku";

fn call_llm(core: &DocumentCore, user_prompt: &str) -> (schema::ActionScript, std::collections::HashSet<String>) {
    let (context, whitelist) = serialize::build_full_context(core).unwrap();
    let req = LlmRequest {
        system_prompt: system_prompt(),
        user_prompt: user_prompt.to_string(),
        document_context_json: serde_json::to_string(&context).unwrap(),
        output_schema: schema::action_script_schema(),
        images: Vec::new(),
        documents: Vec::new(),
        file_paths: Vec::new(),
    };
    let provider = CliProvider::claude(MODEL.to_string());
    let cancel: CancelToken = Arc::new(AtomicBool::new(false));
    let raw = tauri::async_runtime::block_on(provider.generate_edit(
        req,
        Box::new(|_| {}),
        cancel,
    ))
    .expect("CLI 호출 실패 — claude CLI 로그인/설치 확인");
    let script = schema::parse_action_script(&raw).expect("Action Script 파싱 실패");
    let violations = schema::collect_violations(&script, &whitelist);
    assert!(violations.is_empty(), "화이트리스트 위반: {:?}", violations);
    (script, whitelist)
}

fn doc_with_table() -> (DocumentCore, usize, usize) {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    core.insert_text_native(0, 0, 0, "2026년 사업 실적 보고").unwrap();
    let result = core.create_table_native(0, 0, 0, 3, 2).unwrap();
    let v: serde_json::Value = serde_json::from_str(&result).unwrap();
    let ctrl = v["controlIdx"].as_u64().unwrap() as usize;
    let para = v["paraIdx"].as_u64().unwrap() as usize;
    for (idx, text) in ["분기", "매출(억원)", "1분기", "120", "2분기", "98"].iter().enumerate() {
        core.insert_text_in_cell_native(0, para, ctrl, idx, 0, 0, text).unwrap();
    }
    (core, para, ctrl)
}

/// 머리말: 없는 문서에 "머리말 넣어줘" → placeholder REPLACE → 실제 생성·저장까지.
#[test]
#[ignore]
fn live_header_request_creates_header_end_to_end() {
    let (mut core, _, _) = doc_with_table();
    let (script, _) = call_llm(&core, "페이지 머리말에 '대외비'라고 넣어줘.");
    eprintln!("응답: {}", serde_json::to_string(&script).unwrap());

    // 머리말 placeholder를 대상으로 한 텍스트 편집이 있어야 한다.
    let hf_edit = script
        .edits
        .iter()
        .find(|e| e.target_id.contains(".header["))
        .expect("머리말 ID를 대상으로 한 edit이 없음");
    let text = hf_edit.payload.text.clone().expect("payload.text 없음");
    assert!(text.contains("대외비"), "머리말 텍스트에 '대외비' 없음: {}", text);

    // 적용(ai-apply의 applyOneHeaderFooter와 동일 순서) → 저장 라운드트립.
    core.create_header_footer_native(0, true, 0).unwrap();
    core.insert_text_in_header_footer_native(0, true, 0, 0, 0, &text).unwrap();
    let bytes = core.export_hwp_native().unwrap();
    let reloaded =
        crate::state::editable_core_from_bytes(&bytes, "파싱 실패", "변환 실패").unwrap();
    let json = reloaded.get_header_footer_native(0, true, 0).unwrap();
    assert!(json.contains("대외비"), "저장 후 머리말 소실: {}", json);
    eprintln!("✅ 머리말 E2E 통과 (생성→저장→재파싱)");
}

/// 표 구조: "합계 행 추가" → table_edit(insert_row) 액션 형태 검증.
#[test]
#[ignore]
fn live_table_row_request_yields_table_edit() {
    let (core, _, _) = doc_with_table();
    let (script, _) = call_llm(
        &core,
        "표 맨 아래에 합계 행을 추가해줘. 합계는 218이야.",
    );
    eprintln!("응답: {}", serde_json::to_string(&script).unwrap());

    let edit = script
        .edits
        .iter()
        .find(|e| e.payload.table_edit.is_some())
        .expect("table_edit 액션이 없음");
    let spec = edit.payload.table_edit.as_ref().unwrap();
    assert_eq!(spec.op, "insert_row", "insert_row가 아님: {}", spec.op);
    assert!(edit.target_id.contains(".tbl["), "표 셀 ID가 아님: {}", edit.target_id);
    eprintln!("✅ 표 구조 편집 액션 통과: op={} texts={:?}", spec.op, spec.texts);
}

/// 차트: 표 데이터 시각화 요청 → chart 액션(숫자 값) 검증.
#[test]
#[ignore]
fn live_chart_request_yields_numeric_chart_data() {
    let (core, _, _) = doc_with_table();
    let (script, _) = call_llm(&core, "표의 분기별 매출을 막대 차트로 그려서 넣어줘.");
    eprintln!("응답: {}", serde_json::to_string(&script).unwrap());

    let edit = script
        .edits
        .iter()
        .find(|e| e.payload.chart_data.is_some())
        .expect("chart 액션이 없음");
    let chart = edit.payload.chart_data.as_ref().unwrap();
    assert_eq!(chart.kind, "bar");
    assert!(!chart.labels.is_empty());
    let values = &chart.series[0].values;
    assert_eq!(values.len(), chart.labels.len());
    assert!(values.iter().any(|v| (*v - 120.0).abs() < 1e-6), "120이 없음: {:?}", values);
    assert!(values.iter().any(|v| (*v - 98.0).abs() < 1e-6), "98이 없음: {:?}", values);
    eprintln!("✅ 차트 액션 통과: labels={:?} values={:?}", chart.labels, values);
}

/// 부분 서식: "이 단어만 굵게" → format 액션(format_target+char_format) 검증.
#[test]
#[ignore]
fn live_format_request_yields_run_level_format() {
    let mut core = DocumentCore::new_empty();
    core.create_blank_document_native().unwrap();
    core.insert_text_native(0, 0, 0, "올해의 핵심 성과는 매출 증가입니다.").unwrap();
    let (script, _) = call_llm(&core, "'핵심 성과'라는 단어만 굵게 강조해줘. 내용은 바꾸지 마.");
    eprintln!("응답: {}", serde_json::to_string(&script).unwrap());

    let edit = script
        .edits
        .iter()
        .find(|e| e.payload.char_format.is_some())
        .expect("format 액션이 없음");
    let target = edit.payload.format_target.as_deref().unwrap_or("");
    assert!(target.contains("핵심 성과"), "format_target에 '핵심 성과' 없음: {}", target);
    assert_eq!(edit.payload.char_format.as_ref().unwrap().bold, Some(true));
    eprintln!("✅ 부분 서식 액션 통과: target={:?}", target);
}
