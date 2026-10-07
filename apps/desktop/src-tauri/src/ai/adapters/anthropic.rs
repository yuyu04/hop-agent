//! Anthropic(Claude) 어댑터(스펙 5장).
//!
//! `tools`로 Action Script 스키마를 넘겨 도구 입력(JSON)으로 구조화 출력을 받는다.
//! 스트리밍 시 `content_block_delta`의 `input_json_delta`(`partial_json`) 조각을
//! 누적하면 최종 도구 입력 JSON이 된다.
//!
//! 세대별 요청 차이(2026-10 기준):
//! - Claude Opus 5.5 / Sonnet 5.5 / Fable 5.1 이후 모델은 강제 도구 호출
//!   (`tool_choice: tool|any`)을 400으로 거부한다 → `auto` + 프롬프트 지시로 유도하고,
//!   호출이 없으면 한 번 다시 묻는다.
//! - 최신 모델은 thinking이 항상 켜져 있고 thinking 토큰도 `max_tokens`에 포함된다 →
//!   긴 문서 생성이 잘리지 않게 넉넉히 잡는다(스트리밍이라 타임아웃 걱정 없음).
//! - 안전 분류기가 요청을 거절하면(`stop_reason: refusal`) 서버측 fallback으로 다른
//!   모델이 이어받게 한다(`fallbacks: "default"`, beta 헤더). 스트림 중간에 이어받으면
//!   새 `tool_use` 블록이 시작되므로, 마지막 `tool_use` 블록의 입력만 결과로 쓴다.

use super::sse::{map_reqwest_err, stream_sse};
use super::{http_client, user_content};
use crate::ai::provider::{CancelToken, DeltaSink, LlmProvider, LlmRequest, ProviderError};
use serde_json::{json, Value};

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const TOOL_NAME: &str = "emit_action_script";
/// thinking 토큰까지 포함한 출력 상한 — 출력 상한이 작은 모델(Haiku 4.5: 64K)·구세대용 기본값.
const MAX_TOKENS: u32 = 32_000;
/// 출력 상한이 128K인 모델(Claude 5.x, Opus/Sonnet 4.6~4.8)에 주는 상한. 10쪽 넘는 문서를
/// 한 번에 쓰면 본문만 2~3만 토큰에 thinking이 더해져 32K로는 잘렸다(2026-10-08 실측).
const MAX_TOKENS_LARGE: u32 = 64_000;
/// 거절 시 서버가 카테고리별로 대체 모델을 고르는 `fallbacks: "default"` 형식의 beta.
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";
/// `auto` 모드에서 도구 호출을 유도하는 지시(시스템 프롬프트 끝에 붙인다).
const TOOL_INSTRUCTION: &str = "\n\n결과는 반드시 `emit_action_script` 도구를 정확히 한 번 호출해 \
그 입력으로 반환하라. 도구 밖의 일반 텍스트로 답하지 마라.";

pub struct AnthropicProvider {
    pub api_key: String,
    pub model: String,
}

/// 모델이 강제 도구 호출(`tool_choice: {type: "tool"}`)을 받는가.
///
/// 이를 받는 것은 Claude Opus 5 / Sonnet 5 / Fable 5 세대까지다. 그 뒤 모델
/// (Opus 5.5, Sonnet 5.5, Fable 5.1, Mythos 5.1 …)은 400을 내므로, 알려진 구세대가
/// 아니면 `auto`로 보낸다 — 새 모델이 나와도 요청 자체가 깨지지 않는 쪽이 안전하다.
pub fn supports_forced_tool_choice(model: &str) -> bool {
    let id = model.trim().to_ascii_lowercase();
    // 날짜 스냅샷(`-20250929`)이나 Vertex 식 `@날짜`를 떼고 비교한다.
    let id = id.split('@').next().unwrap_or("");
    let parts: Vec<&str> = strip_date_suffix(id).split('-').collect();
    if parts.first() != Some(&"claude") || parts.len() < 3 {
        return false;
    }
    // claude-3-5-sonnet 처럼 버전이 앞에 오는 구세대 명명.
    if parts[1].bytes().all(|b| b.is_ascii_digit()) {
        return true;
    }
    match parts[2].parse::<u32>() {
        Ok(major) if major <= 4 => true,
        // claude-opus-5 / sonnet-5 / fable-5 / mythos-5 (소수 버전 없음)까지만.
        Ok(5) => parts.len() == 3,
        _ => false,
    }
}

