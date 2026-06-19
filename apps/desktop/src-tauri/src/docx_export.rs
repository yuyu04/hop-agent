//! HWP 문서 모델 → DOCX(OOXML) 결정적 내보내기 (MVP).
//!
//! pdf_export.rs 와 같은 패턴: `export_core_to_docx(core, target_path)`.
//! AI/LLM 을 일절 사용하지 않고, `core.document()` IR 을 순회하여
//! WordprocessingML 을 직접 조립한다(F-ffa7449b). 구조는 앱이 결정적으로
//! 만들고, 충실도(MVP)는 텍스트·글자서식·문단정렬·단순 표로 한정한다.
//!
//! MVP 범위 밖(이미지/그림, 병합 셀, 각주/미주, 글상자/도형)은 panic 없이
//! 건너뛰거나 평탄화하여 손상되지 않은 .docx 를 만든다(AC: robustness).

use std::io::{Cursor, Write};
use std::path::Path;

use quick_xml::escape::escape;
use rhwp::model::control::Control;
use rhwp::model::document::Document;
use rhwp::model::paragraph::Paragraph;
use rhwp::model::style::{Alignment, CharShape, ParaShape};
use rhwp::model::table::Table;
use rhwp::DocumentCore;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::state::atomic_write;

const WORD_MAIN_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/// 현재 문서 모델을 DOCX 로 내보낸다.
pub fn export_core_to_docx(core: &DocumentCore, target_path: &Path) -> Result<(), String> {
    ensure_docx_path(target_path)?;
    let doc = core.document();
    let document_xml = build_document_xml(doc)?;
    let bytes = zip_docx(&document_xml)?;
    atomic_write(target_path, &bytes)?;
    Ok(())
}

/// 대상 경로가 .docx 확장자인지 검증한다(pdf_export::ensure_pdf_path 대칭).
pub(crate) fn ensure_docx_path(path: &Path) -> Result<(), String> {
    if path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("docx"))
        != Some(true)
    {
        return Err("DOCX 파일 경로는 .docx 확장자여야 합니다".to_string());
    }
    Ok(())
}

/// word/document.xml 전체 문자열을 만든다. 내보낼 문단이 하나도 없으면 거부한다.
pub(crate) fn build_document_xml(doc: &Document) -> Result<String, String> {
    let total_paragraphs: usize = doc.sections.iter().map(|s| s.paragraphs.len()).sum();
    if total_paragraphs == 0 {
        return Err("내보낼 내용이 없습니다".to_string());
    }

    let mut body = String::new();
    for section in &doc.sections {
        for para in &section.paragraphs {
            body.push_str(&paragraph_xml(para, doc));
        }
    }
    // 표가 본문 마지막 블록이면 Word 가 닫는 문단을 요구하므로 sectPr 앞에 빈 문단을 둔다.
    body.push_str("<w:p/>");
    body.push_str("<w:sectPr/>");

    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<w:document xmlns:w=\"{ns}\"><w:body>{body}</w:body></w:document>",
        ns = WORD_MAIN_NS,
        body = body
    ))
}

/// 문단 하나 → w:p (정렬 + 텍스트 런). 문단에 표 컨트롤이 있으면 그 뒤에 w:tbl 을 잇는다.
fn paragraph_xml(para: &Paragraph, doc: &Document) -> String {
    let mut out = String::new();

    let ppr = paragraph_properties(para, doc);
    let mut runs = String::new();
    for (text, shape_id) in paragraph_runs(para) {
        let cs = doc.doc_info.char_shapes.get(shape_id as usize);
        runs.push_str(&run_xml(&text, cs, doc));
    }
    out.push_str("<w:p>");
    out.push_str(&ppr);
    out.push_str(&runs);
    out.push_str("</w:p>");

    // MVP: 표만 본문에 인라인으로 출력. 그 외 컨트롤(그림/도형/각주 등)은 건너뛴다.
    for control in &para.controls {
        if let Control::Table(table) = control {
            out.push_str(&table_xml(table, doc));
            // 표 직후 빈 문단 — 연속 표/표-종료 시 Word 호환.
            out.push_str("<w:p/>");
        }
    }

    out
}

/// 문단 정렬 → w:pPr/w:jc. 정렬 정보를 못 찾으면 w:pPr 을 생략한다.
fn paragraph_properties(para: &Paragraph, doc: &Document) -> String {
    let Some(ps) = doc.doc_info.para_shapes.get(para.para_shape_id as usize) else {
        return String::new();
    };
    let jc = alignment_to_jc(ps);
    format!("<w:pPr><w:jc w:val=\"{}\"/></w:pPr>", jc)
}

