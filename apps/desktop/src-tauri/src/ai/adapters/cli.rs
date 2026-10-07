//! 로컬 CLI 위임 어댑터(스펙 5.3장 — API 키 없이 구독 활용).
//!
//! 사용자가 터미널에서 이미 로그인해 둔 CLI(`claude` / `agy`)를 자식 프로세스로
//! 호출한다. OAuth·구독·과금은 CLI가 처리하므로 앱은 API 키를 다루지 않는다.
//! 프롬프트를 stdin으로 넘기고 stdout(텍스트)을 받아, 다른 provider와 동일하게
//! 코어가 파싱·검증·diff·승인 적용한다.
//!
//! 네이티브 구조화 출력은 없다 — "JSON만 출력" 지시 + 코어의 코드펜스 제거/`{...}`
//! 추출/파싱 방어에 의존한다. claude는 stream-json으로 실행해 생성 중인 텍스트를 실시간으로
//! 흘려보내고(진행 표시), agy는 평문 줄 단위로 흘려보낸다.

use super::user_content;
use crate::ai::provider::{CancelToken, DeltaSink, LlmProvider, LlmRequest, ProviderError};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// CLI 응답 대기 상한(초). 초과 시 프로세스를 종료하고, 그때까지 받은 응답에 완결된 편집이
/// 있으면 그것만 살리고 없으면 TIMEOUT 처리.
///
/// 에이전트형 CLI(claude/agy)는 단발 API가 아니라 추론 루프라 느리고, 문서 전체를 새로
/// 쓰는 작업은 입력·출력이 모두 크다(10쪽 사업계획서가 실측 6분 남짓, 약 53토큰/초).
/// 진행이 실시간으로 보이고 언제든 중지할 수 있으므로 넉넉히 둔다.
const CLI_TIMEOUT_SECS: u64 = 1200;

/// CLI 표준 출력 형식.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliOutput {
    /// 응답 텍스트만 평문으로 나온다(agy).
    Text,
    /// 줄마다 JSON 이벤트(claude `--output-format stream-json --include-partial-messages`).
    StreamJson,
}

/// 범용 CLI provider. 실행 파일·기본 인자·모델 플래그만 다르고 동작은 동일하다.
pub struct CliProvider {
    /// 실행 파일 이름(PATH 기준). 예: `claude`, `agy`.
    pub program: &'static str,
    /// 비대화형 실행을 위한 고정 인자. 예: claude `-p --output-format text`.
    pub base_args: &'static [&'static str],
    /// 모델 지정 플래그. 예: claude `--model`, agy `--model`. 없으면 모델 미지정.
    pub model_flag: Option<&'static str>,
    /// 모델 값. 비었거나 "default"면 CLI 기본 모델을 쓴다.
    pub model: String,
    /// 표준 출력 형식(실시간 진행 표시 방식이 다르다).
    pub output: CliOutput,
}

impl CliProvider {
    pub fn claude(model: String) -> Self {
        CliProvider {
            program: "claude",
            // `--safe-mode`: CLAUDE.md·플러그인·훅·MCP 등 사용자 커스터마이징을 모두 끈다
            // (인증·모델 선택은 유지). 이게 없으면 전역 설치된 플러그인(예: cladding)의
            // Stop 훅이 게이트 findings를 내뱉고, 에이전트형 claude가 그것에 반응해
            //  (1) 순수 JSON 대신 거버넌스 설명문을 응답으로 내고(파싱 실패),
            //  (2) 그 findings를 두고 추론 루프를 돌며 수 분을 허비한다(타임아웃).
            // 측정: 동일 작업이 safe-mode 없이 7분38초→safe-mode로 1분50초, 출력도 유효 JSON.
            // stream-json + 부분 메시지: 생성 중인 텍스트가 줄 단위 이벤트로 바로 나온다
            // (`--verbose`는 print 모드 stream-json의 필수 조건).
            base_args: &[
                "-p",
                "--output-format",
                "stream-json",
                "--include-partial-messages",
                "--verbose",
                "--safe-mode",
            ],
            model_flag: Some("--model"),
            model,
            output: CliOutput::StreamJson,
        }
    }

