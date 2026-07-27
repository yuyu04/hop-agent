//! PDF 페이지의 '표·그림' 영역을 탐지해 잘라낸 이미지(PNG)로 돌려준다.
//!
//! `pdf_render`의 그림 탐지는 곡선이 여러 개인 클러스터(=일러스트/사진)만 고르고 표(직선
//! 격자)·괘선은 일부러 버린다. 연구노트 인제스트는 **표가 핵심**이므로, 여기서는 텍스트를
//! 뺀 '그리기' 기하(직선 포함)의 경계 상자를 모아 근접 클러스터로 묶고, 표·그림 크기의
//! 블록을 영역으로 잡는다(스크린샷처럼 그 영역만 잘라 항목에 이미지로 넣는다). 탐지가
//! 애매하면(클러스터가 임계 미달) 전체 콘텐츠 합집합으로 폴백한다 ≈ 페이지 통째 캡처.
//!
//! 기하 계산(경계 상자)은 lopdf만 쓰므로 크로스플랫폼·테스트 가능하다. 래스터화만
//! 플랫폼별(macOS=CoreGraphics, 그 외=pdfium)로 갈린다.

use image::RgbaImage;
use lopdf::content::Content;
use lopdf::{Document, Object};

/// 2×3 아핀 행렬 [a,b,c,d,e,f].
type Mat = [f64; 6];
const IDENTITY: Mat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// user space 사각형(왼아래 원점, y는 위로 증가).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}


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
    fn merge(&mut self, o: &BBox) {
        if o.set {
            self.add(o.min_x, o.min_y);
            self.add(o.max_x, o.max_y);
        }
    }
    fn w(&self) -> f64 {
        self.max_x - self.min_x
    }
    fn h(&self) -> f64 {
        self.max_y - self.min_y
    }
    fn rect(&self) -> Rect {
        Rect {
            x0: self.min_x,
            y0: self.min_y,
            x1: self.max_x,
            y1: self.max_y,
        }
    }
}

fn boxes_near(a: &BBox, b: &BBox, gap: f64) -> bool {
    a.min_x <= b.max_x + gap && b.min_x <= a.max_x + gap && a.min_y <= b.max_y + gap
        && b.min_y <= a.max_y + gap
}

/// 콘텐츠 스트림에서 '그리기' 기하(텍스트 제외, 직선·표 포함)의 개별 경계 상자를 모은다.
/// 페이지 배경(85%↑)만 버린다(괘선은 표의 일부이므로 남긴다).
fn collect_draw_boxes(content: &Content, mw: f64, mh: f64) -> Vec<BBox> {
    let page_area = (mw * mh).max(1.0);
    let mut ctm: Mat = IDENTITY;
    let mut stack: Vec<Mat> = Vec::new();
    let mut path = BBox::default();
    let mut out: Vec<BBox> = Vec::new();
    let mut in_text = false;

    let commit = |b: &BBox, out: &mut Vec<BBox>| {
        if b.set && b.w() * b.h() <= page_area * 0.85 {
            out.push(*b);
        }
    };

    for op in &content.operations {
        let ops = &op.operands;
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
            "cm" if ops.len() == 6 => {
                let m: Mat = [
                    num(&ops[0]).unwrap_or(0.0),
                    num(&ops[1]).unwrap_or(0.0),
                    num(&ops[2]).unwrap_or(0.0),
                    num(&ops[3]).unwrap_or(0.0),
                    num(&ops[4]).unwrap_or(0.0),
                    num(&ops[5]).unwrap_or(0.0),
                ];
                ctm = mat_mul(m, ctm);
            }
            "m" | "l" if ops.len() == 2 => {
                if let (Some(x), Some(y)) = (num(&ops[0]), num(&ops[1])) {
                    let (dx, dy) = xform(ctm, x, y);
                    path.add(dx, dy);
                }
            }
            "c" if ops.len() == 6 => {
                for k in [(0, 1), (2, 3), (4, 5)] {
                    if let (Some(x), Some(y)) = (num(&ops[k.0]), num(&ops[k.1])) {
                        let (dx, dy) = xform(ctm, x, y);
                        path.add(dx, dy);
                    }
                }
            }
            "v" | "y" if ops.len() == 4 => {
                for k in [(0, 1), (2, 3)] {
                    if let (Some(x), Some(y)) = (num(&ops[k.0]), num(&ops[k.1])) {
                        let (dx, dy) = xform(ctm, x, y);
                        path.add(dx, dy);
                    }
                }
            }
            "re" if ops.len() == 4 => {
                if let (Some(x), Some(y), Some(w), Some(h)) =
                    (num(&ops[0]), num(&ops[1]), num(&ops[2]), num(&ops[3]))
                {
                    for (px, py) in [(x, y), (x + w, y), (x, y + h), (x + w, y + h)] {
                        let (dx, dy) = xform(ctm, px, py);
                        path.add(dx, dy);
                    }
                }
            }
            "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" => {
                commit(&path, &mut out);
                path = BBox::default();
            }
            "n" => path = BBox::default(),
            // 이미지/폼 XObject = 단위정사각형(0..1)을 CTM로 변환한 영역.
            "Do" => {
                let mut b = BBox::default();
                for (px, py) in [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)] {
                    let (dx, dy) = xform(ctm, px, py);
                    b.add(dx, dy);
                }
                commit(&b, &mut out);
            }
            _ => {}
        }
    }
    out
}

