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
use lopdf::content::Content;
use lopdf::{Document, Object};
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

#[allow(dead_code)] // 전체 페이지 렌더 경로(실험 테스트·폴백 참고용). 기본은 render_query_figures.
pub fn render_query_pages(path: &str, query: &str, scale: f64, top_k: usize) -> Vec<(usize, RgbaImage)> {
    let mut out = Vec::new();
    for p in select_query_pages(path, query, top_k) {
        if let Some(img) = render_pdf_page(path, p, scale) {
            out.push((p, img));
        }
    }
    out
}

/// 쿼리 관련 페이지에서 '그림 영역만'(텍스트 제외) 잘라 반환한다(구조적 분리).
/// 그림 경계를 못 구한 페이지는 페이지 전체 렌더로 폴백한다. 반환: (page, 그림이면 true, img).
pub fn render_query_figures(
    path: &str,
    query: &str,
    scale: f64,
    top_k: usize,
) -> Vec<(usize, bool, RgbaImage)> {
    let doc = Document::load(path).ok();
    let mut out = Vec::new();
    for p in select_query_pages(path, query, top_k) {
        if let Some(img) = doc.as_ref().and_then(|d| render_page_figure(d, path, p, scale)) {
            out.push((p, true, img)); // 글 제외된 그림만
        } else if let Some(img) = render_pdf_page(path, p, scale) {
            out.push((p, false, img)); // 폴백: 페이지 전체(AI가 crop)
        }
    }
    out
}


// ─────────────────────────────────────────────────────────────────────────
// 구조적 그림/글 분리: PDF 콘텐츠 스트림에서 '그리기(벡터·이미지)' 연산만 골라
// 경계 상자를 구하고, 그 영역만 렌더한다. 본문 텍스트(BT…ET)는 제외하므로 글이
// 섞이지 않은 '그림만'을 얻는다.
// ─────────────────────────────────────────────────────────────────────────

/// 2×3 아핀 [a,b,c,d,e,f] — x'=a*x+c*y+e, y'=b*x+d*y+f.
type Mat = [f64; 6];

const IDENTITY: Mat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `first`를 적용한 뒤 `second`를 적용하는 합성 행렬(점 기준 second(first(p))).
fn mat_mul(first: Mat, second: Mat) -> Mat {
    let [a1, b1, c1, d1, e1, f1] = first;
    let [a2, b2, c2, d2, e2, f2] = second;
    [
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    ]
}

fn xform(m: Mat, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

fn num(o: &Object) -> Option<f64> {
    match o {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(*r as f64),
        _ => None,
    }
}

/// 누적용 경계 상자(user space). 비어 있으면 None 상태.
#[derive(Clone, Copy, Default)]
struct BBox {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
    set: bool,
}

impl BBox {
    fn add(&mut self, x: f64, y: f64) {
        if !self.set {
            self.min_x = x;
            self.max_x = x;
            self.min_y = y;
            self.max_y = y;
            self.set = true;
        } else {
            self.min_x = self.min_x.min(x);
            self.max_x = self.max_x.max(x);
            self.min_y = self.min_y.min(y);
            self.max_y = self.max_y.max(y);
        }
    }
    fn w(&self) -> f64 {
        self.max_x - self.min_x
    }
    fn h(&self) -> f64 {
        self.max_y - self.min_y
    }
}

/// CG로 페이지 MediaBox(원점·크기)를 얻는다.
fn page_media_box(path: &str, page_number: usize) -> Option<(f64, f64, f64, f64)> {
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
        let m = CGPDFPageGetBoxRect(Some(&page), CGPDFBox::MediaBox);
        Some((m.origin.x, m.origin.y, m.size.width, m.size.height))
    }
}

/// 페이지의 '그림' 경계 상자(user space)를 콘텐츠 스트림에서 계산한다. 텍스트는 제외.
/// 그림(벡터/이미지)이 없으면 None.
fn page_graphics_bbox(doc: &Document, page_id: lopdf::ObjectId, mw: f64, mh: f64) -> Option<(f64, f64, f64, f64)> {
    let content = doc.get_and_decode_page_content(page_id).ok()?;
    let elements = collect_graphic_elements(&content, mw, mh)?;
    pick_figure_cluster(&elements, mw, mh)
}

