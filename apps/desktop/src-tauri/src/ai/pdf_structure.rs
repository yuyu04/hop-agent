//! 연구노트형 PDF → 구조(항목 + 목차) 인제스트.
//!
//! docx와 달리 PDF에는 표/문단 같은 깔끔한 구조 마크업이 없다. 추출되는 것은 위치로
//! 흩어진 텍스트뿐이라, 본 파서는 **추출 텍스트의 줄 패턴**으로 항목 경계를 복원한다:
//! 양식 한 항목은 "제목 …" 라벨 줄로 시작하고, 바닥에 "기록자/확인자/기록 일자/확인 일자"
//! 메타 줄을 둔다(연구노트 양식). 그 사이가 본문이다. 목차는 PDF 텍스트에서 다시 긁기보다
//! 복원된 항목에서 합성한다(번호=순번, 제목=항목 제목, 날짜=기록 일자) — 항목과 항상 일치.
//!
//! 한계(MVP): 본문 데이터 표·인라인 이미지는 PDF 텍스트만으로는 위치·구조를 신뢰성 있게
//! 복원할 수 없어 비운다(docx 경로는 둘 다 지원). 텍스트 항목(제목/본문/기록자/일자)에 집중.

use super::docx::{EntryImage, EntryRecord, ResearchNoteDoc, TocItem};
use super::pdf_figures;
use base64::{engine::general_purpose::STANDARD, Engine as _};

/// 메타 표의 라벨(값과 함께 항목 바닥에 나타난다).
const META_LABELS: &[&str] = &["기록자", "확인자", "기록 일자", "확인 일자"];

/// PDF 바이트에서 연구노트 구조(항목 + 합성 목차)를 추출한다(텍스트만).
pub fn parse_pdf_structure(bytes: &[u8]) -> Result<ResearchNoteDoc, String> {
    let text = pdf_extract::extract_text_from_mem(bytes)
        .map_err(|e| format!("PDF 텍스트 추출 실패: {}", e))?;
    parse_structure_from_pdf_text(&text)
}

/// PDF 경로에서 구조 + 표·그림 영역 이미지를 추출한다(form-fill용).
///
/// 텍스트는 `parse_pdf_structure`로, 표/그림은 페이지를 렌더해 영역만 잘라 항목에 인라인
/// 이미지로 붙인다(`pdf_figures`). 페이지→항목 매핑은 페이지별 텍스트의 "제목" 라벨 위치로
/// 정한다(어떤 항목이 그 페이지를 '소유'하는지). 그림 추출이 실패해도 텍스트 결과는 보존한다.
pub fn parse_pdf_structure_with_figures(path: &str) -> Result<ResearchNoteDoc, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("파일을 읽을 수 없습니다: {}", e))?;
    let mut doc = parse_pdf_structure(&bytes)?;

    // 표·그림 영역 추출(베스트에포트 — 실패는 무시하고 텍스트만 반환).
    let Ok(pdoc) = lopdf::Document::load(path) else {
        return Ok(doc);
    };
    let Ok(pages) = pdf_extract::extract_text_by_pages(path) else {
        return Ok(doc);
    };
    let starts = entry_start_pages(&pages);
    // 항목 수와 페이지별 제목 수가 어긋나면(추출 흐트러짐) 안전하게 그림 배정을 생략한다.
    if starts.is_empty() || starts.len() != doc.entries.len() {
        return Ok(doc);
    }

    // scale 2.0 ≈ 144dpi — 잘라낸 표/그림이 또렷하도록.
    for (&page_num, _) in pdoc.get_pages().iter() {
        let Some(owner) = owner_entry(&starts, page_num as usize) else {
            continue; // 첫 항목 이전 페이지(표지·목차) — 이미지화하지 않는다.
        };
        let regions = pdf_figures::extract_page_regions(&pdoc, path, page_num as usize, 2.0);
        for reg in regions {
            let b64 = STANDARD.encode(&reg.png);
            let after = doc.entries[owner].body_paragraphs.len();
            doc.entries[owner]
                .images
                .push(EntryImage::inline(after, b64, "png".to_string(), reg.width_px, reg.height_px));
        }
    }
    Ok(doc)
}

/// 페이지별 텍스트에서 각 항목 제목이 처음 나타나는 페이지(1-기준)를 순서대로 모은다.
fn entry_start_pages(pages: &[String]) -> Vec<usize> {
    let mut starts = Vec::new();
    for (i, ptext) in pages.iter().enumerate() {
        for line in ptext.lines() {
            if title_after_label(line.trim()).is_some() {
                starts.push(i + 1);
            }
        }
    }
    starts
}

/// page(1-기준)를 '소유'하는 항목 인덱스 = 시작 페이지가 page 이하인 마지막 항목.
/// 첫 항목 시작 페이지보다 앞이면 None(소유자 없음).
fn owner_entry(starts: &[usize], page: usize) -> Option<usize> {
    let mut owner = None;
    for (n, &s) in starts.iter().enumerate() {
        if s <= page {
            owner = Some(n);
        } else {
            break;
        }
    }
    owner
}