/// 텍스트를 뺀 그리기 기하를 근접 클러스터로 묶어, 표·그림 크기의 영역들을 반환한다
/// (위→아래 순). 클러스터가 모두 임계 미달이면 전체 합집합 하나로 폴백(≈ 페이지 통째).
pub fn content_region_bboxes(content: &Content, mw: f64, mh: f64) -> Vec<Rect> {
    // 아주 작은 마크(글머리 점·아이콘)는 뺀다. 한 변이라도 8pt↑면 유지.
    let boxes: Vec<BBox> = collect_draw_boxes(content, mw, mh)
        .into_iter()
        .filter(|b| b.w().max(b.h()) >= 8.0)
        .collect();
    if boxes.is_empty() {
        return Vec::new();
    }

    // 근접 병합(연결 요소). 표 격자의 짧은 선분들이 한 덩어리로 묶이도록 gap은 넉넉히.
    let gap = (mh * 0.04).clamp(12.0, 50.0);
    let mut clusters: Vec<BBox> = boxes.clone();
    if clusters.len() <= 2000 {
        loop {
            let mut merged = false;
            'scan: for i in 0..clusters.len() {
                for j in (i + 1)..clusters.len() {
                    if boxes_near(&clusters[i], &clusters[j], gap) {
                        let other = clusters[j];
                        clusters[i].merge(&other);
                        clusters.remove(j);
                        merged = true;
                        break 'scan;
                    }
                }
            }
            if !merged {
                break;
            }
        }
    }

    // 표·그림 크기 = 폭 12%↑ + 높이 3%↑ + 면적 5%↑. 면적 조건이 섹션 제목 띠·라벨 박스
    // (넓지만 얇음) 같은 장식 사각형을 거른다 — 표/그림만 남긴다.
    let min_area = mw * mh * 0.05;
    let mut kept: Vec<Rect> = clusters
        .iter()
        .filter(|b| {
            b.set && b.w() >= mw * 0.12 && b.h() >= mh * 0.03 && b.w() * b.h() >= min_area
        })
        .map(|b| b.rect())
        .collect();

    if kept.is_empty() {
        // 탐지 애매 → 전체 그리기 합집합 하나로 폴백(스크린샷처럼).
        let mut all = BBox::default();
        for b in &boxes {
            all.merge(b);
        }
        if all.set {
            return vec![all.rect()];
        }
        return Vec::new();
    }

    // 위(y 큰 값)→아래 순으로 정렬해 본문 흐름과 같은 순서로 넣는다.
    kept.sort_by(|a, b| b.y1.partial_cmp(&a.y1).unwrap_or(std::cmp::Ordering::Equal));
    kept
}