/// 그리기 요소 하나(경계 상자 + 곡선/이미지 여부). curved=true면 도형·일러스트(그림)
/// 후보, false면 직선·사각형(표·텍스트 박스 등)일 가능성이 높다.
#[derive(Clone, Copy)]
struct GraphicEl {
    bbox: BBox,
    curved: bool,
}

/// 콘텐츠 스트림에서 '그리기' 요소(칠해진 경로·이미지)의 개별 경계 상자 목록을 모은다.
/// 텍스트(BT…ET)는 제외하고, 배경(페이지 80%↑)·괘선(얇고 긴 선)은 걸러낸다.
fn collect_graphic_elements(content: &Content, mw: f64, mh: f64) -> Option<Vec<GraphicEl>> {
    let page_area = (mw * mh).max(1.0);
    let mut ctm: Mat = IDENTITY;
    let mut stack: Vec<Mat> = Vec::new();
    let mut path = BBox::default();
    let mut path_curved = false; // 현재 경로에 베지어 곡선(c/v/y)이 있었나
    let mut elements: Vec<GraphicEl> = Vec::new();
    let mut in_text = false;

    let mut commit = |b: &BBox, curved: bool, elements: &mut Vec<GraphicEl>| {
        if !b.set {
            return;
        }
        let (bw, bh) = (b.w(), b.h());
        if bw * bh > page_area * 0.8 {
            return; // 배경
        }
        if (bh < 3.0 && bw > mw * 0.6) || (bw < 3.0 && bh > mh * 0.6) {
            return; // 괘선·구분선
        }
        elements.push(GraphicEl { bbox: *b, curved });
    };

    for op in &content.operations {
        let operands = &op.operands;
        match op.operator.as_str() {
            "BT" => in_text = true,
            "ET" => in_text = false,
            _ if in_text => {}
            "q" => stack.push(ctm),
            "Q" => {
                if let Some(m) = stack.pop() {
                    ctm = m;
                }
            }
            "cm" if operands.len() == 6 => {
                let m: Mat = [
                    num(&operands[0])?,
                    num(&operands[1])?,
                    num(&operands[2])?,
                    num(&operands[3])?,
                    num(&operands[4])?,
                    num(&operands[5])?,
                ];
                ctm = mat_mul(m, ctm);
            }
            "m" | "l" if operands.len() == 2 => {
                let (dx, dy) = xform(ctm, num(&operands[0])?, num(&operands[1])?);
                path.add(dx, dy);
            }
            "c" if operands.len() == 6 => {
                path_curved = true;
                for k in [(0, 1), (2, 3), (4, 5)] {
                    let (dx, dy) = xform(ctm, num(&operands[k.0])?, num(&operands[k.1])?);
                    path.add(dx, dy);
                }
            }
            "v" | "y" if operands.len() == 4 => {
                path_curved = true;
                for k in [(0, 1), (2, 3)] {
                    let (dx, dy) = xform(ctm, num(&operands[k.0])?, num(&operands[k.1])?);
                    path.add(dx, dy);
                }
            }
            "re" if operands.len() == 4 => {
                let (x, y, w, h) = (
                    num(&operands[0])?,
                    num(&operands[1])?,
                    num(&operands[2])?,
                    num(&operands[3])?,
                );
                for (px, py) in [(x, y), (x + w, y), (x, y + h), (x + w, y + h)] {
                    let (dx, dy) = xform(ctm, px, py);
                    path.add(dx, dy);
                }
            }
            "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" => {
                commit(&path, path_curved, &mut elements);
                path = BBox::default();
                path_curved = false;
            }
            "n" => {
                path = BBox::default();
                path_curved = false;
            }
            // 이미지/폼 XObject = 진짜 그림 → curved 취급(그림 후보).
            "Do" => {
                let mut b = BBox::default();
                for (px, py) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
                    let (dx, dy) = xform(ctm, px, py);
                    b.add(dx, dy);
                }
                commit(&b, true, &mut elements);
            }
            _ => {}
        }
    }

    if elements.is_empty() {
        None
    } else {
        Some(elements)
    }
}

fn boxes_near(a: &BBox, b: &BBox, gap: f64) -> bool {
    let x_near = a.min_x <= b.max_x + gap && b.min_x <= a.max_x + gap;
    let y_near = a.min_y <= b.max_y + gap && b.min_y <= a.max_y + gap;
    x_near && y_near
}