fn alignment_to_jc(ps: &ParaShape) -> &'static str {
    match ps.alignment {
        Alignment::Left => "left",
        Alignment::Right => "right",
        Alignment::Center => "center",
        // 양쪽/배분/나눔은 양쪽 정렬로 근사.
        Alignment::Justify | Alignment::Distribute | Alignment::Split => "both",
    }
}

/// 한 런 → w:r (rPr + w:t). 텍스트는 XML 이스케이프하고 공백을 보존한다.
fn run_xml(text: &str, cs: Option<&CharShape>, doc: &Document) -> String {
    let rpr = cs.map(|c| run_properties(c, doc)).unwrap_or_default();
    format!(
        "<w:r>{rpr}<w:t xml:space=\"preserve\">{text}</w:t></w:r>",
        rpr = rpr,
        text = escape(text)
    )
}

/// 글자모양 → w:rPr (bold/italic/font/size/color).
fn run_properties(cs: &CharShape, doc: &Document) -> String {
    let mut rpr = String::new();
    if cs.bold {
        rpr.push_str("<w:b/>");
    }
    if cs.italic {
        rpr.push_str("<w:i/>");
    }
    if let Some(name) = hangul_font_name(cs, doc) {
        let n = escape(&name);
        rpr.push_str(&format!(
            "<w:rFonts w:ascii=\"{n}\" w:eastAsia=\"{n}\" w:hAnsi=\"{n}\" w:cs=\"{n}\"/>",
            n = n
        ));
    }
    if cs.base_size > 0 {
        // base_size: 1pt = 100 HWPUNIT. DOCX w:sz 는 half-point → base_size/50.
        let half_points = cs.base_size / 50;
        rpr.push_str(&format!(
            "<w:sz w:val=\"{hp}\"/><w:szCs w:val=\"{hp}\"/>",
            hp = half_points
        ));
    }
    if cs.text_color != 0 {
        rpr.push_str(&format!(
            "<w:color w:val=\"{}\"/>",
            colorref_to_hex(cs.text_color)
        ));
    }
    if rpr.is_empty() {
        String::new()
    } else {
        format!("<w:rPr>{}</w:rPr>", rpr)
    }
}

/// 한글(언어 인덱스 0) 글꼴 이름. 비어있거나 범위를 벗어나면 None.
fn hangul_font_name(cs: &CharShape, doc: &Document) -> Option<String> {
    let font_id = cs.font_ids[0] as usize;
    let name = doc.doc_info.font_faces.first()?.get(font_id)?.name.clone();
    if name.trim().is_empty() {
        None
    } else {
        Some(name)
    }
}

/// HWP ColorRef(u32, 0x00BBGGRR) → DOCX RRGGBB 16진수.
pub(crate) fn colorref_to_hex(color: u32) -> String {
    let r = color & 0xFF;
    let g = (color >> 8) & 0xFF;
    let b = (color >> 16) & 0xFF;
    format!("{:02X}{:02X}{:02X}", r, g, b)
}

/// 문단 텍스트를 글자모양 변경 경계에 따라 (텍스트, char_shape_id) 런으로 분할한다.
/// 제어문자(U+0000..U+001F)는 건너뛴다(표/개체 마커 등).
pub(crate) fn paragraph_runs(para: &Paragraph) -> Vec<(String, u32)> {
    let chars: Vec<char> = para.text.chars().collect();
    if chars.is_empty() {
        return Vec::new();
    }

    // char_offsets 가 문자 수와 어긋나면 런 분할을 신뢰할 수 없으므로
    // 첫 글자모양 하나로 전체를 단일 런 처리한다(견고성 폴백).
    let offsets_usable = para.char_offsets.len() == chars.len();
    let fallback_shape = para
        .char_shapes
        .first()
        .map(|r| r.char_shape_id)
        .unwrap_or(0);

    let mut runs: Vec<(String, u32)> = Vec::new();
    let mut cur_text = String::new();
    let mut cur_shape: Option<u32> = None;

    for (i, ch) in chars.iter().enumerate() {
        if (*ch as u32) < 0x20 {
            continue; // 제어/개체 마커 문자 제외
        }
        let shape_id = if offsets_usable {
            shape_at(para, para.char_offsets[i])
        } else {
            fallback_shape
        };
        match cur_shape {
            Some(s) if s == shape_id => cur_text.push(*ch),
            Some(s) => {
                if !cur_text.is_empty() {
                    runs.push((std::mem::take(&mut cur_text), s));
                }
                cur_text.push(*ch);
                cur_shape = Some(shape_id);
            }
            None => {
                cur_text.push(*ch);
                cur_shape = Some(shape_id);
            }
        }
    }
    if let Some(s) = cur_shape {
        if !cur_text.is_empty() {
            runs.push((cur_text, s));
        }
    }
    runs
}

