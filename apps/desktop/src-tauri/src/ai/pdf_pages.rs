//! PDF에서 '요청과 관련된 페이지'를 고르는 플랫폼 중립 로직(F-4e2261).
//!
//! 렌더러(맥 CoreGraphics `pdf_render` / 비-맥 pdfium `pdf_pdfium`)가 공유한다 —
//! 명시 페이지("10페이지") > 텍스트 토큰 매칭 > 그림 있는 페이지 폴백 순.

/// 그림(XObject Image)이 있는 페이지 번호(1-기준)를 모은다(텍스트 매칭 폴백용).
pub fn pages_with_images(path: &str) -> Vec<usize> {
    use lopdf::{Document, Object};
    let doc = match Document::load(path) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for (pageno, pid) in doc.get_pages() {
        let Ok((Some(res), _)) = doc.get_page_resources(pid) else {
            continue;
        };
        // Resources/XObject (dict 또는 reference).
        let xobj_dict = match res.get(b"XObject") {
            Ok(Object::Dictionary(d)) => Some(d),
            Ok(Object::Reference(id)) => doc.get_dictionary(*id).ok(),
            _ => None,
        };
        let Some(xobj_dict) = xobj_dict else { continue };
        if xobject_dict_has_image(&doc, xobj_dict, 0) {
            out.push(pageno as usize);
        }
    }
    out
}

/// XObject dict 안에 이미지가 있는지(Form XObject는 1단계 재귀로 그 안까지) 검사.
fn xobject_dict_has_image(doc: &lopdf::Document, dict: &lopdf::Dictionary, depth: u8) -> bool {
    use lopdf::Object;
    for (_, v) in dict.iter() {
        let id = match v {
            Object::Reference(id) => *id,
            _ => continue,
        };
        let Ok(Object::Stream(s)) = doc.get_object(id) else {
            continue;
        };
        match s.dict.get(b"Subtype") {
            Ok(Object::Name(n)) if n == b"Image".as_slice() => return true,
            Ok(Object::Name(n)) if n == b"Form".as_slice() && depth < 2 => {
                // Form의 Resources/XObject로 재귀.
                let sub = match s.dict.get(b"Resources") {
                    Ok(Object::Dictionary(d)) => d.get(b"XObject").ok(),
                    Ok(Object::Reference(rid)) => {
                        doc.get_dictionary(*rid).ok().and_then(|d| d.get(b"XObject").ok())
                    }
                    _ => None,
                };
                let sub_dict = match sub {
                    Some(Object::Dictionary(d)) => Some(d),
                    Some(Object::Reference(rid)) => doc.get_dictionary(*rid).ok(),
                    _ => None,
                };
                if let Some(sd) = sub_dict {
                    if xobject_dict_has_image(doc, sd, depth + 1) {
                        return true;
                    }
                }
            }
            _ => {}
        }
    }
    false
}

/// 프롬프트에 명시된 페이지 번호(1-기준)를 추출한다. 예) "10페이지", "21쪽",
/// "page 10", "p.7". 사용자가 페이지를 콕 집으면 토큰 매칭보다 이를 우선한다.
pub fn explicit_pages(query: &str) -> Vec<usize> {
    // 긴 마커 먼저(부분 매칭 방지): "페이지" → "페이" → "쪽" → "페".
    const SUFFIXES: [&str; 4] = ["페이지", "페이", "쪽", "페"];
    let chars: Vec<char> = query.chars().collect();
    let n = chars.len();
    let mut out: Vec<usize> = Vec::new();
    let mut i = 0;
    while i < n {
        if !chars[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < n && chars[i].is_ascii_digit() {
            i += 1;
        }
        let num: String = chars[start..i].iter().collect();
        // 숫자 뒤(공백 건너뜀)에 한글 페이지 마커가 오는가?
        let mut j = i;
        while j < n && chars[j].is_whitespace() {
            j += 1;
        }
        let rest: String = chars[j..].iter().collect();
        let suffix_match = SUFFIXES.iter().any(|m| rest.starts_with(m));
        // 숫자 앞(공백 건너뜀)이 "page"/"p." 로 끝나는가?
        let mut k = start;
        while k > 0 && chars[k - 1].is_whitespace() {
            k -= 1;
        }
        let before: String = chars[..k].iter().collect::<String>().to_lowercase();
        let prefix_match = before.ends_with("page") || before.ends_with("p.");
        if suffix_match || prefix_match {
            if let Ok(p) = num.parse::<usize>() {
                if p >= 1 && !out.contains(&p) {
                    out.push(p);
                }
            }
        }
    }
    out
}

/// 쿼리와 관련된 페이지 번호(1-기준)를 고른다. 명시 페이지 > 텍스트 매칭 > 그림 폴백.
pub fn select_query_pages(path: &str, query: &str, top_k: usize) -> Vec<usize> {
    let explicit = explicit_pages(query);
    let mut page_nums: Vec<usize> = if !explicit.is_empty() {
        explicit.into_iter().take(8).collect()
    } else {
        let tokens: Vec<String> = query
            .split(|c: char| !c.is_alphanumeric())
            .filter(|t| t.chars().count() >= 2)
            .map(|t| t.to_string())
            .collect();

        let mut scored: Vec<(usize, usize)> = Vec::new(); // (page, score)
        if let Ok(pages) = pdf_extract::extract_text_by_pages(path) {
            for (i, text) in pages.iter().enumerate() {
                let score = tokens.iter().filter(|t| text.contains(t.as_str())).count();
                if score > 0 {
                    scored.push((i + 1, score));
                }
            }
        }
        scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));

        let mut nums: Vec<usize> = scored.into_iter().take(top_k).map(|(p, _)| p).collect();
        if nums.is_empty() {
            // 텍스트 매칭이 없으면 그림 있는 페이지(앞쪽)로 폴백.
            nums = pages_with_images(path).into_iter().take(top_k).collect();
        }
        nums
    };
    page_nums.sort_unstable();
    page_nums
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_pages_parses_korean_and_english() {
        assert_eq!(explicit_pages("10페이지 그래프 넣어줘"), vec![10]);
        assert_eq!(explicit_pages("21쪽 그림"), vec![21]);
        assert_eq!(explicit_pages("page 7 figure"), vec![7]);
        assert_eq!(explicit_pages("p.3 의 표"), vec![3]);
        assert_eq!(explicit_pages("10페이지와 12쪽"), vec![10, 12]);
        // 마커 없는 숫자는 무시(연도/금액 등 오인 방지).
        assert!(explicit_pages("2018년 사업비 100만원").is_empty());
        assert!(explicit_pages("사업비 관리 체계 그림").is_empty());
    }
}