/// 그리기 요소들을 근접 클러스터로 묶고, '그림'으로 가장 그럴듯한(면적 최대) 클러스터의
/// 경계 상자를 고른다. 작은 마크(글머리 기호 등)는 먼저 걸러 헤더 막대·본문 점이
/// 그림과 한 덩어리로 합쳐지는 것을 막는다.
fn pick_figure_cluster(elements: &[GraphicEl], mw: f64, mh: f64) -> Option<(f64, f64, f64, f64)> {
    // 작은 마크 제거(글머리 기호·아이콘 점). 한 변이라도 12pt↑면 유지.
    let min_dim = 12.0;
    let items: Vec<GraphicEl> = elements
        .iter()
        .copied()
        .filter(|e| e.bbox.w().max(e.bbox.h()) >= min_dim)
        .collect();
    if items.is_empty() {
        return None;
    }
    // 근접 병합(연결 요소). 라벨 박스와 도형이 한 그림으로 묶이도록 gap은 넉넉히.
    // 클러스터마다 경계 상자 + 곡선 요소 개수를 추적한다.
    // 요소가 아주 많으면(복잡 표 등) 병합 비용을 피해 전체 합집합으로 폴백.
    let gap = (mh * 0.06).clamp(24.0, 80.0);
    let mut clusters: Vec<(BBox, u32)> = items
        .iter()
        .map(|e| (e.bbox, if e.curved { 1 } else { 0 }))
        .collect();
    if clusters.len() <= 1500 {
        loop {
            let mut merged_any = false;
            'scan: for i in 0..clusters.len() {
                for j in (i + 1)..clusters.len() {
                    if boxes_near(&clusters[i].0, &clusters[j].0, gap) {
                        let other = clusters[j];
                        clusters[i].0.add(other.0.min_x, other.0.min_y);
                        clusters[i].0.add(other.0.max_x, other.0.max_y);
                        clusters[i].1 += other.1;
                        clusters.remove(j);
                        merged_any = true;
                        break 'scan;
                    }
                }
            }
            if !merged_any {
                break;
            }
        }
    }
    // '그림' 후보 = 곡선 요소가 여러 개(≥3)인 클러스터. 도형·일러스트·차트는 곡선이
    // 많지만, 둥근 모서리 텍스트 박스(곡선 1개)나 표(직선만)는 제외된다 → 글이 그림으로
    // 들어가는 것을 막는다.
    let best = clusters
        .iter()
        .filter(|(b, curves)| *curves >= 3 && b.set && b.w() > 4.0 && b.h() > 4.0)
        .max_by(|(a, _), (b, _)| (a.w() * a.h()).partial_cmp(&(b.w() * b.h())).unwrap())?
        .0;
    // 너무 작은(아이콘 수준) 클러스터면 그림 없음으로 본다.
    if best.w() < mw * 0.15 || best.h() < mh * 0.06 {
        return None;
    }
    Some((best.min_x, best.min_y, best.max_x, best.max_y))
}

