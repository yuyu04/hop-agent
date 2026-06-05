//! 공용 SSE(Server-Sent Events) 스트리밍 처리.
//!
//! provider마다 SSE 프레임의 JSON 구조는 다르지만, `data:` 라인 추출과 취소
//! 확인·누적 루프는 공통이다. 줄 파싱은 순수 함수로 분리해 테스트한다.

use crate::ai::provider::{CancelToken, DeltaSink, ProviderError};
use futures_util::StreamExt;
use std::sync::atomic::Ordering;

/// 버퍼에서 완성된 줄을 꺼내 `data:` 페이로드만 반환한다.
///
/// `[DONE]` 센티넬과 빈 페이로드, `event:` 등 다른 필드는 제외한다. 마지막
/// 미완성 줄(개행 없음)은 버퍼에 남겨 다음 청크와 이어 붙인다.
pub fn drain_sse_data_lines(buf: &mut String) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(newline) = buf.find('\n') {
        let line: String = buf.drain(..=newline).collect();
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("data:") {
            let data = rest.trim();
            if !data.is_empty() && data != "[DONE]" {
                out.push(data.to_string());
            }
        }
    }
    out
}

pub fn map_reqwest_err(error: reqwest::Error) -> ProviderError {
    if error.is_timeout() {
        ProviderError::Timeout
    } else {
        ProviderError::Provider(error.to_string())
    }
}

/// SSE 응답을 끝까지 읽으며 `extract`로 텍스트 fragment를 뽑아 누적·스트리밍한다.
/// 매 청크마다 취소를 확인한다(스펙 7장).
pub async fn stream_sse(
    response: reqwest::Response,
    on_delta: &DeltaSink,
    cancel: &CancelToken,
    mut extract: impl FnMut(&str) -> Option<String>,
) -> Result<String, ProviderError> {
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(ProviderError::Provider(format!(
            "HTTP {}: {}",
            status,
            truncate(body.trim(), 500)
        )));
    }

    let mut accumulated = String::new();
    let mut buffer = String::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Err(ProviderError::Cancelled);
        }
        let bytes = chunk.map_err(map_reqwest_err)?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));
        for data in drain_sse_data_lines(&mut buffer) {
            if let Some(fragment) = extract(&data) {
                accumulated.push_str(&fragment);
                on_delta(fragment);
            }
        }
    }

    Ok(accumulated)
}

fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let truncated: String = text.chars().take(max_chars).collect();
    format!("{}…", truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drains_complete_data_lines_and_keeps_partial() {
        let mut buf = String::from("data: {\"a\":1}\n\ndata: {\"b\":2}\ndata: {\"c\"");
        let lines = drain_sse_data_lines(&mut buf);
        assert_eq!(lines, vec!["{\"a\":1}".to_string(), "{\"b\":2}".to_string()]);
        // 미완성 마지막 줄은 버퍼에 남는다.
        assert_eq!(buf, "data: {\"c\"");
    }

    #[test]
    fn ignores_done_sentinel_and_non_data_lines() {
        let mut buf = String::from("event: message\ndata: [DONE]\ndata:   \n");
        let lines = drain_sse_data_lines(&mut buf);
        assert!(lines.is_empty());
        assert!(buf.is_empty());
    }

    #[test]
    fn truncate_limits_long_bodies() {
        assert_eq!(truncate("abc", 5), "abc");
        assert_eq!(truncate("abcdef", 3), "abc…");
    }
}