/// 페이지 MediaBox(원점 x0,y0 + 폭/높이)를 lopdf로 읽는다(상속 추적).
pub fn media_box(doc: &Document, page_id: lopdf::ObjectId) -> Option<(f64, f64, f64, f64)> {
    let mut id = page_id;
    for _ in 0..32 {
        let dict = doc.get_dictionary(id).ok()?;
        if let Ok(mb) = dict.get(b"MediaBox") {
            let arr = doc.dereference(mb).ok()?.1.as_array().ok()?.clone();
            if arr.len() == 4 {
                let v: Vec<f64> = arr.iter().filter_map(num).collect();
                if v.len() == 4 {
                    let (x0, y0, x1, y1) = (v[0], v[1], v[2], v[3]);
                    return Some((x0.min(x1), y0.min(y1), (x1 - x0).abs(), (y1 - y0).abs()));
                }
            }
        }
        match dict.get(b"Parent").and_then(|p| p.as_reference()) {
            Ok(parent) => id = parent,
            Err(_) => break,
        }
    }
    None
}

/// 플랫폼별 단일 페이지 래스터화. macOS는 CoreGraphics, 그 외는 pdfium.
fn render_page(path: &str, page_number: usize, scale: f64) -> Option<RgbaImage> {
    #[cfg(target_os = "macos")]
    {
        super::pdf_render::render_pdf_page(path, page_number, scale)
    }
    #[cfg(not(target_os = "macos"))]
    {
        super::pdf_pdfium::render_single_page_pdfium(path, page_number, scale)
    }
}

/// user space 사각형을 렌더 이미지의 픽셀로 매핑해 잘라낸다(상단 기준, y 뒤집음).
fn crop_to_image(full: &RgbaImage, r: &Rect, ox: f64, oy: f64, mw: f64, mh: f64) -> Option<RgbaImage> {
    let (pw, ph) = (full.width() as f64, full.height() as f64);
    if mw <= 0.0 || mh <= 0.0 {
        return None;
    }
    let (sx, sy) = (pw / mw, ph / mh);
    let pad = 8.0;
    let x0 = (((r.x0 - ox) * sx) - pad).clamp(0.0, pw);
    let x1 = (((r.x1 - ox) * sx) + pad).clamp(0.0, pw);
    let yt = (((oy + mh - r.y1) * sy) - pad).clamp(0.0, ph);
    let yb = (((oy + mh - r.y0) * sy) + pad).clamp(0.0, ph);
    let cw = (x1 - x0).max(1.0) as u32;
    let ch = (yb - yt).max(1.0) as u32;
    if cw < 8 || ch < 8 {
        return None;
    }
    Some(image::imageops::crop_imm(full, x0 as u32, yt as u32, cw, ch).to_image())
}

/// 잘라낸 영역 한 개(PNG 바이트 + 픽셀 크기).
pub struct CroppedRegion {
    pub png: Vec<u8>,
    pub width_px: u32,
    pub height_px: u32,
}

/// 페이지(1-기준)에서 표·그림 영역을 모두 잘라 PNG로 반환한다. 영역이 없으면 빈 Vec.
pub fn extract_page_regions(doc: &Document, path: &str, page_number: usize, scale: f64) -> Vec<CroppedRegion> {
    let Some((ox, oy, mw, mh)) = page_id_and_box(doc, page_number) else {
        return Vec::new();
    };
    let pages = doc.get_pages();
    let Some(&page_id) = pages.get(&(page_number as u32)) else {
        return Vec::new();
    };
    let Ok(content) = doc.get_and_decode_page_content(page_id) else {
        return Vec::new();
    };
    let rects = content_region_bboxes(&content, mw, mh);
    if rects.is_empty() {
        return Vec::new();
    }
    let Some(full) = render_page(path, page_number, scale) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for r in &rects {
        let Some(cropped) = crop_to_image(&full, r, ox, oy, mw, mh) else {
            continue;
        };
        let (w, h) = (cropped.width(), cropped.height());
        let mut png = Vec::new();
        if image::DynamicImage::ImageRgba8(cropped)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .is_ok()
        {
            out.push(CroppedRegion { png, width_px: w, height_px: h });
        }
    }
    out
}