/// "제목" 라벨 줄이면 그 뒤의 제목 문자열(같은 줄에 있으면)을 반환한다. 라벨만 있는 줄은
/// Some("")(제목은 다음 줄). 목차 헤더 "제목(내용)"이나 본문 문장("제목을 …")은 None.
fn title_after_label(line: &str) -> Option<String> {
    let t = line.trim();
    let rest = t.strip_prefix("제목")?;
    if rest.is_empty() {
        return Some(String::new()); // 라벨만 — 제목은 다음 줄
    }
    let first = rest.chars().next().unwrap();
    // "제목(내용)" 같은 목차 헤더 제외.
    if first == '(' || first == '（' {
        return None;
    }
    // 라벨과 제목 사이에는 구분자(공백/탭/콜론/대괄호)가 있어야 한다. 바로 한글이 붙으면
    // ("제목을") 본문 문장이므로 항목 라벨이 아니다.
    if !(first.is_whitespace() || first == ':' || first == '：' || first == ']') {
        return None;
    }
    let title = rest
        .trim_start_matches(|c: char| c.is_whitespace() || c == ':' || c == '：' || c == ']')
        .trim()
        .to_string();
    Some(title)
}

/// 메타 라벨 줄이면 (라벨, 같은 줄의 값)을 반환한다. 값이 같은 줄에 없으면 값은 None.
fn meta_label(line: &str) -> Option<(&'static str, Option<String>)> {
    let t = line.trim();
    for &label in META_LABELS {
        if let Some(rest) = t.strip_prefix(label) {
            // 라벨 바로 뒤가 한글/영숫자면 다른 단어(오탐) — 구분자/콜론/끝이어야 한다.
            if let Some(c) = rest.chars().next() {
                if !(c.is_whitespace() || c == ':' || c == '：') {
                    continue;
                }
            }
            let val = rest
                .trim_start_matches(|c: char| c.is_whitespace() || c == ':' || c == '：')
                .trim();
            return Some((label, if val.is_empty() { None } else { Some(val.to_string()) }));
        }
    }
    None
}

/// 순수 페이지 번호 줄("12", "- 12 -" 등) — 본문에서 버린다.
fn is_page_number(line: &str) -> bool {
    let t = line.trim().trim_matches(|c: char| c == '-' || c.is_whitespace());
    !t.is_empty() && t.chars().all(|c| c.is_ascii_digit())
}

/// 메타 값을 해당 필드에 배정한다.
fn assign_meta(entry: &mut EntryRecord, label: &str, value: &str) {
    let value = value.trim();
    match label {
        "기록자" => {
            entry.recorders = value
                .split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        }
        "확인자" => entry.confirmer = value.to_string(),
        "기록 일자" => entry.record_date = value.to_string(),
        "확인 일자" => entry.confirm_date = value.to_string(),
        _ => {}
    }
}