    pub fn agy(model: String) -> Self {
        CliProvider {
            program: "agy",
            // agy의 `-p`(=`--print`)는 단발 비대화형 실행이며, 프롬프트는 stdin으로 받는다
            // (claude의 플래그형 `-p`와 동일). 출력은 응답 텍스트만 평문으로 나온다.
            base_args: &["-p"],
            model_flag: Some("--model"),
            model,
            output: CliOutput::Text,
        }
    }

    /// CLI에 stdin으로 넘길 전체 프롬프트(시스템 + 컨텍스트 + 첨부 경로 + 스키마 + JSON-only).
    fn build_prompt(req: &LlmRequest) -> String {
        // 스키마는 들여쓰기 없이 한 줄로 — 보기 좋게 펼치면 프롬프트의 대부분(실측 65%)이
        // 공백이 되어 매 요청 입력 토큰만 늘린다.
        let schema = serde_json::to_string(&req.output_schema).unwrap_or_default();
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
impl LlmProvider for CliProvider {
    async fn generate_edit(
        &self,
        req: LlmRequest,
        on_delta: DeltaSink,
        cancel: CancelToken,
    ) -> Result<String, ProviderError> {
        let prompt = Self::build_prompt(&req);
        let program = self.program;
        let base_args = self.base_args;
        let model_flag = self.model_flag;
        let model = self.model.clone();
        let output = self.output;
        let sink: Arc<DeltaSink> = Arc::new(on_delta);
        tauri::async_runtime::spawn_blocking(move || {
            run_cli(program, base_args, model_flag, &model, &prompt, output, sink, &cancel)
        })
        .await
        .map_err(|e| ProviderError::Provider(format!("CLI 실행 태스크 실패: {}", e)))?
    }
}

/// stream-json 한 줄을 해석한 결과.
#[derive(Debug, PartialEq, Eq)]
pub enum StreamLine {
    /// 생성 중인 응답 텍스트 조각(text_delta).
    Delta(String),
    /// 최종 결과 텍스트(type=result, 성공).
    Result(String),
    /// 최종 결과가 오류(type=result, is_error).
    Error(String),
    /// 진행·사고(thinking)·메타데이터 등 — 무시.
    Other,
}

/// claude `--output-format stream-json` 출력 한 줄을 해석한다(네트워크 없이 테스트 가능).
pub fn parse_stream_json_line(line: &str) -> StreamLine {
    let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
        return StreamLine::Other;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("stream_event") => {
            let event = &value["event"];
            if event.get("type").and_then(Value::as_str) == Some("content_block_delta")
                && event["delta"].get("type").and_then(Value::as_str) == Some("text_delta")
            {
                if let Some(text) = event["delta"].get("text").and_then(Value::as_str) {
                    return StreamLine::Delta(text.to_string());
                }
            }
            StreamLine::Other
        }
        Some("result") => {
            let text = value.get("result").and_then(Value::as_str).unwrap_or("").to_string();
            if value.get("is_error").and_then(Value::as_bool) == Some(true) {
                let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("error");
                StreamLine::Error(if text.trim().is_empty() { subtype.to_string() } else { text })
            } else {
                StreamLine::Result(text)
            }
        }
        _ => StreamLine::Other,
    }
}

/// 실행 중에 모은 표준 출력.
#[derive(Default)]
struct Collected {
    /// 지금까지 받은 응답 텍스트(stream-json의 text_delta 누적 또는 평문 전체).
    text: String,
    /// stream-json 최종 결과.
    result: Option<String>,
    /// stream-json 최종 오류.
    error: Option<String>,
}

/// CLI 자식 프로세스를 실행한다. 협조적 취소·타임아웃을 폴링으로 처리한다.
///
/// stdout·stderr는 실행 중에 별도 스레드가 계속 읽는다 — 종료 뒤에 읽으면 출력이 파이프
/// 버퍼(약 64KB)를 넘는 긴 응답에서 CLI가 쓰기에서 막혀 끝나지 않는다.
#[allow(clippy::too_many_arguments)]
fn run_cli(
    program: &str,
    base_args: &[&str],
    model_flag: Option<&str>,
    model: &str,
    prompt: &str,
    output: CliOutput,
    on_delta: Arc<DeltaSink>,
    cancel: &CancelToken,
) -> Result<String, ProviderError> {
    let mut command = Command::new(program);
    command.args(base_args);
    if let Some(flag) = model_flag {
        if !model.is_empty() && model != "default" {
            command.arg(flag).arg(model);
        }
    }
    // 중립 디렉터리에서 실행한다. 에이전트형 CLI는 실행 디렉터리의 `CLAUDE.md`·`.cladding`
    // 같은 프로젝트 컨텍스트를 자동으로 읽어들여 순수 JSON 대신 설명문을 낼 수 있다.
    // claude는 `--safe-mode`로 그 유입을 원천 차단하지만(전역 플러그인·훅까지), safe-mode
    // 류 플래그가 없는 CLI(agy 등)를 위한 2차 방어선으로 cwd도 프로젝트 밖으로 둔다.
    command.current_dir(std::env::temp_dir());
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|e| {
        ProviderError::Provider(format!(
            "{} CLI를 실행할 수 없습니다(설치·PATH 확인): {}",
            program, e
        ))
    })?;