/// page_number(1-기준)의 MediaBox(원점+크기)를 구한다.
fn page_id_and_box(doc: &Document, page_number: usize) -> Option<(f64, f64, f64, f64)> {
    let pages = doc.get_pages();
    let page_id = *pages.get(&(page_number as u32))?;
    media_box(doc, page_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::Operation;
    use lopdf::Object;

    fn real(v: f64) -> Object {
        Object::Real(v as f32)
    }

    /// 표 크기의 사각형(re+S)은 영역으로 탐지된다.
    #[test]
    fn detects_table_sized_rectangle() {
        // A4: 595×842 pt. 표 = (100,400)~(495,700): 폭 395(>15%), 높이 300(>5%).
        let content = Content {
            operations: vec![
                Operation::new("re", vec![real(100.0), real(400.0), real(395.0), real(300.0)]),
                Operation::new("S", vec![]),
            ],
        };
        let rects = content_region_bboxes(&content, 595.0, 842.0);
        assert_eq!(rects.len(), 1, "표 사각형 하나 탐지");
        let r = &rects[0];
        assert!((r.x0 - 100.0).abs() < 1.0 && (r.x1 - 495.0).abs() < 1.0, "x 경계");
        assert!((r.y0 - 400.0).abs() < 1.0 && (r.y1 - 700.0).abs() < 1.0, "y 경계");
    }

    /// 텍스트(BT..ET) 안의 그리기처럼 보이는 좌표는 무시한다.
    #[test]
    fn ignores_text_block_geometry() {
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("re", vec![real(100.0), real(400.0), real(395.0), real(300.0)]),
                Operation::new("S", vec![]),
                Operation::new("ET", vec![]),
            ],
        };
        let rects = content_region_bboxes(&content, 595.0, 842.0);
        assert!(rects.is_empty(), "텍스트 블록 기하는 영역 아님");
    }

    /// 전체 페이지 배경(>85%)은 영역에서 제외한다.
    #[test]
    fn drops_full_page_background() {
        let content = Content {
            operations: vec![
                Operation::new("re", vec![real(0.0), real(0.0), real(595.0), real(842.0)]),
                Operation::new("f", vec![]),
            ],
        };
        let rects = content_region_bboxes(&content, 595.0, 842.0);
        assert!(rects.is_empty(), "페이지 배경은 영역 아님");
    }

    /// 떨어진 두 블록(표 + 그림)은 별도 영역으로, 위→아래 순으로 반환한다.
    #[test]
    fn returns_two_separated_blocks_top_to_bottom() {
        let content = Content {
            operations: vec![
                // 위쪽 블록 y=600~750
                Operation::new("re", vec![real(100.0), real(600.0), real(395.0), real(150.0)]),
                Operation::new("S", vec![]),
                // 아래쪽 블록 y=100~250 (gap 충분히 큼)
                Operation::new("re", vec![real(100.0), real(100.0), real(395.0), real(150.0)]),
                Operation::new("S", vec![]),
            ],
        };
        let rects = content_region_bboxes(&content, 595.0, 842.0);
        assert_eq!(rects.len(), 2, "두 블록");
        assert!(rects[0].y1 > rects[1].y1, "위쪽(큰 y)이 먼저");
    }

    #[test]
    fn empty_content_yields_no_regions() {
        let content = Content { operations: vec![] };
        assert!(content_region_bboxes(&content, 595.0, 842.0).is_empty());
    }

    /// [실험] 실제 PDF(HOP_PDF 환경변수로 지정)에서 페이지별 표·그림 영역을 탐지·크롭해
    /// /tmp에 저장한다. 렌더(CoreGraphics/pdfium)+크롭 파이프라인의 실데이터 검증용.
    /// 실행: HOP_PDF=/abs/file.pdf cargo test --lib pdf_figures::experiment -- --ignored --nocapture
    #[test]
    #[ignore]
    fn experiment_extract_real_pdf() {
        let Ok(path) = std::env::var("HOP_PDF") else {
            eprintln!("HOP_PDF 미지정 — 건너뜀");
            return;
        };
        let doc = Document::load(&path).expect("PDF 로드");
        let mut total = 0usize;
        for (&pnum, _) in doc.get_pages().iter() {
            let regions = extract_page_regions(&doc, &path, pnum as usize, 2.0);
            if !regions.is_empty() {
                eprintln!("p{}: 영역 {}개", pnum, regions.len());
            }
            for (k, reg) in regions.iter().enumerate() {
                let f = format!("/tmp/hop_pdf_region_p{}_{}.png", pnum, k);
                std::fs::write(&f, &reg.png).unwrap();
                eprintln!("  → {} ({}×{}px)", f, reg.width_px, reg.height_px);
                total += 1;
            }
        }
        eprintln!("총 크롭 {}개", total);
    }
}