/// PDF 추출 텍스트 → 구조(순수 함수 — 테스트 가능).
fn parse_structure_from_pdf_text(text: &str) -> Result<ResearchNoteDoc, String> {
    let lines: Vec<String> = text
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    // 항목 경계 = "제목" 라벨 줄. 목차 헤더/본문 문장은 title_after_label이 걸러낸다.
    let title_idx: Vec<usize> = (0..lines.len())
        .filter(|&i| title_after_label(&lines[i]).is_some())
        .collect();

    if title_idx.is_empty() {
        return Err(
            "PDF에서 연구노트 항목을 찾지 못했습니다 — '제목' 라벨로 시작하고 \
             '기록 일자' 메타로 끝나는 양식이 아닙니다(이 인제스트는 연구노트형 \
             PDF를 대상으로 합니다)."
                .to_string(),
        );
    }

    let mut entries: Vec<EntryRecord> = Vec::new();
    for (n, &start) in title_idx.iter().enumerate() {
        let end = title_idx.get(n + 1).copied().unwrap_or(lines.len());
        let label_rest = title_after_label(&lines[start]).unwrap_or_default();

        // 제목이 라벨 줄에 있으면 그걸, 아니면 다음 줄을 제목으로(본문은 그만큼 뒤에서 시작).
        let (title, body_from) = if !label_rest.is_empty() {
            (label_rest, start + 1)
        } else {
            (
                lines.get(start + 1).cloned().unwrap_or_default(),
                start + 2,
            )
        };

        let mut entry = EntryRecord {
            title: title.trim().to_string(),
            body_paragraphs: Vec::new(),
            recorders: Vec::new(),
            confirmer: String::new(),
            record_date: String::new(),
            confirm_date: String::new(),
            images: Vec::new(),
            body_tables: Vec::new(),
        };

        let mut i = body_from;
        while i < end {
            let line = &lines[i];
            if let Some((label, val)) = meta_label(line) {
                let value = match val {
                    Some(v) => v,
                    None => {
                        // 값이 다음 줄에 분리됨 — 한 줄 당겨 소비한다.
                        i += 1;
                        lines.get(i).cloned().unwrap_or_default()
                    }
                };
                assign_meta(&mut entry, label, &value);
            } else if is_page_number(line) {
                // 페이지 번호 — 버린다.
            } else {
                entry.body_paragraphs.push(line.clone());
            }
            i += 1;
        }

        entries.push(entry);
    }

    // 목차는 항목에서 합성한다(PDF 목차 텍스트 재파싱보다 신뢰도 높고 항상 항목과 일치).
    let toc: Vec<TocItem> = entries
        .iter()
        .enumerate()
        .map(|(i, e)| TocItem {
            no: (i + 1).to_string(),
            title: e.title.clone(),
            date: e.record_date.clone(),
        })
        .collect();

    // PDF 경로는 표지 추출 미지원 — cover: None(표지는 채우지 않고 항목/목차만 변환).
    Ok(ResearchNoteDoc { entries, toc, cover: None })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// pdf_extract가 내놓을 법한 텍스트(제목 라벨+제목 같은 줄, 메타 라벨+값 같은 줄).
    #[test]
    fn parses_entry_with_inline_label_and_value() {
        let text = "\
연구노트
일련번호 제목(내용) 날짜
1 첫 항목 2026.01.05
제목 android_rules.yaml(3) — SSL/WebView/저장
Ÿ 첫 번째 본문 줄
1. 둘째 본문 줄
기록자 홍길동, 박정근
확인자 홍길동
기록 일자 2026.01.02
확인 일자 2026.01.30
";
        let doc = parse_structure_from_pdf_text(text).expect("parse");
        assert_eq!(doc.entries.len(), 1, "한 항목");
        let e = &doc.entries[0];
        assert_eq!(e.title, "android_rules.yaml(3) — SSL/WebView/저장");
        assert_eq!(e.body_paragraphs, vec!["Ÿ 첫 번째 본문 줄", "1. 둘째 본문 줄"]);
        assert_eq!(e.recorders, vec!["홍길동", "박정근"]);
        assert_eq!(e.confirmer, "홍길동");
        assert_eq!(e.record_date, "2026.01.02");
        assert_eq!(e.confirm_date, "2026.01.30");
        // 목차는 항목에서 합성.
        assert_eq!(doc.toc.len(), 1);
        assert_eq!(doc.toc[0].no, "1");
        assert_eq!(doc.toc[0].title, "android_rules.yaml(3) — SSL/WebView/저장");
        assert_eq!(doc.toc[0].date, "2026.01.02");
    }

    /// 제목/메타 값이 라벨과 '다른 줄'로 분리되어 추출되는 경우(흔함).
    #[test]
    fn parses_entry_with_split_label_and_value() {
        let text = "\
제목
두 번째 항목
본문 한 줄
기록자
홍길동
확인자
홍길동
기록 일자
2026.01.10
확인 일자
2026.01.20
";
        let doc = parse_structure_from_pdf_text(text).expect("parse");
        assert_eq!(doc.entries.len(), 1);
        let e = &doc.entries[0];
        assert_eq!(e.title, "두 번째 항목");
        assert_eq!(e.body_paragraphs, vec!["본문 한 줄"]);
        assert_eq!(e.recorders, vec!["홍길동"]);
        assert_eq!(e.confirmer, "홍길동");
        assert_eq!(e.record_date, "2026.01.10");
        assert_eq!(e.confirm_date, "2026.01.20");
    }

    #[test]
    fn parses_multiple_entries_and_skips_page_numbers() {
        let text = "\
제목 항목 A
A 본문
기록 일자 2026.01.01
- 1 -
제목 항목 B
B 본문
3
기록 일자 2026.02.02
";
        let doc = parse_structure_from_pdf_text(text).expect("parse");
        assert_eq!(doc.entries.len(), 2);
        assert_eq!(doc.entries[0].title, "항목 A");
        assert_eq!(doc.entries[0].body_paragraphs, vec!["A 본문"]);
        assert_eq!(doc.entries[0].record_date, "2026.01.01");
        assert_eq!(doc.entries[1].title, "항목 B");
        // 페이지 번호 "3"은 본문에서 제외.
        assert_eq!(doc.entries[1].body_paragraphs, vec!["B 본문"]);
        assert_eq!(doc.entries[1].record_date, "2026.02.02");
    }

    #[test]
    fn toc_header_and_body_sentence_are_not_titles() {
        // "제목(내용)" 목차 헤더와 "제목을 정했다" 본문 문장은 항목 경계가 아니다.
        let text = "\
일련번호 제목(내용) 날짜
제목 진짜 항목
이번 항목의 제목을 정했다
기록 일자 2026.03.03
";
        let doc = parse_structure_from_pdf_text(text).expect("parse");
        assert_eq!(doc.entries.len(), 1, "목차 헤더·본문 문장은 항목이 아님");
        assert_eq!(doc.entries[0].title, "진짜 항목");
        assert_eq!(
            doc.entries[0].body_paragraphs,
            vec!["이번 항목의 제목을 정했다"]
        );
    }

    #[test]
    fn errors_when_no_entry_found() {
        let text = "그냥 평범한 텍스트\n표도 제목도 없음";
        assert!(parse_structure_from_pdf_text(text).is_err());
    }
}