    // 프롬프트를 stdin으로 넘기고 닫는다(EOF로 입력 종료를 알린다). 큰 프롬프트에서 서로
    // 기다리지 않도록 쓰기도 별도 스레드에서 한다.
    let writer = child.stdin.take().map(|mut stdin| {
        let prompt = prompt.to_string();
        std::thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
        })
    });

    let collected = Arc::new(Mutex::new(Collected::default()));
    let reader = child.stdout.take().map(|stdout| {
        let collected = Arc::clone(&collected);
        let on_delta = Arc::clone(&on_delta);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let mut c = collected.lock().unwrap_or_else(|e| e.into_inner());
                match output {
                    CliOutput::Text => {
                        c.text.push_str(&line);
                        c.text.push('\n');
                        on_delta(format!("{}\n", line));
                    }
                    CliOutput::StreamJson => match parse_stream_json_line(&line) {
                        StreamLine::Delta(text) => {
                            c.text.push_str(&text);
                            on_delta(text);
                        }
                        StreamLine::Result(text) => c.result = Some(text),
                        StreamLine::Error(message) => c.error = Some(message),
                        StreamLine::Other => {}
                    },
                }
            }
        })
    });
    let stderr_text = Arc::new(Mutex::new(String::new()));
    let err_reader = child.stderr.take().map(|mut stderr| {
        let stderr_text = Arc::clone(&stderr_text);
        std::thread::spawn(move || {
            let mut buf = String::new();
            let _ = stderr.read_to_string(&mut buf);
            *stderr_text.lock().unwrap_or_else(|e| e.into_inner()) = buf;
        })
    });
    let join_all = |writer: Option<std::thread::JoinHandle<()>>,
                    reader: Option<std::thread::JoinHandle<()>>,
                    err_reader: Option<std::thread::JoinHandle<()>>| {
        for handle in [writer, reader, err_reader].into_iter().flatten() {
            let _ = handle.join();
        }
    };

    // 취소/타임아웃을 폴링하며 종료를 기다린다.
    let start = Instant::now();
    let status = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            join_all(writer, reader, err_reader);
            return Err(ProviderError::Cancelled);
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => return Err(ProviderError::Provider(format!("CLI 대기 실패: {}", e))),
        }
        if start.elapsed() > Duration::from_secs(CLI_TIMEOUT_SECS) {
            let _ = child.kill();
            let _ = child.wait();
            join_all(writer, reader, err_reader);
            // 그때까지 받은 응답에서 끝까지 닫힌 편집이 있으면 살린다.
            let text = std::mem::take(&mut collected.lock().unwrap_or_else(|e| e.into_inner()).text);
            return crate::ai::schema::salvage_truncated_script(&text).ok_or(ProviderError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    join_all(writer, reader, err_reader);

    let collected = std::mem::take(&mut *collected.lock().unwrap_or_else(|e| e.into_inner()));
    let stderr = std::mem::take(&mut *stderr_text.lock().unwrap_or_else(|e| e.into_inner()));
    if !status.success() || collected.error.is_some() {
        let detail = collected.error.as_deref().unwrap_or(stderr.trim()).trim().to_string();
        // 인증 미설정은 흔한 사용자 단계 — 원본 덤프 대신 명확한 안내로 바꾼다.
        let lower = format!("{} {}", detail, stderr).to_lowercase();
        if lower.contains("auth") || lower.contains("api_key") || lower.contains("login") {
            return Err(ProviderError::Provider(format!(
                "{program} CLI 로그인이 필요합니다. 터미널에서 `{program}`을 한 번 실행해 \
                 로그인(또는 API 키 설정)을 마친 뒤 다시 시도하세요."
            )));
        }
        return Err(ProviderError::Provider(format!(
            "{} CLI 오류{}",
            program,
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {}", detail)
            }
        )));
    }
    // stream-json은 최종 result가 정본이다(없으면 받은 조각을 이어 붙인 텍스트).
    Ok(match output {
        CliOutput::StreamJson => collected.result.unwrap_or(collected.text),
        CliOutput::Text => collected.text,
    })
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
        let prompt = CliProvider::build_prompt(&request());
        assert!(prompt.contains("당신은 보조자"));
        assert!(prompt.contains("첫 문단 바꿔줘"));
        assert!(prompt.contains("[문서 컨텍스트]"));
        assert!(prompt.contains("출력 JSON 스키마"));
        assert!(prompt.contains("JSON만 출력"));
        assert!(!prompt.contains("참고 첨부 파일"));
    }

    #[test]
    fn prompt_lists_attached_file_paths() {
        let mut req = request();
        req.file_paths = vec!["/Users/me/Downloads/계획서.pdf".to_string()];
        let prompt = CliProvider::build_prompt(&req);
        assert!(prompt.contains("[참고 첨부 파일"));
        assert!(prompt.contains("/Users/me/Downloads/계획서.pdf"));
    }

    #[test]
    fn claude_and_agy_configs_differ() {
        assert_eq!(CliProvider::claude("default".into()).program, "claude");
        assert_eq!(CliProvider::agy("default".into()).program, "agy");
        assert_eq!(CliProvider::agy("x".into()).model_flag, Some("--model"));
    }

    // ── F-a7b2c7ba AC-ddb1ecc5: stream-json 실시간 진행·파이프 버퍼 교착 없음·1,200초·한 줄 스키마 ──

    #[test]
    fn f_a7b2c7ba_ac_ddb1ecc5_text_delta_lines_stream_as_deltas() {
        let line = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"{\"edits\":[{\"command\""}},"session_id":"s1","parent_tool_use_id":null}"#;
        assert_eq!(
            parse_stream_json_line(line),
            StreamLine::Delta(r#"{"edits":[{"command""#.to_string())
        );
        // 줄 끝 \r·앞뒤 공백이 있어도 같다.
        assert_eq!(
            parse_stream_json_line(&format!("  {line}\r")),
            StreamLine::Delta(r#"{"edits":[{"command""#.to_string())
        );
    }

    #[test]
    fn f_a7b2c7ba_ac_ddb1ecc5_progress_thinking_and_metadata_lines_are_ignored() {
        for line in [
            r#"{"type":"system","subtype":"init","cwd":"/tmp","session_id":"s1","tools":["Read"],"model":"claude-opus-5-5","permissionMode":"default"}"#,
            r#"{"type":"system","subtype":"status","status":"compacting","session_id":"s1"}"#,
            r#"{"type":"stream_event","event":{"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[]}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"문서를 먼저 살펴보면"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqQBCkgIBxABGAIqQ"}}}"#,
            r#"{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"a\""}}}"#,
            r#"{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"end_turn"}}}"#,
            // 완성 메시지 스냅샷 — 이미 델타로 받은 텍스트라 다시 세면 중복된다.
            r#"{"type":"assistant","message":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"{\"edits\":[]}"}]},"session_id":"s1"}"#,
            r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1760000000}}"#,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}"#,
        ] {
            assert_eq!(parse_stream_json_line(line), StreamLine::Other, "{line}");
        }
    }

    #[test]
    fn f_a7b2c7ba_ac_ddb1ecc5_result_line_is_the_final_answer() {
        let line = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":81234,"num_turns":1,"result":"{\"edits\":[],\"message\":\"완료\"}","session_id":"s1","total_cost_usd":0.12}"#;
        assert_eq!(
            parse_stream_json_line(line),
            StreamLine::Result(r#"{"edits":[],"message":"완료"}"#.to_string())
        );
    }

    #[test]
    fn f_a7b2c7ba_ac_ddb1ecc5_error_results_carry_the_text_or_subtype() {
        assert_eq!(
            parse_stream_json_line(
                r#"{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}"#
            ),
            StreamLine::Error("Invalid API key · Please run /login".to_string())
        );
        assert_eq!(
            parse_stream_json_line(r#"{"type":"result","subtype":"error_max_turns","is_error":true}"#),
            StreamLine::Error("error_max_turns".to_string())
        );
        assert_eq!(
            parse_stream_json_line(r#"{"type":"result","subtype":"error_during_execution","is_error":true,"result":"  "}"#),
            StreamLine::Error("error_during_execution".to_string())
        );
    }

    #[test]
    fn f_a7b2c7ba_ac_ddb1ecc5_garbage_and_blank_lines_are_ignored() {
        for line in ["", "   ", "not json", r#"{"type":"#, "[1,2,3]", r#"{"no_type":true}"#, "Warning: something"] {
            assert_eq!(parse_stream_json_line(line), StreamLine::Other, "{line:?}");
        }
    }

    #[test]
    fn f_a7b2c7ba_ac_ddb1ecc5_claude_runs_stream_json_with_partial_messages_and_agy_stays_text() {
        let claude = CliProvider::claude("default".into());
        for flag in ["-p", "stream-json", "--include-partial-messages", "--verbose", "--safe-mode"] {
            assert!(claude.base_args.contains(&flag), "{flag}: {:?}", claude.base_args);
        }
        let format_at = claude.base_args.iter().position(|a| *a == "--output-format").expect("--output-format");
        assert_eq!(claude.base_args.get(format_at + 1), Some(&"stream-json"));
        assert_eq!(claude.output, CliOutput::StreamJson);

        let agy = CliProvider::agy("default".into());
        assert_eq!(agy.output, CliOutput::Text);
        assert_eq!(agy.base_args, &["-p"]);
    }

    #[test]
    fn f_a7b2c7ba_ac_ddb1ecc5_response_wait_limit_is_1200_seconds() {
        assert_eq!(CLI_TIMEOUT_SECS, 1200);
    }

    #[test]
    fn f_a7b2c7ba_ac_ddb1ecc5_prompt_embeds_the_schema_on_one_line() {
        let mut req = request();
        req.output_schema = crate::ai::schema::action_script_schema();
        let compact = serde_json::to_string(&req.output_schema).unwrap();
        let pretty = serde_json::to_string_pretty(&req.output_schema).unwrap();
        assert_ne!(compact, pretty);
        let prompt = CliProvider::build_prompt(&req);
        assert!(prompt.contains(&compact), "한 줄 스키마가 그대로 들어가야 한다");
        assert!(!prompt.contains(&pretty), "들여쓴 스키마를 보내면 안 된다");
        // 스키마 머리말 바로 다음 줄이 스키마 전체다.
        let after = prompt.split("[반드시 만족할 출력 JSON 스키마]\n").nth(1).expect("스키마 머리말");
        assert_eq!(after.lines().next(), Some(compact.as_str()));
    }

    #[cfg(unix)]
    mod run_cli_pipes {
        use super::*;
        use std::sync::atomic::AtomicBool;

        /// 받은 델타를 이어 붙이는 싱크.
        fn collecting_sink() -> (Arc<DeltaSink>, Arc<Mutex<String>>) {
            let got = Arc::new(Mutex::new(String::new()));
            let sink_got = Arc::clone(&got);
            let sink: DeltaSink = Box::new(move |text: String| sink_got.lock().unwrap().push_str(&text));
            (Arc::new(sink), got)
        }

        fn not_cancelled() -> CancelToken {
            Arc::new(AtomicBool::new(false))
        }

        /// run_cli를 별도 스레드에서 돌리고 제한 시간 안에 끝나지 않으면 실패시킨다 — 파이프
        /// 교착이 되살아나면 1,200초 시간 초과까지 매달리지 않고 바로 드러나게.
        fn run_with_watchdog(
            script: String,
            prompt: String,
            output: CliOutput,
            sink: Arc<DeltaSink>,
        ) -> Result<String, ProviderError> {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let result = run_cli("/bin/sh", &["-c", script.as_str()], None, "", &prompt, output, sink, &not_cancelled());
                let _ = tx.send(result);
            });
            rx.recv_timeout(Duration::from_secs(20))
                .expect("run_cli가 20초 안에 끝나지 않았다 — stdout/stderr 파이프 교착")
        }

        /// 84자(252바이트) 델타 1,000줄(stdout ≈ 330KB) + stderr ≈ 90KB — 둘 다 파이프 버퍼(64KB)를 넘는다.
        const DELTA: &str = "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호구누두루무부수우주추쿠투푸후그느드르므브스으즈츠크트프흐기니디리미비시이지치키티피히";

        #[test]
        fn f_a7b2c7ba_ac_ddb1ecc5_stream_json_output_beyond_the_pipe_buffer_does_not_deadlock() {
            assert!(DELTA.len() * 1000 > 70 * 1024);
            let script = format!(
                "cat >/dev/null; i=0; while [ $i -lt 1000 ]; do \
                 printf '%s\\n' '{{\"type\":\"stream_event\",\"event\":{{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":\"{DELTA}\"}}}}}}'; \
                 printf '%s\\n' 'progress line padding padding padding padding padding padding padding padding padding' >&2; \
                 i=$((i+1)); done; \
                 printf '%s\\n' '{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"{{\\\"edits\\\":[],\\\"message\\\":\\\"done\\\"}}\"}}'"
            );
            // 프롬프트도 파이프 버퍼보다 크게 — 쓰기와 읽기가 서로를 기다리지 않아야 한다.
            let prompt = "프롬프트 ".repeat(20_000);
            let (sink, got) = collecting_sink();
            let started = Instant::now();

            let result = run_with_watchdog(script, prompt, CliOutput::StreamJson, sink);

            assert!(started.elapsed() < Duration::from_secs(10), "출력이 커도 바로 끝나야 한다: {:?}", started.elapsed());
            assert_eq!(result.unwrap(), r#"{"edits":[],"message":"done"}"#);
            let streamed = got.lock().unwrap().clone();
            assert!(streamed.len() > 70 * 1024, "스트리밍된 델타가 64KB를 넘어야 한다: {}", streamed.len());
            assert_eq!(streamed, DELTA.repeat(1000), "생성 중인 텍스트가 실시간으로 그대로 흘러야 한다");
        }

        #[test]
        fn f_a7b2c7ba_ac_ddb1ecc5_text_output_beyond_the_pipe_buffer_is_returned_whole() {
            let script = "cat >/dev/null; i=0; while [ $i -lt 2000 ]; do \
                          printf 'line %05d %s\\n' $i 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; i=$((i+1)); done";
            let (sink, got) = collecting_sink();

            let result = run_with_watchdog(script.to_string(), "질문".to_string(), CliOutput::Text, sink);

            let expected: String = (0..2000)
                .map(|i| format!("line {i:05} xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n"))
                .collect();
            assert!(expected.len() > 70 * 1024);
            assert_eq!(result.unwrap(), expected);
            assert_eq!(*got.lock().unwrap(), expected, "평문 모드도 줄마다 실시간으로 흘린다");
        }

        #[test]
        fn f_a7b2c7ba_ac_ddb1ecc5_error_result_line_becomes_a_provider_error() {
            let script = "cat >/dev/null; printf '%s\\n' '{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"result\":\"overloaded\"}'";
            let (sink, _) = collecting_sink();
            let result = run_cli("/bin/sh", &["-c", script], None, "", "질문", CliOutput::StreamJson, sink, &not_cancelled());
            match result {
                Err(ProviderError::Provider(message)) => assert!(message.contains("overloaded"), "{message}"),
                other => panic!("Provider 오류여야 한다: {other:?}"),
            }
        }
    }
}
