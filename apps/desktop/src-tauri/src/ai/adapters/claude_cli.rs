//! Claude Code CLI 위임 어댑터(스펙 5.3장 — API 키 없이 구독 활용).
//!
//! 사용자가 터미널에서 이미 로그인해 둔 `claude`(Claude Code) CLI를 자식
//! 프로세스로 호출한다. OAuth 토큰·구독·과금은 CLI가 처리하므로 앱은 API 키를
//! 다루지 않는다. 프롬프트를 stdin으로 넘기고 stdout(텍스트)을 받아, 다른
//! provider와 동일하게 코어가 파싱·검증·diff·승인 적용한다.
//!
//! 스트리밍/네이티브 구조화 출력은 없다 — 전체 응답을 한 번에 받고, "JSON만
//! 출력" 지시 + 코어의 코드펜스 제거·파싱 방어에 의존한다.

use super::user_content;
use crate::ai::provider::{CancelToken, DeltaSink, LlmProvider, LlmRequest, ProviderError};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

/// CLI 응답 대기 상한(초). 초과 시 프로세스를 종료하고 TIMEOUT 처리.
const CLI_TIMEOUT_SECS: u64 = 180;

pub struct ClaudeCliProvider {
    /// `--model` 값. 비었거나 "default"면 CLI 기본 모델을 쓴다.
    pub model: String,
}

impl ClaudeCliProvider {
    /// CLI에 stdin으로 넘길 전체 프롬프트(시스템 + 컨텍스트 + 첨부 경로 + 스키마 + JSON-only).
    fn build_prompt(req: &LlmRequest) -> String {
        let schema = serde_json::to_string_pretty(&req.output_schema).unwrap_or_default();
        // CLI는 로컬 파일을 직접 열 수 있으므로 base64 대신 경로를 넘긴다(PDF 등).
        let files = if req.file_paths.is_empty() {
            String::new()
        } else {
            let list = req
                .file_paths
                .iter()
                .map(|p| format!("- {}", p))
                .collect::<Vec<_>>()
                .join("\n");
            format!("\n\n[참고 첨부 파일 — 직접 열어 내용을 확인하세요]\n{}", list)
        };
        format!(
            "{system}\n\n{content}{files}\n\n[반드시 만족할 출력 JSON 스키마]\n{schema}\n\n\
             설명·Markdown 없이 위 스키마를 만족하는 JSON만 출력하세요.",
            system = req.system_prompt,
            content = user_content(req),
            files = files,
            schema = schema,
        )
    }
}

#[async_trait::async_trait]
impl LlmProvider for ClaudeCliProvider {
    async fn generate_edit(
        &self,
        req: LlmRequest,
        on_delta: DeltaSink,
        cancel: CancelToken,
    ) -> Result<String, ProviderError> {
        // 진행 표시만 한 번 흘려보낸다(부분 토큰 스트리밍은 없음).
        on_delta(" ".to_string());

        let prompt = Self::build_prompt(&req);
        let model = self.model.clone();
        tauri::async_runtime::spawn_blocking(move || run_claude_cli(&prompt, &model, &cancel))
            .await
            .map_err(|e| ProviderError::Provider(format!("CLI 실행 태스크 실패: {}", e)))?
    }
}

/// `claude -p` 자식 프로세스를 실행한다. 협조적 취소·타임아웃을 폴링으로 처리한다.
fn run_claude_cli(prompt: &str, model: &str, cancel: &CancelToken) -> Result<String, ProviderError> {
    let mut command = Command::new("claude");
    command.arg("-p").arg("--output-format").arg("text");
    if !model.is_empty() && model != "default" {
        command.arg("--model").arg(model);
    }
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|e| {
        ProviderError::Provider(format!(
            "claude CLI를 실행할 수 없습니다(설치·PATH 확인): {}",
            e
        ))
    })?;

    // 프롬프트를 stdin으로 넘기고 닫는다(EOF로 입력 종료를 알린다).
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes());
    }

    // 취소/타임아웃을 폴링하며 종료를 기다린다.
    let start = Instant::now();
    let status = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            return Err(ProviderError::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => return Err(ProviderError::Provider(format!("CLI 대기 실패: {}", e))),
        }
        if start.elapsed() > Duration::from_secs(CLI_TIMEOUT_SECS) {
            let _ = child.kill();
            return Err(ProviderError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(50));
    };

    let mut stdout = String::new();
    if let Some(mut out) = child.stdout.take() {
        let _ = out.read_to_string(&mut stdout);
    }
    if !status.success() {
        let mut stderr = String::new();
        if let Some(mut err) = child.stderr.take() {
            let _ = err.read_to_string(&mut stderr);
        }
        let detail = stderr.trim();
        return Err(ProviderError::Provider(format!(
            "claude CLI 오류{}",
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {}", detail)
            }
        )));
    }
    Ok(stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request() -> LlmRequest {
        LlmRequest {
            system_prompt: "당신은 보조자".to_string(),
            user_prompt: "첫 문단 바꿔줘".to_string(),
            document_context_json: "{\"content\":[]}".to_string(),
            output_schema: json!({ "type": "object" }),
            images: Vec::new(),
            documents: Vec::new(),
            file_paths: Vec::new(),
        }
    }

    #[test]
    fn prompt_includes_system_context_and_json_only_instruction() {
        let prompt = ClaudeCliProvider::build_prompt(&request());
        assert!(prompt.contains("당신은 보조자"));
        assert!(prompt.contains("첫 문단 바꿔줘"));
        assert!(prompt.contains("[문서 컨텍스트]"));
        assert!(prompt.contains("출력 JSON 스키마"));
        assert!(prompt.contains("JSON만 출력"));
        // 첨부 파일이 없으면 참고 파일 섹션은 나오지 않는다.
        assert!(!prompt.contains("참고 첨부 파일"));
    }

    #[test]
    fn prompt_lists_attached_file_paths() {
        let mut req = request();
        req.file_paths = vec!["/Users/me/Downloads/계획서.pdf".to_string()];
        let prompt = ClaudeCliProvider::build_prompt(&req);
        assert!(prompt.contains("[참고 첨부 파일"));
        assert!(prompt.contains("/Users/me/Downloads/계획서.pdf"));
    }
}
