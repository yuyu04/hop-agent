//! PDF에서 내장 래스터 이미지를 추출한다.
//!
//! - DCTDecode(JPEG)·Flate/LZW(비압축 샘플)로 인코딩된 이미지를 다룬다.
//! - 많은 PDF 도형/그래프는 베이스 이미지가 거의 검고 실제 모양은 별도 SMask(알파)에
//!   들어 있다. SMask가 있으면 흰 배경에 합성해(투명→흰색) 정상적으로 보이게 한다.
//! - 벡터 그래프(선으로 그린 그림)는 이미지가 아니라 추출 대상이 아니다.
//! - JPXDecode·CCITTFax·CMYK 등은 건너뛴다. 중복(머리말/꼬리말 반복) 이미지는 제거한다.

use std::collections::HashSet;

use image::{ImageFormat, RgbImage};
use lopdf::{Document, Object, Stream};

/// 추출된 이미지 한 장.
pub struct ExtractedImage {
    pub data: Vec<u8>,
    pub mime: String,
}

/// 너무 작은 이미지(아이콘·장식)는 제외하는 최소 가로/세로(px).
const MIN_DIM: i64 = 48;

/// PDF 바이트에서 내장 이미지를 추출한다(중복 제거).
pub fn extract_pdf_images(bytes: &[u8]) -> Result<Vec<ExtractedImage>, String> {
    let doc = Document::load_mem(bytes).map_err(|e| format!("PDF 파싱 실패: {}", e))?;
    let mut out = Vec::new();
    let mut seen: HashSet<u64> = HashSet::new();

    for obj in doc.objects.values() {
        let stream = match obj {
            Object::Stream(s) => s,
            _ => continue,
        };
        if !is_image_xobject(&stream.dict) {
            continue;
        }
        // ImageMask(스텐실)은 그림 자체가 아님.
        if matches!(stream.dict.get(b"ImageMask"), Ok(Object::Boolean(true))) {
            continue;
        }
        let w = int(&stream.dict, b"Width");
        let h = int(&stream.dict, b"Height");
        if w < MIN_DIM || h < MIN_DIM {
            continue;
        }
        let filters = filter_names(stream);
        let has_dct = filters.iter().any(|f| f == b"DCTDecode");
        let has_flate_like = !filters.is_empty() && filters.iter().all(|f| is_flate_like(f));
        let has_smask = stream.dict.get(b"SMask").is_ok();

        let produced: Option<ExtractedImage> = if has_smask {
            // 베이스 RGB 디코드 → SMask 합성(흰 배경) → PNG.
            decode_base_rgb(stream, &filters, w as u32, h as u32).and_then(|mut rgb| {
                if let Some(alpha) = smask_alpha(&doc, &stream.dict, rgb.width(), rgb.height()) {
                    composite_on_white(&mut rgb, &alpha);
                }
                if is_mostly_black(&rgb) {
                    return None;
                }
                encode_png_rgb(&rgb).map(|data| ExtractedImage {
                    data,
                    mime: "image/png".to_string(),
                })
            })
        } else if has_dct && !filters.iter().any(|f| f == b"FlateDecode") {
            // SMask 없는 순수 JPEG. 거의 검은 이미지는 합성(블렌드/마스크) 레이어라 건너뛴다.
            decode_base_rgb(stream, &filters, w as u32, h as u32).and_then(|rgb| {
                if is_mostly_black(&rgb) {
                    return None;
                }
                Some(ExtractedImage {
                    data: stream.content.clone(),
                    mime: "image/jpeg".to_string(),
                })
            })
        } else if has_flate_like {
            decode_base_rgb(stream, &filters, w as u32, h as u32).and_then(|rgb| {
                if is_mostly_black(&rgb) {
                    return None;
                }
                encode_png_rgb(&rgb).map(|data| ExtractedImage {
                    data,
                    mime: "image/png".to_string(),
                })
            })
        } else {
            None
        };

        if let Some(img) = produced {
            if seen.insert(fnv1a(&img.data)) {
                out.push(img);
            }
        }
    }

    Ok(out)
}

fn is_image_xobject(dict: &lopdf::Dictionary) -> bool {
    dict.get(b"Subtype")
        .ok()
        .and_then(|o| o.as_name().ok())
        .map(|n| n == b"Image".as_slice())
        .unwrap_or(false)
}

fn int(dict: &lopdf::Dictionary, key: &[u8]) -> i64 {
    dict.get(key).ok().and_then(|o| o.as_i64().ok()).unwrap_or(0)
}

fn filter_names(stream: &Stream) -> Vec<Vec<u8>> {
    stream
        .filters()
        .map(|v| v.into_iter().map(<[u8]>::to_vec).collect())
        .unwrap_or_default()
}

fn is_flate_like(f: &[u8]) -> bool {
    f == b"FlateDecode" || f == b"LZWDecode" || f == b"ASCII85Decode"
}