/// 페이지를 렌더한 뒤 '그림' 영역만 잘라 반환한다(텍스트 제외). 그림이 없으면 None.
pub fn render_page_figure(doc: &Document, path: &str, page_number: usize, scale: f64) -> Option<RgbaImage> {
    let (ox, oy, mw, mh) = page_media_box(path, page_number)?;
    let pages = doc.get_pages();
    let page_id = *pages.get(&(page_number as u32))?;
    let (ux0, uy0, ux1, uy1) = page_graphics_bbox(doc, page_id, mw, mh)?;
    let full = render_pdf_page(path, page_number, scale)?;
    let pw = full.width() as f64;
    let ph = full.height() as f64;
    let pad = 10.0;
    // user space → 픽셀(상단 기준). y는 위가 큰 값이므로 뒤집어 매핑.
    let x0 = (((ux0 - ox) * scale) - pad).clamp(0.0, pw);
    let x1 = (((ux1 - ox) * scale) + pad).clamp(0.0, pw);
    let yt = (((oy + mh - uy1) * scale) - pad).clamp(0.0, ph);
    let yb = (((oy + mh - uy0) * scale) + pad).clamp(0.0, ph);
    let cw = (x1 - x0).max(1.0) as u32;
    let ch = (yb - yt).max(1.0) as u32;
    Some(image::imageops::crop_imm(&full, x0 as u32, yt as u32, cw, ch).to_image())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mat_mul_and_xform_compose_in_order() {
        // 먼저 2배 확대, 그 다음 (10,5) 평행이동.
        let scale: Mat = [2.0, 0.0, 0.0, 2.0, 0.0, 0.0];
        let translate: Mat = [1.0, 0.0, 0.0, 1.0, 10.0, 5.0];
        let m = mat_mul(scale, translate);
        // 점 (3,4) → 확대 (6,8) → 이동 (16,13).
        let (x, y) = xform(m, 3.0, 4.0);
        assert!((x - 16.0).abs() < 1e-9);
        assert!((y - 13.0).abs() < 1e-9);
    }

    #[test]
    fn bbox_excludes_text_and_background_keeps_figure() {
        use lopdf::content::Operation;
        // 배경 사각형(페이지 거의 전체) + 텍스트 + 작은 도형(그림).
        let ops = vec![
            // 배경: 페이지 전체 채움 → 제외돼야 함.
            Operation::new("re", vec![0.into(), 0.into(), 600.into(), 800.into()]),
            Operation::new("f", vec![]),
            // 텍스트 영역(좌표가 있어도 그림 경계에 안 들어가야 함).
            Operation::new("BT", vec![]),
            Operation::new("m", vec![10.into(), 700.into()]),
            Operation::new("ET", vec![]),
            // 곡선 도형 3개(서로 가까움) = 그림 후보. 합쳐서 경계 (100,100)~(250,300).
            Operation::new("m", vec![100.into(), 100.into()]),
            Operation::new("c", vec![120.into(), 100.into(), 140.into(), 120.into(), 150.into(), 150.into()]),
            Operation::new("f", vec![]),
            Operation::new("m", vec![150.into(), 150.into()]),
            Operation::new("c", vec![180.into(), 180.into(), 210.into(), 210.into(), 230.into(), 250.into()]),
            Operation::new("f", vec![]),
            Operation::new("m", vec![200.into(), 200.into()]),
            Operation::new("c", vec![220.into(), 250.into(), 240.into(), 280.into(), 250.into(), 300.into()]),
            Operation::new("f", vec![]),
        ];
        let content = Content { operations: ops };
        let elements = collect_graphic_elements(&content, 600.0, 800.0).unwrap();
        // 배경은 걸러지고 곡선 도형 3개만 남는다.
        assert_eq!(elements.len(), 3);
        assert!(elements.iter().all(|e| e.curved));
        let bbox = pick_figure_cluster(&elements, 600.0, 800.0).unwrap();
        assert!((bbox.0 - 100.0).abs() < 1.0);
        assert!((bbox.1 - 100.0).abs() < 1.0);
        assert!((bbox.2 - 250.0).abs() < 1.0);
        assert!((bbox.3 - 300.0).abs() < 1.0);

        // 곡선이 1개뿐인 클러스터(둥근 텍스트 박스 흉내)는 그림으로 보지 않는다.
        let rounded_box = vec![GraphicEl {
            bbox: {
                let mut b = BBox::default();
                b.add(50.0, 50.0);
                b.add(550.0, 400.0);
                b
            },
            curved: true,
        }];
        assert!(pick_figure_cluster(&rounded_box, 600.0, 800.0).is_none());
    }

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

    /// [실험] 구조적 분리 — 그림 영역만 잘라 /tmp/figure_N.png 로 쓴다(글 제외 확인용).
    #[test]
    #[ignore]
    fn experiment_render_figures() {
        let path = std::env::var("HOP_PDF").unwrap();
        let q = std::env::var("HOP_QUERY").unwrap_or_else(|_| "사업비 사용원칙 그림".to_string());
        let figs = render_query_figures(&path, &q, 2.0, 4);
        for (p, figure_only, img) in &figs {
            let out = format!("/tmp/figure_{}.png", p);
            img.save(&out).unwrap();
            println!(
                "  page {} figure_only={} {}x{} → {}",
                p,
                figure_only,
                img.width(),
                img.height(),
                out
            );
        }
    }
}