/// UTF-16 위치 pos 에서 활성화된 char_shape_id (start_pos <= pos 인 마지막 항목).
fn shape_at(para: &Paragraph, pos: u32) -> u32 {
    let mut active = para.char_shapes.first().map(|r| r.char_shape_id).unwrap_or(0);
    for r in &para.char_shapes {
        if r.start_pos <= pos {
            active = r.char_shape_id;
        } else {
            break;
        }
    }
    active
}

/// 표 → w:tbl (단순 표). 병합 셀은 gridSpan 으로 근사, 행 병합(vMerge)은 평탄화한다.
fn table_xml(table: &Table, doc: &Document) -> String {
    let cols = table.col_count.max(1) as usize;

    let mut out = String::new();
    out.push_str("<w:tbl>");
    // 최소 표 속성: 단일 테두리 + 자동 폭.
    out.push_str(
        "<w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders>\
<w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
<w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
<w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
<w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
<w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
<w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"auto\"/>\
</w:tblBorders></w:tblPr>",
    );

    // tblGrid: 열 개수만큼 gridCol.
    out.push_str("<w:tblGrid>");
    for _ in 0..cols {
        out.push_str("<w:gridCol/>");
    }
    out.push_str("</w:tblGrid>");

    // 셀을 행별로 묶는다(cells 는 행 우선이지만 row 주소로 안전하게 그룹화).
    for row in 0..table.row_count {
        let mut row_cells: Vec<_> = table.cells.iter().filter(|c| c.row == row).collect();
        row_cells.sort_by_key(|c| c.col);
        if row_cells.is_empty() {
            continue;
        }
        out.push_str("<w:tr>");
        for cell in row_cells {
            out.push_str("<w:tc>");
            // tcPr: 열 병합은 gridSpan 으로 근사(>1 일 때만).
            out.push_str("<w:tcPr><w:tcW w:w=\"0\" w:type=\"auto\"/>");
            if cell.col_span > 1 {
                out.push_str(&format!("<w:gridSpan w:val=\"{}\"/>", cell.col_span));
            }
            out.push_str("</w:tcPr>");

            if cell.paragraphs.is_empty() {
                out.push_str("<w:p/>");
            } else {
                for cp in &cell.paragraphs {
                    out.push_str(&paragraph_xml(cp, doc));
                }
            }
            out.push_str("</w:tc>");
        }
        out.push_str("</w:tr>");
    }

    out.push_str("</w:tbl>");
    out
}