/// 베이스 이미지를 RGB로 디코드한다(JPEG는 image 크레이트, Flate는 raw 샘플).
fn decode_base_rgb(stream: &Stream, filters: &[Vec<u8>], w: u32, h: u32) -> Option<RgbImage> {
    if filters.iter().any(|f| f == b"DCTDecode") {
        let img = image::load_from_memory_with_format(&stream.content, ImageFormat::Jpeg).ok()?;
        return Some(img.to_rgb8());
    }
    if !filters.is_empty() && filters.iter().all(|f| is_flate_like(f)) {
        let raw = stream.decompressed_content().ok()?;
        let px = (w as usize).checked_mul(h as usize)?;
        if px == 0 {
            return None;
        }
        let channels = raw.len() / px;
        return match channels {
            1 => {
                let mut rgb = Vec::with_capacity(px * 3);
                for &g in &raw[..px] {
                    rgb.extend_from_slice(&[g, g, g]);
                }
                RgbImage::from_raw(w, h, rgb)
            }
            3 => RgbImage::from_raw(w, h, raw[..px * 3].to_vec()),
            4 => {
                // RGBA → 흰 배경 합성으로 RGB.
                let mut rgb = Vec::with_capacity(px * 3);
                for chunk in raw[..px * 4].chunks_exact(4) {
                    let a = chunk[3] as u16;
                    for &c in &chunk[..3] {
                        rgb.push(((c as u16 * a + 255 * (255 - a)) / 255) as u8);
                    }
                }
                RgbImage::from_raw(w, h, rgb)
            }
            _ => None,
        };
    }
    None
}

/// SMask(그레이 알파)를 베이스 크기에 맞춰 알파 바이트로 디코드한다.
fn smask_alpha(doc: &Document, dict: &lopdf::Dictionary, base_w: u32, base_h: u32) -> Option<Vec<u8>> {
    let smask = resolve_stream(doc, dict.get(b"SMask").ok()?)?;
    let sw = int(&smask.dict, b"Width") as u32;
    let sh = int(&smask.dict, b"Height") as u32;
    if sw == 0 || sh == 0 {
        return None;
    }
    let raw = smask.decompressed_content().ok()?;
    let need = (sw as usize).checked_mul(sh as usize)?;
    if raw.len() < need {
        return None;
    }
    let gray = image::GrayImage::from_raw(sw, sh, raw[..need].to_vec())?;
    if sw == base_w && sh == base_h {
        return Some(gray.into_raw());
    }
    let resized = image::imageops::resize(&gray, base_w, base_h, image::imageops::FilterType::Triangle);
    Some(resized.into_raw())
}

/// 알파로 흰 배경에 합성한다(투명한 곳은 흰색).
fn composite_on_white(rgb: &mut RgbImage, alpha: &[u8]) {
    let (w, h) = rgb.dimensions();
    if alpha.len() < (w as usize) * (h as usize) {
        return;
    }
    for y in 0..h {
        for x in 0..w {
            let a = alpha[(y * w + x) as usize] as u16;
            let p = rgb.get_pixel_mut(x, y);
            for c in 0..3 {
                p[c] = ((p[c] as u16 * a + 255 * (255 - a)) / 255) as u8;
            }
        }
    }
}

fn resolve_stream<'a>(doc: &'a Document, obj: &'a Object) -> Option<&'a Stream> {
    let target = match obj {
        Object::Reference(id) => doc.get_object(*id).ok()?,
        other => other,
    };
    match target {
        Object::Stream(s) => Some(s),
        _ => None,
    }
}

/// 평균 밝기가 아주 낮으면(거의 검정) 합성/마스크 레이어로 보고 추출에서 제외한다.
/// 합성 후(흰 배경)에는 투명 영역이 흰색이 되므로 정상 그림은 걸리지 않는다.
fn is_mostly_black(rgb: &RgbImage) -> bool {
    let pixels = rgb.as_raw();
    if pixels.is_empty() {
        return true;
    }
    let sum: u64 = pixels.iter().map(|&b| b as u64).sum();
    let mean = sum / pixels.len() as u64;
    mean < 16
}

fn encode_png_rgb(rgb: &RgbImage) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    rgb.write_to(&mut std::io::Cursor::new(&mut out), ImageFormat::Png)
        .ok()?;
    Some(out)
}

fn fnv1a(data: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_pdf_bytes_return_error_not_panic() {
        assert!(extract_pdf_images(b"this is not a pdf").is_err());
    }

    #[test]
    fn mostly_black_image_is_detected() {
        let black = RgbImage::from_raw(4, 4, vec![0u8; 48]).unwrap();
        assert!(is_mostly_black(&black));
        let white = RgbImage::from_raw(4, 4, vec![255u8; 48]).unwrap();
        assert!(!is_mostly_black(&white));
    }

    /// [실험] HOP_PDF에서 이미지를 추출해 /tmp/pdfimg_N.* 로 쓰고 개수/크기를 출력한다.
    #[test]
    #[ignore]
    fn experiment_extract_real_pdf() {
        let path = std::env::var("HOP_PDF").unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let imgs = extract_pdf_images(&bytes).unwrap();
        println!("추출 이미지 수: {}", imgs.len());
        for (i, img) in imgs.iter().enumerate() {
            let ext = if img.mime.contains("png") { "png" } else { "jpg" };
            let out = format!("/tmp/pdfimg_{}.{}", i, ext);
            std::fs::write(&out, &img.data).unwrap();
            println!("  #{} {} {}바이트 → {}", i, img.mime, img.data.len(), out);
        }
    }
}