/// 모델에 맞는 `max_tokens`. 128K 출력 모델이면 넉넉히, 그 밖은 기본값.
pub fn max_tokens_for(model: &str) -> u32 {
    let id = model.trim().to_ascii_lowercase();
    let id = id.split('@').next().unwrap_or("");
    let parts: Vec<&str> = strip_date_suffix(id).split('-').collect();
    if parts.first() != Some(&"claude") || parts.len() < 3 {
        return MAX_TOKENS;
    }
    let family = parts[1];
    if !matches!(family, "opus" | "sonnet" | "fable" | "mythos") {
        return MAX_TOKENS;
    }
    let major = parts[2].parse::<u32>().unwrap_or(0);
    let minor = parts.get(3).and_then(|p| p.parse::<u32>().ok()).unwrap_or(0);
    if major >= 5 || (major == 4 && minor >= 6) {
        MAX_TOKENS_LARGE
    } else {
        MAX_TOKENS
    }
}

/// 서버측 refusal fallback을 켤 모델. 안전 분류기를 쓰는 현행 상위 모델만 해당한다.
pub fn wants_refusal_fallback(model: &str) -> bool {
    matches!(
        strip_date_suffix(model.trim()),
        "claude-fable-5-1" | "claude-opus-5-5" | "claude-opus-5" | "claude-sonnet-5-5"
    )
}

fn strip_date_suffix(id: &str) -> &str {
    match id.rsplit_once('-') {
        Some((head, tail)) if tail.len() == 8 && tail.bytes().all(|b| b.is_ascii_digit()) => head,
        _ => id,
    }
}

impl AnthropicProvider {
    #[cfg(test)]
    pub fn build_body(&self, req: &LlmRequest) -> Value {
        self.build_body_with(req, wants_refusal_fallback(&self.model), false)
    }

    /// `with_fallback`: 서버측 refusal fallback 포함 여부. `nudge`: `auto` 모드에서 도구를
    /// 호출하지 않아 다시 묻는 재시도인지(지시를 한 번 더 강조한다).
    fn build_body_with(&self, req: &LlmRequest, with_fallback: bool, nudge: bool) -> Value {
        let user_message = if req.images.is_empty() && req.documents.is_empty() {
            json!(user_content(req))
        } else {
            let mut blocks = vec![json!({ "type": "text", "text": user_content(req) })];
            for image in &req.images {
                blocks.push(json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": image.mime_type,
                        "data": image.data_base64,
                    }
                }));
            }
            // PDF 등 문서는 document 블록으로(Anthropic은 application/pdf 지원).
            for doc in &req.documents {
                blocks.push(json!({
                    "type": "document",
                    "source": {
                        "type": "base64",
                        "media_type": doc.mime_type,
                        "data": doc.data_base64,
                    }
                }));
            }
            json!(blocks)
        };
        let forced = supports_forced_tool_choice(&self.model);
        let mut system = req.system_prompt.clone();
        if !forced {
            system.push_str(TOOL_INSTRUCTION);
            if nudge {
                system.push_str("\n직전 응답에 도구 호출이 없었다. 이번에는 반드시 도구로 답하라.");
            }
        }
        let tool_choice = if forced {
            json!({ "type": "tool", "name": TOOL_NAME })
        } else {
            json!({ "type": "auto" })
        };
        let mut body = json!({
            "model": self.model,
            "max_tokens": max_tokens_for(&self.model),
            "stream": true,
            "system": system,
            "messages": [
                { "role": "user", "content": user_message }
            ],
            "tools": [{
                "name": TOOL_NAME,
                "description": "검증된 Action Script(JSON)를 반환한다.",
                "input_schema": req.output_schema,
            }],
            "tool_choice": tool_choice,
        });
        if with_fallback {
            body["fallbacks"] = json!("default");
        }
        body
    }

    async fn stream_once(
        &self,
        req: &LlmRequest,
        with_fallback: bool,
        nudge: bool,
        on_delta: &DeltaSink,
        cancel: &CancelToken,
    ) -> Result<AnthropicStreamState, ProviderError> {
        let client = http_client()?;
        let mut builder = client
            .post(ANTHROPIC_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", ANTHROPIC_VERSION);
        if with_fallback {
            builder = builder.header("anthropic-beta", FALLBACK_BETA);
        }
        let response = builder
            .json(&self.build_body_with(req, with_fallback, nudge))
            .send()
            .await
            .map_err(map_reqwest_err)?;
        let mut state = AnthropicStreamState::default();
        stream_sse(response, on_delta, cancel, |data| state.on_event(data)).await?;
        Ok(state)
    }
}