/// 세 개의 필수 파트를 ZIP(OPC) 컨테이너로 묶는다.
fn zip_docx(document_xml: &str) -> Result<Vec<u8>, String> {
    let content_types = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
</Types>";

    let root_rels = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>\
</Relationships>";

    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    let mut put = |name: &str, data: &str| -> Result<(), String> {
        zip.start_file(name, opts)
            .map_err(|e| format!("ZIP 엔트리 생성 실패({}): {}", name, e))?;
        zip.write_all(data.as_bytes())
            .map_err(|e| format!("ZIP 쓰기 실패({}): {}", name, e))?;
        Ok(())
    };

    put("[Content_Types].xml", content_types)?;
    put("_rels/.rels", root_rels)?;
    put("word/document.xml", document_xml)?;

    let cursor = zip
        .finish()
        .map_err(|e| format!("ZIP 마감 실패: {}", e))?;
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rhwp::model::control::Control;
    use rhwp::model::document::{Document, Section};
    use rhwp::model::image::Picture;
    use rhwp::model::paragraph::{CharShapeRef, Paragraph};
    use rhwp::model::style::{Alignment, CharShape, Font, ParaShape};
    use rhwp::model::table::{Cell, Table};

    // ---- fixture builders (model IR direct, no DocumentCore) ----

    /// 단순 문단: text + char_offsets(문자별 인덱스) + 첫 글자모양(id 0) 참조.
    fn simple_para(text: &str, para_shape_id: u16) -> Paragraph {
        let n = text.chars().count();
        Paragraph {
            text: text.to_string(),
            char_offsets: (0..n as u32).collect(),
            char_shapes: vec![CharShapeRef {
                start_pos: 0,
                char_shape_id: 0,
            }],
            para_shape_id,
            ..Default::default()
        }
    }

    /// 단일 문단 1 섹션 Document 를 만들고, char_shapes/para_shapes 를 채운다.
    fn doc_with(
        para: Paragraph,
        char_shapes: Vec<CharShape>,
        para_shapes: Vec<ParaShape>,
        hangul_fonts: Vec<Font>,
    ) -> Document {
        let mut doc = Document::default();
        doc.doc_info.char_shapes = char_shapes;
        doc.doc_info.para_shapes = para_shapes;
        if !hangul_fonts.is_empty() {
            doc.doc_info.font_faces = vec![hangul_fonts];
        }
        doc.sections = vec![Section {
            paragraphs: vec![para],
            ..Default::default()
        }];
        doc
    }

    // ---- AC1: 유효한 OOXML(.docx) 파일이 ZIP 으로 기록된다 ----

    #[test]
    fn ac1_export_writes_valid_docx_zip_container() {
        use std::io::Cursor;
        use zip::ZipArchive;

        let mut core = rhwp::DocumentCore::new_empty();
        core.create_blank_document_native().unwrap();
        core.insert_text_native(0, 0, 0, "안녕하세요").unwrap();

        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("out.docx");

        export_core_to_docx(&core, &target).expect("export 성공");

        let bytes = std::fs::read(&target).expect("파일이 생성되어야 함");
        let mut zip = ZipArchive::new(Cursor::new(bytes)).expect("ZIP 으로 읽혀야 함");
        assert!(zip.by_name("[Content_Types].xml").is_ok());
        assert!(zip.by_name("_rels/.rels").is_ok());
        assert!(zip.by_name("word/document.xml").is_ok());
    }

    // ---- AC2: 문단 → w:p/w:r/w:t + XML 이스케이프 ----

    #[test]
    fn ac2_paragraphs_emit_p_r_t_and_escape_text() {
        let para = simple_para("a&b<c", 0);
        let doc = doc_with(
            para,
            vec![CharShape::default()],
            vec![ParaShape::default()],
            vec![],
        );
        let xml = build_document_xml(&doc).expect("문단이 있으므로 성공");

        assert!(xml.contains("<w:p>"), "w:p 누락: {xml}");
        assert!(xml.contains("<w:r>"), "w:r 누락");
        assert!(xml.contains("<w:t"), "w:t 누락");
        // 텍스트 내용은 이스케이프, 태그(<w:..)는 보존되어야 한다.
        assert!(xml.contains("a&amp;b&lt;c"), "& 와 < 가 이스케이프되지 않음: {xml}");
        assert!(!xml.contains("a&b<c"), "원본 미이스케이프 텍스트가 남아있음");
    }

    // ---- AC3: 글자모양 → w:rPr ----

    #[test]
    fn ac3_char_formatting_maps_to_rpr() {
        let cs = CharShape {
            bold: true,
            italic: true,
            base_size: 1000, // → 1000/50 = 20 half-points
            text_color: 0x0000_00FF, // R=0xFF
            font_ids: [0, 0, 0, 0, 0, 0, 0],
            ..Default::default()
        };
        let font = Font {
            name: "바탕".to_string(),
            ..Default::default()
        };
        let para = simple_para("가", 0);
        let doc = doc_with(para, vec![cs], vec![ParaShape::default()], vec![font]);
        let xml = build_document_xml(&doc).unwrap();

        assert!(xml.contains("<w:b/>"), "bold → w:b 누락: {xml}");
        assert!(xml.contains("<w:i/>"), "italic → w:i 누락");
        assert!(xml.contains("<w:sz w:val=\"20\"/>"), "base_size 1000 → sz 20 누락");
        assert!(
            xml.contains("w:eastAsia=\"바탕\""),
            "한글 글꼴 이름 → rFonts eastAsia 누락: {xml}"
        );
        assert!(xml.contains("<w:rFonts"), "rFonts 누락");
        assert!(xml.contains("<w:color w:val="), "text_color → w:color 누락");
    }

    // ---- AC4: 문단 정렬 → w:jc ----

    fn jc_for(alignment: Alignment) -> String {
        let ps = ParaShape {
            alignment,
            ..Default::default()
        };
        let para = simple_para("문", 0);
        let doc = doc_with(para, vec![CharShape::default()], vec![ps], vec![]);
        build_document_xml(&doc).unwrap()
    }

    #[test]
    fn ac4_alignment_maps_to_jc() {
        assert!(jc_for(Alignment::Center).contains("<w:jc w:val=\"center\"/>"));
        assert!(jc_for(Alignment::Right).contains("<w:jc w:val=\"right\"/>"));
        assert!(jc_for(Alignment::Left).contains("<w:jc w:val=\"left\"/>"));
        assert!(jc_for(Alignment::Justify).contains("<w:jc w:val=\"both\"/>"));
    }

    // ---- AC5: 표 → w:tbl ----

    #[test]
    fn ac5_table_emits_tbl_tr_tc_gridcol_and_cell_text() {
        // 2x2 표, 각 셀에 텍스트 문단 하나.
        let mut cells = Vec::new();
        for row in 0..2u16 {
            for col in 0..2u16 {
                let label = format!("R{row}C{col}");
                cells.push(Cell {
                    row,
                    col,
                    col_span: 1,
                    row_span: 1,
                    paragraphs: vec![simple_para(&label, 0)],
                    ..Default::default()
                });
            }
        }
        let table = Table {
            row_count: 2,
            col_count: 2,
            cells,
            ..Default::default()
        };
        let mut para = simple_para("표앞", 0);
        para.controls = vec![Control::Table(Box::new(table))];

        let doc = doc_with(
            para,
            vec![CharShape::default()],
            vec![ParaShape::default()],
            vec![],
        );
        let xml = build_document_xml(&doc).unwrap();

        assert!(xml.contains("<w:tbl>"), "w:tbl 누락: {xml}");
        assert_eq!(xml.matches("<w:tr>").count(), 2, "행 2개여야 함");
        assert!(xml.contains("<w:tc>"), "w:tc 누락");
        assert_eq!(xml.matches("<w:gridCol/>").count(), 2, "gridCol 2개여야 함");
        // 셀 텍스트 보존
        for label in ["R0C0", "R0C1", "R1C0", "R1C1"] {
            assert!(xml.contains(label), "셀 텍스트 {label} 누락");
        }
    }

    // ---- AC6: 잘못된 경로 / 빈 문서 거부 ----

    #[test]
    fn ac6_ensure_docx_path_accepts_docx_rejects_others() {
        assert!(ensure_docx_path(Path::new("out.docx")).is_ok());
        assert!(ensure_docx_path(Path::new("OUT.DOCX")).is_ok(), "확장자 대소문자 무관");
        assert!(ensure_docx_path(Path::new("out.pdf")).is_err());
        assert!(ensure_docx_path(Path::new("out")).is_err(), "확장자 없음 거부");
    }

    #[test]
    fn ac6_build_document_xml_rejects_empty() {
        // sections 자체가 비어있는 경우
        let empty = Document::default();
        let err = build_document_xml(&empty).expect_err("빈 문서는 Err");
        assert!(err.contains("내보낼 내용"), "에러 메시지: {err}");

        // 섹션은 있으나 문단이 0개인 경우
        let mut doc = Document::default();
        doc.sections = vec![Section::default()];
        let err2 = build_document_xml(&doc).expect_err("문단 0개도 Err");
        assert!(err2.contains("내보낼 내용"));
    }

    // ---- AC7: 견고성(MVP 미지원 건너뜀, panic 없음) + colorref 바이트 순서 ----

    #[test]
    fn ac7_picture_control_is_skipped_without_panic_text_preserved() {
        let mut para = simple_para("그림있는문단", 0);
        para.controls = vec![Control::Picture(Box::new(Picture::default()))];

        let doc = doc_with(
            para,
            vec![CharShape::default()],
            vec![ParaShape::default()],
            vec![],
        );
        // panic 없이 동작해야 한다.
        let xml = build_document_xml(&doc).expect("그림이 있어도 성공");
        // 그림은 건너뛰되 문단 텍스트는 유지.
        assert!(xml.contains("그림있는문단"), "문단 텍스트 누락: {xml}");
        // 그림 관련 OOXML(w:drawing/pic) 은 방출되지 않는다.
        assert!(!xml.contains("<w:drawing"), "그림이 방출되면 안 됨");
    }

    #[test]
    fn ac7_colorref_byte_order_low_byte_is_red() {
        // HWP ColorRef 0x00BBGGRR: 0x00FF8040 → B=0xFF, G=0x80, R=0x40 → "4080FF"
        assert_eq!(colorref_to_hex(0x00FF_8040), "4080FF");
        // 순수 빨강(저바이트) 확인 — 저바이트 = R.
        assert_eq!(colorref_to_hex(0x0000_00FF), "FF0000");
        // 순수 파랑(고바이트) 확인.
        assert_eq!(colorref_to_hex(0x00FF_0000), "0000FF");
    }
}
