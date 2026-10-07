//! 실제 LLM provider 어댑터(스펙 5장)와 공용 빌더.
//!
//! AI 코어(`ai/mod.rs`)는 `build_provider`로 `provider_id`에 맞는 어댑터를 만든다.
//! 어댑터는 `LlmProvider`를 구현하며 "원문 JSON 문자열"까지만 책임진다 —
//! 화이트리스트·스키마 검증은 코어에서 수행한다.

pub mod anthropic;
pub mod cli;
pub mod gemini;
pub mod models;
pub mod openai;
pub mod sse;

use crate::ai::provider::{LlmProvider, LlmRequest, ProviderError};
use anthropic::AnthropicProvider;
use cli::CliProvider;
use gemini::GeminiProvider;
use openai::{OpenAiProvider, StructuredMode};
use std::time::Duration;

const OPENAI_BASE_URL: &str = "https://api.openai.com";
const OLLAMA_BASE_URL: &str = "http://localhost:11434";

/// `provider_id`에 맞는 어댑터를 만든다. 키가 필요한 provider인데 키가 없으면
/// 명확한 에러를 반환한다. `"mock"`은 코어(`ai/mod.rs`)에서 직접 처리한다.
///
/// `"openai-compat"`은 Groq/OpenRouter/Together/LM Studio/사내 게이트웨이 등
/// 임의의 OpenAI 호환 엔드포인트를 위한 범용 어댑터다(스펙 5.3장). `base_url`은
/// 필수, 키는 선택(로컬 LM Studio 등은 키 불필요).
pub fn build_provider(
    provider_id: &str,
    model_id: String,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<Box<dyn LlmProvider>, String> {
    match provider_id {
        "openai" => Ok(Box::new(OpenAiProvider {
            base_url: OPENAI_BASE_URL.to_string(),
            api_key: Some(require_key(provider_id, api_key)?),
            model: model_id,
            structured: StructuredMode::JsonSchema,
        })),
        "ollama" => Ok(Box::new(OpenAiProvider {
            base_url: OLLAMA_BASE_URL.to_string(),
            api_key: None,
            model: model_id,
            structured: StructuredMode::JsonObject,
        })),
        "openai-compat" => Ok(Box::new(OpenAiProvider {
            base_url: require_base_url(base_url)?,
            api_key: api_key.filter(|key| !key.is_empty()),
            model: model_id,
            // 호환 게이트웨이는 strict json_schema 미지원이 흔하므로 json_object로 강제.
            structured: StructuredMode::JsonObject,
        })),
        "anthropic" => Ok(Box::new(AnthropicProvider {
            api_key: require_key(provider_id, api_key)?,
            model: model_id,
        })),
        "gemini" => Ok(Box::new(GeminiProvider {
            api_key: require_key(provider_id, api_key)?,
            model: model_id,
        })),
        // 로컬 CLI 위임 — API 키 불필요(CLI가 구독/OAuth 처리).
        "claude-cli" => Ok(Box::new(CliProvider::claude(model_id))),
        // `gemini-cli`는 구버전 저장 설정 호환용 별칭 — 동일하게 agy CLI로 위임한다.
        "agy-cli" | "gemini-cli" => Ok(Box::new(CliProvider::agy(model_id))),
        other => Err(format!("알 수 없는 provider입니다: {}", other)),
    }
}

fn require_base_url(base_url: Option<String>) -> Result<String, String> {
    base_url
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
        .ok_or_else(|| {
            "OpenAI 호환 endpoint의 Base URL이 설정되지 않았습니다. \
             예: https://api.groq.com/openai"
                .to_string()
        })
}

fn require_key(provider_id: &str, api_key: Option<String>) -> Result<String, String> {
    api_key.filter(|key| !key.is_empty()).ok_or_else(|| {
        format!(
            "'{}' provider의 API 키가 설정되지 않았습니다. 키를 먼저 저장하세요.",
            provider_id
        )
    })
}

/// LLM에 보낼 사용자 메시지(지시 + 문서 컨텍스트)를 구성한다.
pub(crate) fn user_content(req: &LlmRequest) -> String {
    format!(
        "{}\n\n[문서 컨텍스트]\n{}",
        req.user_prompt, req.document_context_json
    )
}

/// `data:<mime>;base64,<data>` 형식의 data URL을 만든다(OpenAI image_url 등).
pub(crate) fn image_data_url(image: &crate::ai::provider::ImageInput) -> String {
    format!("data:{};base64,{}", image.mime_type, image.data_base64)
}

/// 스트림이 이만큼 아무 바이트도 보내지 않으면 끊긴 것으로 본다(스펙 7장).
///
/// 전체 소요 시간 상한(`timeout`)은 두지 않는다 — 긴 문서 생성은 스트리밍으로 몇 분씩
/// 걸리고, 전체 상한은 응답 본문을 읽는 시간까지 포함해 정상 응답을 중간에 끊는다.
/// 생각(thinking) 단계에서 첫 토큰까지 오래 걸리는 모델도 있어 넉넉히 잡는다.
pub(crate) const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(300);

/// 연결·무응답 타임아웃이 설정된 공용 reqwest 클라이언트(스펙 7장).
pub(crate) fn http_client() -> Result<reqwest::Client, ProviderError> {
    http_client_with_idle_timeout(STREAM_IDLE_TIMEOUT)
}

/// 무응답 타임아웃만 두고 전체 상한은 두지 않는 클라이언트(테스트에서 짧은 값으로 검증).
pub(crate) fn http_client_with_idle_timeout(idle: Duration) -> Result<reqwest::Client, ProviderError> {
    reqwest::Client::builder()
        .read_timeout(idle)
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| ProviderError::Provider(format!("HTTP 클라이언트 생성 실패: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_provider_requires_key_for_cloud_providers() {
        assert!(build_provider("openai", "m".to_string(), None, None).is_err());
        assert!(build_provider("anthropic", "m".to_string(), Some(String::new()), None).is_err());
        assert!(build_provider("gemini", "m".to_string(), None, None).is_err());
    }

    #[test]
    fn build_provider_allows_ollama_without_key() {
        assert!(build_provider("ollama", "llama3".to_string(), None, None).is_ok());
    }

    #[test]
    fn build_provider_rejects_unknown() {
        assert!(build_provider("bogus", "m".to_string(), Some("k".to_string()), None).is_err());
    }

    #[test]
    fn build_provider_openai_compat_requires_base_url() {
        // Base URL 없으면(키만 있어도) 거부.
        assert!(build_provider("openai-compat", "m".to_string(), Some("k".to_string()), None).is_err());
        assert!(build_provider("openai-compat", "m".to_string(), None, Some("  ".to_string())).is_err());
        // Base URL이 있으면 키 없이도(LM Studio 등) 허용.
        assert!(build_provider(
            "openai-compat",
            "llama-3.1-8b-instant".to_string(),
            None,
            Some("https://api.groq.com/openai".to_string()),
        )
        .is_ok());
        // 키 + Base URL(Groq/OpenRouter) 조합도 허용.
        assert!(build_provider(
            "openai-compat",
            "llama-3.1-8b-instant".to_string(),
            Some("gsk_xxx".to_string()),
            Some("https://api.groq.com/openai".to_string()),
        )
        .is_ok());
    }

    #[test]
    fn user_content_includes_prompt_and_context() {
        let req = LlmRequest {
            system_prompt: "s".to_string(),
            user_prompt: "지시".to_string(),
            document_context_json: "{\"x\":1}".to_string(),
            output_schema: serde_json::json!({}),
            images: Vec::new(),
            documents: Vec::new(),
            file_paths: Vec::new(),
        };
        let content = user_content(&req);
        assert!(content.contains("지시"));
        assert!(content.contains("{\"x\":1}"));
    }
    // ── F-73cbb137 AC-078633ca: 스트리밍에는 전체 상한 없이 무응답(읽기) 타임아웃만 ──

    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;
    use std::time::Instant;

    /// 테스트용 무응답 타임아웃. 트리클 간격(100ms)의 4배라 지터에 넉넉하다.
    const TEST_IDLE: Duration = Duration::from_millis(400);

    /// 요청 하나를 받아 헤더 끝까지 읽은 뒤 `respond`로 응답을 흘리는 1회용 서버.
    fn serve_once(
        respond: impl FnOnce(&mut TcpStream) + Send + 'static,
    ) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/stream", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_nodelay(true).unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = stream.read(&mut buf).unwrap();
                if n == 0 {
                    return;
                }
                request.extend_from_slice(&buf[..n]);
            }
            respond(&mut stream);
        });
        (url, handle)
    }

    fn fetch(url: &str) -> Result<Vec<u8>, reqwest::Error> {
        let client = http_client_with_idle_timeout(TEST_IDLE).unwrap();
        tauri::async_runtime::block_on(async {
            let response = client.get(url).send().await?;
            Ok(response.bytes().await?.to_vec())
        })
    }

    #[test]
    fn f73cbb137_ac_078633ca_slow_but_steady_stream_is_not_cut_by_a_total_cap() {
        const BODY: &[u8] = b"streamed";
        let (url, server) = serve_once(|stream| {
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                BODY.len()
            );
            stream.write_all(header.as_bytes()).unwrap();
            stream.flush().unwrap();
            // 바이트 사이 간격(100ms)은 무응답 타임아웃(400ms)보다 짧지만, 합계(800ms)는 길다.
            for byte in BODY {
                std::thread::sleep(Duration::from_millis(100));
                stream.write_all(&[*byte]).unwrap();
                stream.flush().unwrap();
            }
        });

        let started = Instant::now();
        let body = fetch(&url).expect("꾸준히 오는 스트림은 오래 걸려도 끝까지 받아야 한다");
        let elapsed = started.elapsed();

        assert_eq!(body, BODY);
        assert!(elapsed > TEST_IDLE, "전체 소요({elapsed:?})가 무응답 타임아웃보다 길어야 의미가 있다");
        server.join().unwrap();
    }

    #[test]
    fn f73cbb137_ac_078633ca_stalled_stream_times_out_after_the_idle_window() {
        let (release, wait_release) = mpsc::channel::<()>();
        let (url, server) = serve_once(move |stream| {
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nst")
                .unwrap();
            stream.flush().unwrap();
            // 나머지를 보내지 않고 멈춘다(테스트가 끝났다고 알리거나 3초가 지날 때까지).
            let _ = wait_release.recv_timeout(Duration::from_secs(3));
        });

        let started = Instant::now();
        let error = fetch(&url).expect_err("멈춘 스트림은 실패해야 한다");
        let elapsed = started.elapsed();
        let _ = release.send(());

        assert!(error.is_timeout(), "기대: 타임아웃 오류, 실제: {error}");
        assert_eq!(sse::map_reqwest_err(error), ProviderError::Timeout);
        assert!(
            elapsed < Duration::from_secs(2),
            "서버가 연결을 닫기 전에 무응답 타임아웃으로 끊겨야 한다: {elapsed:?}"
        );
        server.join().unwrap();
    }
}
