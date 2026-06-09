//! macOS Core Graphics로 PDF 페이지를 비트맵으로 렌더링한다(벡터·블렌드 도형 포함).
//!
//! 내장 이미지 추출(`pdf_images`)로는 벡터 그래프나 블렌드모드로만 보이는 도형을 못
//! 잡으므로, 페이지를 통째로 래스터화한 뒤 그림 영역만 잘라낸다(`crop`). macOS 전용
//! (Quartz 사용, 별도 무거운 의존성 없음).

#![cfg(target_os = "macos")]
// objc2-core-graphics 0.3은 자유함수형 CG API를 deprecated(메서드형으로 개명)로 표시하지만
// 동작은 동일하므로 그대로 쓴다.
#![allow(deprecated)]

use image::RgbaImage;
use objc2_core_foundation::{CFURLCreateFromFileSystemRepresentation, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    CGBitmapContextCreate, CGColorSpaceCreateDeviceRGB, CGContextDrawPDFPage, CGContextFillRect,
    CGContextScaleCTM, CGContextSetRGBFillColor, CGContextTranslateCTM, CGPDFBox,
    CGPDFDocumentCreateWithURL, CGPDFDocumentGetNumberOfPages, CGPDFDocumentGetPage,
    CGPDFPageGetBoxRect,
};

/// PDF의 1-기준 페이지를 흰 배경 RGBA 이미지로 렌더링한다. scale=2.0 → 약 144dpi.
pub fn render_pdf_page(path: &str, page_number: usize, scale: f64) -> Option<RgbaImage> {
    unsafe {
        let bytes = path.as_bytes();
        let url =
            CFURLCreateFromFileSystemRepresentation(None, bytes.as_ptr(), bytes.len() as isize, false)?;
        let doc = CGPDFDocumentCreateWithURL(Some(&url))?;
        let total = CGPDFDocumentGetNumberOfPages(Some(&doc));
        if page_number < 1 || page_number > total {
            return None;
        }
        let page = CGPDFDocumentGetPage(Some(&doc), page_number)?;
        let media = CGPDFPageGetBoxRect(Some(&page), CGPDFBox::MediaBox);
        let (w, h) = (media.size.width, media.size.height);
        if w <= 0.0 || h <= 0.0 {
            return None;
        }
        let pw = (w * scale).round() as usize;
        let ph = (h * scale).round() as usize;
        if pw == 0 || ph == 0 || pw > 20_000 || ph > 20_000 {
            return None;
        }

        let bytes_per_row = pw * 4;
        let mut buf = vec![0u8; bytes_per_row * ph];
        let space = CGColorSpaceCreateDeviceRGB()?;
        // bitmap_info = kCGImageAlphaPremultipliedLast(1). 흰 배경 위에 그리므로 알파=255.
        let ctx = CGBitmapContextCreate(
            buf.as_mut_ptr() as *mut core::ffi::c_void,
            pw,
            ph,
            8,
            bytes_per_row,
            Some(&space),
            1,
        )?;

        // 흰 배경(스케일 적용 전 = 디바이스 픽셀 좌표).
        CGContextSetRGBFillColor(Some(&ctx), 1.0, 1.0, 1.0, 1.0);
        CGContextFillRect(
            Some(&ctx),
            CGRect {
                origin: CGPoint { x: 0.0, y: 0.0 },
                size: CGSize {
                    width: pw as f64,
                    height: ph as f64,
                },
            },
        );
        // PDF 좌표 → 픽셀: 스케일 후 미디어박스 원점 보정.
        CGContextScaleCTM(Some(&ctx), scale, scale);
        CGContextTranslateCTM(Some(&ctx), -media.origin.x, -media.origin.y);
        CGContextDrawPDFPage(Some(&ctx), Some(&page));

        // CGBitmapContext 버퍼는 첫 행=맨 위(top-down)로 저장된다. 그대로 채운다.
        let mut img = RgbaImage::new(pw as u32, ph as u32);
        for y in 0..ph {
            let base = y * bytes_per_row;
            for x in 0..pw {
                let p = base + x * 4;
                img.put_pixel(
                    x as u32,
                    y as u32,
                    image::Rgba([buf[p], buf[p + 1], buf[p + 2], 255]),
                );
            }
        }
        Some(img)
    }
}

/// 이미지 XObject를 가진(=그림이 있을 법한) 페이지 번호(1-기준) 목록.
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

/// 쿼리(사용자 요청)와 가장 관련 있는 페이지들을 골라 렌더한다. 페이지 텍스트에서 쿼리
/// 토큰이 많이 나오는 페이지 우선. 매칭이 없으면 그림 있는 페이지로 폴백.
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

pub fn render_query_pages(path: &str, query: &str, scale: f64, top_k: usize) -> Vec<(usize, RgbaImage)> {
    // 1) 프롬프트가 페이지를 명시하면 그 페이지를 그대로 렌더(최우선).
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

    let mut out = Vec::new();
    for p in page_nums {
        if let Some(img) = render_pdf_page(path, p, scale) {
            out.push((p, img));
        }
    }
    out
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

    /// [실험] HOP_PDF에서 HOP_QUERY와 관련된 페이지를 렌더해 /tmp/qpage_N.png 로 쓴다.
    #[test]
    #[ignore]
    fn experiment_render_page() {
        let path = std::env::var("HOP_PDF").unwrap();
        let q = std::env::var("HOP_QUERY").unwrap_or_else(|_| "사업비 관리 체계 그림".to_string());
        let rendered = render_query_pages(&path, &q, 1.6, 4);
        println!("쿼리 매칭 렌더 페이지: {:?}", rendered.iter().map(|(p, _)| *p).collect::<Vec<_>>());
        for (p, img) in &rendered {
            let out = format!("/tmp/qpage_{}.png", p);
            img.save(&out).unwrap();
            println!("  page {} {}x{} → {}", p, img.width(), img.height(), out);
        }
    }
}