/// 한 번의 Messages 스트림에서 모은 상태.
#[derive(Debug, Default)]
pub struct AnthropicStreamState {
    /// 마지막 `tool_use` 블록의 입력 JSON(fallback으로 새 블록이 시작되면 처음부터).
    pub tool_json: String,
    pub saw_tool_use: bool,
    pub stop_reason: Option<String>,
    /// 도구 밖으로 나온 텍스트(도구를 부르지 않았을 때 원인 안내용).
    pub text: String,
}

impl AnthropicStreamState {
    /// SSE `data:` 한 건을 반영하고, UI에 흘릴 도구 입력 조각을 돌려준다.
    pub fn on_event(&mut self, data: &str) -> Option<String> {
        let value: Value = serde_json::from_str(data).ok()?;
        match value.get("type").and_then(Value::as_str)? {
            "content_block_start" => {
                if value["content_block"]["type"] == json!("tool_use") {
                    self.tool_json.clear();
                    self.saw_tool_use = true;
                }
                None
            }
            "content_block_delta" => {
                let delta = &value["delta"];
                if let Some(text) = delta.get("text").and_then(Value::as_str) {
                    self.text.push_str(text);
                    return None;
                }
                let fragment = delta.get("partial_json")?.as_str()?.to_string();
                self.tool_json.push_str(&fragment);
                Some(fragment)
            }
            "message_delta" => {
                if let Some(reason) = value["delta"]["stop_reason"].as_str() {
                    self.stop_reason = Some(reason.to_string());
                }
                None
            }
            _ => None,
        }
    }
}

/// 스트림 하나를 끝낸 뒤의 판정.
#[derive(Debug)]
pub enum StreamVerdict {
    /// 도구 입력 JSON을 받았다.
    Done(String),
    /// `auto` 모드에서 도구를 부르지 않았다 — 지시를 강조해 한 번 더 묻는다.
    Nudge,
    Fail(ProviderError),
}

/// 받은 스트림 상태로 다음 행동을 정한다(네트워크 없이 테스트 가능한 순수 함수).
///
/// 거절(refusal)과 출력 한도 잘림(max_tokens)은 도구 호출 여부와 무관하게 먼저 판정한다 —
/// thinking이나 텍스트 단계에서 한도에 닿으면 도구 블록이 없는데, 그걸 "도구 미호출"로
/// 오인해 재촉하면 같은 한도에 또 걸리고 엉뚱한 원인을 보고한다.
pub fn judge_stream(state: &AnthropicStreamState, forced: bool, already_nudged: bool) -> StreamVerdict {
    match state.stop_reason.as_deref() {
        Some("refusal") => {
            return StreamVerdict::Fail(ProviderError::Provider(
                "모델이 안전 정책으로 요청을 거절했습니다. 다른 모델을 선택하거나 요청을 바꿔 다시 시도하세요."
                    .to_string(),
            ))
        }
        Some("max_tokens") => {
            // 도구 입력이 쓰이다 끊겼으면 끝까지 닫힌 편집만 건져 미리보기로 보낸다.
            if state.saw_tool_use {
                if let Some(json) = crate::ai::schema::salvage_truncated_script(&state.tool_json) {
                    return StreamVerdict::Done(json);
                }
            }
            return StreamVerdict::Fail(ProviderError::Provider(
                "응답이 출력 한도에서 잘렸습니다. 요청을 나눠 다시 시도하세요.".to_string(),
            ));
        }
        _ => {}
    }
    if state.saw_tool_use && !state.tool_json.trim().is_empty() {
        return StreamVerdict::Done(state.tool_json.clone());
    }
    if forced || already_nudged {
        let hint = state.text.trim();
        return StreamVerdict::Fail(ProviderError::Provider(if hint.is_empty() {
            "모델이 편집 결과(도구 호출)를 반환하지 않았습니다.".to_string()
        } else {
            format!(
                "모델이 편집 결과 대신 텍스트로 답했습니다: {}",
                hint.chars().take(200).collect::<String>()
            )
        }));
    }
    StreamVerdict::Nudge
}

