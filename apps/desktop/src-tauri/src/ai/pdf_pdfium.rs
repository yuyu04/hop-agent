//! 비-macOS PDF 페이지 렌더(F-4e2261) — pdfium 동적 로딩.
//!
//! pdfium 바이너리(libpdfium.so/.dll)는 앱 실행 파일 옆에 배포되거나 시스템에
//! 설치되어 있어야 한다. 라이브러리를 못 찾으면 빈 결과를 반환해 세션을 중단하지
//! 않는다(AC3 — 기존 비-macOS의 빈 목록 동작과 동일). macOS에서도 컴파일은 되지만
//! (테스트 가능) 런타임 경로는 CoreGraphics(`pdf_render`)가 우선이다.

// macOS 런타임은 CoreGraphics 경로를 쓰므로 여기 함수들은 호출되지 않는다(테스트는 사용).
#![cfg_attr(target_os = "macos", allow(dead_code))]

use super::pdf_pages::select_query_pages;
use image::RgbaImage;
use pdfium_render::prelude::*;

/// 쿼리 관련 페이지를 pdfium으로 렌더한다. 반환 형식은 macOS 경로
/// (`render_query_figures`)와 동일한 `(page, figure_only, RgbaImage)`. 전체 페이지
/// 렌더이므로 figure_only=false — AI가 payload.crop으로 그림 영역을 잘라낸다
/// (기존 풀페이지 폴백과 같은 흐름).
pub fn render_query_pages_pdfium(
    path: &str,
    query: &str,
    scale: f64,
    top_k: usize,
) -> Vec<(usize, bool, RgbaImage)> {
    let Some(pdfium) = bind_pdfium() else {
        return Vec::new(); // 라이브러리 없음 — 빈 목록(오류로 중단하지 않는다).
    };
    let Ok(doc) = pdfium.load_pdf_from_file(path, None) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for page_no in select_query_pages(path, query, top_k) {
        if page_no < 1 || page_no > i32::MAX as usize {
            continue;
        }
        let Ok(page) = doc.pages().get((page_no - 1) as i32) else { continue };
        let config = PdfRenderConfig::new().scale_page_by_factor(scale as f32);
        let Ok(bitmap) = page.render_with_config(&config) else { continue };
        let Ok(dynamic) = bitmap.as_image() else { continue };
        let rendered = dynamic.into_rgba8();
        out.push((page_no, false, composite_on_white(rendered)));
    }
    out
}

/// 실행 파일 옆 → 현재 디렉터리 → 시스템 순으로 pdfium을 찾아 바인딩한다.
fn bind_pdfium() -> Option<Pdfium> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(dir) = exe_dir {
        candidates.push(Pdfium::pdfium_platform_library_name_at_path(&dir));
    }
    candidates.push(Pdfium::pdfium_platform_library_name_at_path("./"));

    for candidate in candidates {
        if let Ok(bindings) = Pdfium::bind_to_library(&candidate) {
            return Some(Pdfium::new(bindings));
        }
    }
    Pdfium::bind_to_system_library().ok().map(Pdfium::new)
}

/// 투명 배경을 흰색 위에 합성한다(CoreGraphics 경로와 동일하게 흰 배경 보장).
fn composite_on_white(img: RgbaImage) -> RgbaImage {
    let (w, h) = img.dimensions();
    let mut out = RgbaImage::from_pixel(w, h, image::Rgba([255, 255, 255, 255]));
    image::imageops::overlay(&mut out, &img, 0, 0);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// pdfium 라이브러리가 없거나 파일이 없으면 패닉 없이 빈 결과로 폴백한다(AC3).
    #[test]
    fn missing_pdfium_or_file_falls_back_to_empty() {
        let out = render_query_pages_pdfium("/tmp/__hop_no_such__.pdf", "그림", 2.0, 4);
        assert!(out.is_empty());
    }

    /// [실험] libpdfium이 있으면(HOP_PDF 환경변수로 PDF 지정) 실제 렌더를 검증한다.
    /// 실행: 테스트 바이너리 옆(target/debug/deps)에 libpdfium을 두고
    /// `HOP_PDF=... cargo test ... -- --ignored`.
    #[test]
    #[ignore]
    fn experiment_render_with_pdfium() {
        let path = std::env::var("HOP_PDF").unwrap();
        let q = std::env::var("HOP_QUERY").unwrap_or_else(|_| "사업비 관리 체계 그림".to_string());
        let pages = render_query_pages_pdfium(&path, &q, 2.0, 4);
        println!("pdfium 렌더 페이지: {:?}", pages.iter().map(|(p, _, _)| *p).collect::<Vec<_>>());
        assert!(!pages.is_empty(), "pdfium 렌더 결과가 비어 있음(라이브러리/PDF 확인)");
        for (p, figure_only, img) in &pages {
            println!("  page {} figure_only={} {}x{}", p, figure_only, img.width(), img.height());
            img.save(format!("/tmp/pdfium_qpage_{}.png", p)).unwrap();
            // 흰 배경 보장 확인(모서리 픽셀이 불투명).
            assert_eq!(img.get_pixel(0, 0).0[3], 255);
        }
    }
}
