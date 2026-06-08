//! DOCX 평문 텍스트 추출(첨부용).
//!
//! DOCX는 ZIP 컨테이너이고 본문은 `word/document.xml`에 들어 있다. 무거운 워드
//! 파서 없이 `zip`으로 그 XML을 꺼내, `<w:t>`(텍스트 run)을 모으고 `<w:p>`(문단)
//! 경계마다 줄을 바꿔 평문을 만든다. 서식·표 구조는 버리고 텍스트만 남긴다.

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use std::io::Read;

/// DOCX 바이트에서 본문 평문을 추출한다.
pub fn extract_docx_text(bytes: &[u8]) -> Result<String, String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("DOCX(zip) 열기 실패: {}", e))?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|_| "DOCX에 word/document.xml이 없습니다".to_string())?
        .read_to_string(&mut xml)
        .map_err(|e| format!("document.xml 읽기 실패: {}", e))?;
    Ok(extract_text_from_document_xml(&xml))
}

/// `word/document.xml` 문자열에서 문단별 텍스트를 추출한다(순수 함수 — 테스트 가능).
fn extract_text_from_document_xml(xml: &str) -> String {
    let mut reader = Reader::from_str(xml);
    let config = reader.config_mut();
    config.trim_text(false);

    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_text = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if local_name(e.name().as_ref()) == b"t" => in_text = true,
            Ok(Event::End(e)) if local_name(e.name().as_ref()) == b"t" => in_text = false,
            Ok(Event::Text(e)) if in_text => {
                if let Ok(text) = e.xml_content() {
                    current.push_str(&text);
                }
            }
            // <w:tab/>은 탭, <w:br/>은 줄바꿈으로 취급.
            Ok(Event::Empty(e)) => match local_name(e.name().as_ref()) {
                b"tab" => current.push('\t'),
                b"br" => current.push('\n'),
                _ => {}
            },
            // 문단(<w:p>) 종료 → 한 줄 확정.
            Ok(Event::End(e)) if local_name(e.name().as_ref()) == b"p" => {
                lines.push(std::mem::take(&mut current));
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
        .into_iter()
        .filter(|l| !l.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// `w:t` 같은 네임스페이스 접두사를 떼고 로컬 이름만 반환한다.
fn local_name(qname: &[u8]) -> &[u8] {
    match qname.iter().rposition(|&b| b == b':') {
        Some(idx) => &qname[idx + 1..],
        None => qname,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_paragraph_text_with_namespaces() {
        let xml = r#"<?xml version="1.0"?>
        <w:document xmlns:w="x"><w:body>
          <w:p><w:r><w:t>총 사업비</w:t></w:r><w:r><w:t> 525,000,000</w:t></w:r></w:p>
          <w:p><w:r><w:t>둘째 문단</w:t></w:r></w:p>
          <w:p></w:p>
        </w:body></w:document>"#;
        let text = extract_text_from_document_xml(xml);
        assert_eq!(text, "총 사업비 525,000,000\n둘째 문단");
    }

    #[test]
    fn handles_tab_and_break_and_empty() {
        let xml = r#"<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t><w:br/><w:t>C</w:t></w:r></w:p>"#;
        let text = extract_text_from_document_xml(xml);
        assert_eq!(text, "A\tB\nC");
    }

    #[test]
    fn empty_document_yields_empty_string() {
        assert_eq!(extract_text_from_document_xml("<w:document/>"), "");
    }
}