fn is_fallback_rejection(error: &ProviderError) -> bool {
    matches!(error, ProviderError::Provider(message)
        if message.starts_with("HTTP 400") && message.contains("fallback"))
}

#[async_trait::async_trait]
impl LlmProvider for AnthropicProvider {
    async fn generate_edit(
        &self,
        req: LlmRequest,
        on_delta: DeltaSink,
        cancel: CancelToken,
    ) -> Result<String, ProviderError> {
        let mut with_fallback = wants_refusal_fallback(&self.model);
        let mut nudge = false;
        // 최대 2회: (fallback 거부 시 끄고 재시도) 또는 (auto에서 도구 미호출 시 재촉).
        for _ in 0..3 {
            let state = match self
                .stream_once(&req, with_fallback, nudge, &on_delta, &cancel)
                .await
            {
                Ok(state) => state,
                Err(error) if with_fallback && is_fallback_rejection(&error) => {
                    // beta가 이 계정·모델에서 막혀 있으면 fallback 없이 그대로 보낸다.
                    with_fallback = false;
                    continue;
                }
                Err(error) => return Err(error),
            };
            match judge_stream(&state, supports_forced_tool_choice(&self.model), nudge) {
                StreamVerdict::Done(json) => return Ok(json),
                StreamVerdict::Fail(error) => return Err(error),
                StreamVerdict::Nudge => {}
            }
            nudge = true;
        }
        Err(ProviderError::Provider(
            "모델이 편집 결과(도구 호출)를 반환하지 않았습니다.".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> LlmRequest {
        LlmRequest {
            system_prompt: "sys".to_string(),
            user_prompt: "표 추가".to_string(),
            document_context_json: "{\"content\":[]}".to_string(),
            output_schema: json!({ "type": "object", "marker": 7 }),
            images: Vec::new(),
            documents: Vec::new(),
            file_paths: Vec::new(),
        }
    }

    fn provider() -> AnthropicProvider {
        AnthropicProvider {
            api_key: "k".to_string(),
            model: "claude-x".to_string(),
        }
    }

    fn provider_for(model: &str) -> AnthropicProvider {
        AnthropicProvider {
            api_key: "k".to_string(),
            model: model.to_string(),
        }
    }

    #[test]
    fn unknown_new_models_use_auto_tool_choice_with_prompt_steering() {
        let body = provider().build_body(&request());
        assert_eq!(body["model"], json!("claude-x"));
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["tool_choice"], json!({ "type": "auto" }));
        assert!(body["system"].as_str().unwrap().contains(TOOL_NAME));
        assert_eq!(body["tools"][0]["name"], json!(TOOL_NAME));
        assert_eq!(
            body["tools"][0]["input_schema"],
            json!({ "type": "object", "marker": 7 })
        );
    }

    #[test]
    fn older_generations_keep_forced_tool_choice() {
        for model in [
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-opus-4-8",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
            "claude-haiku-4-5-20251001",
            "claude-opus-4-5@20251101",
            "claude-3-5-sonnet-20241022",
        ] {
            let body = provider_for(model).build_body(&request());
            assert_eq!(
                body["tool_choice"],
                json!({ "type": "tool", "name": TOOL_NAME }),
                "{model}"
            );
            assert_eq!(
                body["system"],
                json!("sys"),
                "{model}: 강제 호출이면 지시를 덧붙이지 않는다"
            );
        }
    }

    #[test]
    fn newest_generation_rejects_forced_tool_choice() {
        for model in [
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-fable-5-1",
            "claude-mythos-5-1",
        ] {
            assert!(!supports_forced_tool_choice(model), "{model}");
            let body = provider_for(model).build_body(&request());
            assert_eq!(body["tool_choice"], json!({ "type": "auto" }), "{model}");
        }
    }

    #[test]
    fn output_budget_covers_thinking_tokens() {
        let body = provider_for("claude-opus-5-5").build_body(&request());
        // 상수끼리 비교하면 상수를 8192로 되돌려도 통과한다 — thinking 포함 32K 이상을 직접 단언.
        let budget = body["max_tokens"].as_u64().expect("max_tokens는 정수");
        assert!(budget >= 32_000, "출력 한도가 thinking을 감안하지 못함: {budget}");
        assert!(
            body.get("temperature").is_none(),
            "최신 모델은 sampling 파라미터를 거부한다"
        );
        assert!(
            body.get("thinking").is_none(),
            "thinking 비활성은 최신 모델에서 400"
        );
    }

    #[test]
    fn refusal_fallback_only_for_classifier_models() {
        let body = provider_for("claude-opus-5-5").build_body(&request());
        assert_eq!(body["fallbacks"], json!("default"));
        for model in ["claude-haiku-4-5", "claude-opus-4-8", "claude-x"] {
            let body = provider_for(model).build_body(&request());
            assert!(body.get("fallbacks").is_none(), "{model}");
        }
    }

    #[test]
    fn stream_state_keeps_only_the_last_tool_use_block() {
        let mut state = AnthropicStreamState::default();
        let events = [
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"emit_action_script"}}"#,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"edits\":[{\"bro"}}"#,
            r#"{"type":"content_block_start","index":1,"content_block":{"type":"fallback"}}"#,
            r#"{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","name":"emit_action_script"}}"#,
            r#"{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"edits\":[]}"}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#,
        ];
        for event in events {
            state.on_event(event);
        }
        assert!(state.saw_tool_use);
        assert_eq!(state.tool_json, r#"{"edits":[]}"#);
        assert_eq!(state.stop_reason.as_deref(), Some("tool_use"));
    }

    #[test]
    fn stream_state_records_text_and_refusal() {
        let mut state = AnthropicStreamState::default();
        state.on_event(r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"설명"}}"#);
        state.on_event(r#"{"type":"message_delta","delta":{"stop_reason":"refusal"}}"#);
        assert!(!state.saw_tool_use);
        assert_eq!(state.text, "설명");
        assert_eq!(state.stop_reason.as_deref(), Some("refusal"));
    }

    #[test]
    fn fallback_rejection_is_detected_only_for_400s_naming_fallback() {
        assert!(is_fallback_rejection(&ProviderError::Provider(
            "HTTP 400 Bad Request: fallbacks is not supported".to_string()
        )));
        assert!(!is_fallback_rejection(&ProviderError::Provider(
            "HTTP 400 Bad Request: tool_choice".to_string()
        )));
        assert!(!is_fallback_rejection(&ProviderError::Timeout));
    }

    #[test]
    fn documents_are_sent_as_document_blocks() {
        use crate::ai::provider::ImageInput;
        let mut req = request();
        req.documents = vec![ImageInput {
            mime_type: "application/pdf".to_string(),
            data_base64: "JVBERi0=".to_string(),
        }];
        let body = provider().build_body(&req);
        let blocks = body["messages"][0]["content"].as_array().unwrap();
        let has_doc = blocks.iter().any(|b| {
            b["type"] == json!("document")
                && b["source"]["media_type"] == json!("application/pdf")
                && b["source"]["data"] == json!("JVBERi0=")
        });
        assert!(has_doc, "PDF가 document 블록으로 포함되어야 한다");
    }

    #[test]
    fn extracts_partial_json_from_content_block_delta() {
        let data = "{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"ed\"}}";
        let mut state = AnthropicStreamState::default();
        assert_eq!(state.on_event(data), Some("{\"ed".to_string()));
        assert_eq!(state.tool_json, "{\"ed");
    }

    #[test]
    fn ignores_non_delta_events() {
        let mut state = AnthropicStreamState::default();
        assert_eq!(state.on_event("{\"type\":\"message_start\",\"message\":{}}"), None);
        assert_eq!(state.on_event("not json"), None);
        assert!(state.tool_json.is_empty());
    }
    // ── F-73cbb137 AC-82aeb866: 잘림·거절은 재요청·파싱하지 않고 원인을 알리는 오류로 끝낸다 ──

    fn state_from(events: &[&str]) -> AnthropicStreamState {
        let mut state = AnthropicStreamState::default();
        for event in events {
            state.on_event(event);
        }
        state
    }

    const TOOL_START: &str =
        r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"emit_action_script"}}"#;

    fn provider_message(verdict: StreamVerdict) -> String {
        match verdict {
            StreamVerdict::Fail(ProviderError::Provider(message)) => message,
            other => panic!("Fail(Provider)가 아니다: {other:?}"),
        }
    }

    #[test]
    fn f73cbb137_ac_82aeb866_refusal_fails_even_if_a_tool_block_started() {
        let state = state_from(&[
            TOOL_START,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"edits\":[]}"}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"refusal"}}"#,
        ]);
        for (forced, nudged) in [(true, false), (false, false), (false, true)] {
            let message = provider_message(judge_stream(&state, forced, nudged));
            assert!(message.contains("안전 정책"), "{message}");
        }
    }

    #[test]
    fn f73cbb137_ac_82aeb866_max_tokens_without_tool_use_fails_instead_of_nudging() {
        // thinking·텍스트 단계에서 한도에 닿아 도구 블록이 아예 없다 — 재촉하면 같은 한도에 또 걸린다.
        let state = state_from(&[
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"먼저 문서를 살펴보면"}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}"#,
        ]);
        assert!(!state.saw_tool_use);
        let verdict = judge_stream(&state, false, false);
        assert!(!matches!(verdict, StreamVerdict::Nudge), "max_tokens를 도구 미호출로 오인했다");
        let message = provider_message(verdict);
        assert!(message.contains("출력 한도"), "{message}");
    }

    #[test]
    fn f73cbb137_ac_82aeb866_max_tokens_mid_tool_json_does_not_return_truncated_json() {
        let state = state_from(&[
            TOOL_START,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"edits\":[{\"comm"}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}"#,
        ]);
        let message = provider_message(judge_stream(&state, true, false));
        assert!(message.contains("출력 한도"), "{message}");
    }

    #[test]
    fn f73cbb137_ac_82aeb866_completed_tool_use_is_done() {
        let state = state_from(&[
            TOOL_START,
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"edits\":[]}"}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"tool_use"}}"#,
        ]);
        for (forced, nudged) in [(true, false), (false, false), (false, true)] {
            match judge_stream(&state, forced, nudged) {
                StreamVerdict::Done(json) => assert_eq!(json, r#"{"edits":[]}"#),
                other => panic!("Done이어야 한다: {other:?}"),
            }
        }
    }

    #[test]
    fn f73cbb137_ac_82aeb866_text_answer_in_auto_mode_is_nudged_once_then_fails_with_hint() {
        let state = state_from(&[
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"표를 추가하겠습니다."}}"#,
            r#"{"type":"message_delta","delta":{"stop_reason":"end_turn"}}"#,
        ]);
        // auto 모드 첫 시도: 한 번 더 묻는다.
        assert!(matches!(judge_stream(&state, false, false), StreamVerdict::Nudge));
        // 이미 재촉했으면: 텍스트 답을 원인으로 보여 주며 실패.
        let message = provider_message(judge_stream(&state, false, true));
        assert!(message.contains("텍스트로 답했습니다"), "{message}");
        assert!(message.contains("표를 추가하겠습니다."), "{message}");
        // 강제 호출 모드에서는 재촉하지 않는다.
        let message = provider_message(judge_stream(&state, true, false));
        assert!(message.contains("표를 추가하겠습니다."), "{message}");
    }

    // ── F-a7b2c7ba AC-ee075a19: max_tokens로 끊긴 도구 입력은 완결된 편집만 살려 Done ──

    /// 도구 입력 JSON 조각 하나를 담은 `input_json_delta` 이벤트.
    fn tool_delta(fragment: &str) -> String {
        json!({
            "type": "content_block_delta",
            "index": 0,
            "delta": { "type": "input_json_delta", "partial_json": fragment }
        })
        .to_string()
    }

    const MAX_TOKENS_STOP: &str = r#"{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}"#;

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_max_tokens_mid_tool_json_salvages_complete_edits() {
        // 도구 입력이 여러 조각으로 흘러오다 세 번째 편집 중간에 한도에 닿았다.
        let fragments = [
            r#"{"message":"보고서 앞부분을 썼습니다.","edits":[{"command":"REPLACE","target_id":"sec[0].p[0]","#,
            r#""payload":{"text":"결과 보고서","style":"title"}},{"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"1. 개요 {요약}","style":"heading"}},"#,
            r#"{"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"끊긴 본"#,
        ];
        let deltas: Vec<String> = fragments.iter().map(|f| tool_delta(f)).collect();
        let mut events: Vec<&str> = vec![TOOL_START];
        events.extend(deltas.iter().map(String::as_str));
        events.push(MAX_TOKENS_STOP);
        let state = state_from(&events);
        assert_eq!(state.stop_reason.as_deref(), Some("max_tokens"));

        for (forced, nudged) in [(true, false), (false, false), (false, true)] {
            let json = match judge_stream(&state, forced, nudged) {
                StreamVerdict::Done(json) => json,
                other => panic!("완결된 편집이 있으면 Done이어야 한다: {other:?}"),
            };
            let script = crate::ai::schema::parse_action_script(&json).expect("살린 JSON은 유효하다");
            let texts: Vec<_> = script.edits.iter().map(|e| e.payload.text.clone().unwrap_or_default()).collect();
            assert_eq!(texts, vec!["결과 보고서", "1. 개요 {요약}"]);
            let message = script.message.unwrap_or_default();
            assert!(message.starts_with("보고서 앞부분을 썼습니다."), "{message}");
            assert!(message.contains("앞의 2건"), "{message}");
            assert!(message.contains("이어서 써줘"), "{message}");
        }
    }

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_max_tokens_with_no_complete_edit_still_fails_with_the_cause() {
        let delta = tool_delta(
            r#"{"message":"다 썼습니다","edits":[{"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"제"#,
        );
        let state = state_from(&[TOOL_START, delta.as_str(), MAX_TOKENS_STOP]);
        for (forced, nudged) in [(true, false), (false, false), (false, true)] {
            let message = provider_message(judge_stream(&state, forced, nudged));
            assert!(message.contains("출력 한도"), "{message}");
        }
    }

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_text_outside_the_tool_is_not_salvaged() {
        // 도구 블록 없이 텍스트로 JSON을 쓰다 한도에 닿으면 살리지 않는다(도구 입력만 정본).
        let state = state_from(&[
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\"edits\":[{\"command\":\"REPLACE\",\"target_id\":\"sec[0].p[0]\",\"payload\":{\"text\":\"a\"}},"}}"#,
            MAX_TOKENS_STOP,
        ]);
        let message = provider_message(judge_stream(&state, false, false));
        assert!(message.contains("출력 한도"), "{message}");
    }

    // ── F-a7b2c7ba AC-ac66fc16: 모델별 출력 한도(5.x·Opus/Sonnet 4.6+ = 64K, 그 밖 32K) ──

    #[test]
    fn f_a7b2c7ba_ac_ac66fc16_large_output_models_get_64000() {
        for base in [
            "claude-opus-5-5",
            "claude-sonnet-5-5",
            "claude-fable-5-1",
            "claude-opus-5",
            "claude-sonnet-5",
            "claude-opus-4-8",
            "claude-opus-4-6",
            "claude-sonnet-4-6",
        ] {
            for model in [base.to_string(), format!("{base}-20260101"), format!("{base}@20260101")] {
                assert_eq!(max_tokens_for(&model), 64_000, "{model}");
            }
        }
    }

    #[test]
    fn f_a7b2c7ba_ac_ac66fc16_other_models_get_32000() {
        for model in [
            "claude-haiku-4-5",
            "claude-haiku-4-5-20251001",
            "claude-opus-4-5",
            "claude-sonnet-4-5",
            "claude-3-5-sonnet-20241022",
            "gpt-4o",
            "",
        ] {
            assert_eq!(max_tokens_for(model), 32_000, "{model}");
        }
    }

    #[test]
    fn f_a7b2c7ba_ac_ac66fc16_request_body_carries_the_model_budget() {
        for (model, budget) in [
            ("claude-opus-5-5", 64_000),
            ("claude-sonnet-4-6-20260101", 64_000),
            ("claude-haiku-4-5", 32_000),
        ] {
            let body = provider_for(model).build_body(&request());
            assert_eq!(body["max_tokens"], json!(budget), "{model}");
        }
    }
}
