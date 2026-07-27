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

/// 요소의 속성 중 로컬 이름이 `want`인 값을 문자열로 반환한다(네임스페이스 접두사 무시).
fn attr_by_local(e: &quick_xml::events::BytesStart, want: &[u8]) -> Option<String> {
    for a in e.attributes().flatten() {
        if local_name(a.key.as_ref()) == want {
            return a.unescape_value().ok().map(|v| v.into_owned());
        }
    }
    None
}

/// `<wp:extent cx cy>`에서 (cx, cy) EMU를 읽는다.
fn read_extent_emu(e: &quick_xml::events::BytesStart) -> Option<(u64, u64)> {
    let cx = attr_by_local(e, b"cx")?.parse::<u64>().ok()?;
    let cy = attr_by_local(e, b"cy")?.parse::<u64>().ok()?;
    Some((cx, cy))
}

/// `<a:blip r:embed>`에서 ImageRef(현재 extent 크기와 묶어)를 만든다.
fn blip_image_ref(e: &quick_xml::events::BytesStart, extent: Option<(u64, u64)>) -> Option<ImageRef> {
    let rid = attr_by_local(e, b"embed")?;
    let (w, h) = extent.unwrap_or((0, 0));
    Some(ImageRef { rid, width_emu: w, height_emu: h })
}

// ───────────────────────────── 구조 파싱(인제스트용) ─────────────────────────────
//
// 평문 추출(위)과 달리, 외부 파일을 HWP 양식에 채우려면 항목 경계·필드가 살아야 한다.
// `word/document.xml`의 최상위 블록(표/단락)을 문서 순서대로 모은 뒤, 연구노트 양식의
// "[제목 표] + [본문 단락들] + [메타 표]" 단위를 식별해 레코드로 만든다(검증: 2026년 1월
// 연구노트 docx에서 45/45 완전 추출). 구조는 앱이 결정적으로 — LLM은 관여하지 않는다.

/// 본문 인라인 이미지 한 개(Phase B-1). 본문 단락 사이 위치 + 바이트(base64) + 크기.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EntryImage {
    /// 이 그림을 넣을 위치 — body_paragraphs의 몇 번째 단락 '뒤'인지(0=첫 단락 앞).
    pub after_body_index: usize,
    /// 이미지 바이트(base64). parse_docx_structure가 zip+rels로 채운다.
    pub data_base64: String,
    /// 확장자(png/jpeg 등) — media 경로에서.
    pub ext: String,
    pub width_px: u32,
    pub height_px: u32,
    /// document.xml.rels 참조 id(내부용 — 바이트 해석 후 직렬화 제외).
    #[serde(skip)]
    rid: String,
}

impl EntryImage {
    /// 바이트가 이미 손에 있는 인라인 이미지(예: PDF에서 잘라낸 표·그림 PNG)를 만든다.
    /// rid는 비운다(rels 해석이 필요 없으므로).
    pub fn inline(
        after_body_index: usize,
        data_base64: String,
        ext: String,
        width_px: u32,
        height_px: u32,
    ) -> Self {
        EntryImage {
            after_body_index,
            data_base64,
            ext,
            width_px,
            height_px,
            rid: String::new(),
        }
    }
}

/// 본문 표 한 개(본문 단락 사이에 들어가는 데이터 표). 제목·메타 표는 제외.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EntryTable {
    /// 이 표를 넣을 위치 — body_paragraphs의 몇 번째 단락 '뒤'인지(0=첫 단락 앞).
    pub after_body_index: usize,
    pub rows: usize,
    pub cols: usize,
    /// 셀 텍스트(row-major, rows×cols).
    pub cells: Vec<String>,
}

/// 연구노트 한 항목.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EntryRecord {
    pub title: String,
    /// 본문 단락(계층 불릿 Ÿ/1./–/□① 텍스트를 순서대로 보존, 평탄화 금지).
    pub body_paragraphs: Vec<String>,
    pub recorders: Vec<String>,
    pub confirmer: String,
    pub record_date: String,
    pub confirm_date: String,
    /// 본문 인라인 이미지(없으면 빈 Vec).
    pub images: Vec<EntryImage>,
    /// 본문 데이터 표(없으면 빈 Vec).
    pub body_tables: Vec<EntryTable>,
}

/// 목차 한 행.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct TocItem {
    pub no: String,
    pub title: String,
    pub date: String,
}

/// 표지(첫 페이지) 메타 — 관리번호·기관/과제 정보·기록자 명단. 항목 메타(기록자/일자)와
/// 별개로, HWP 양식 표지 표를 docx 표지 값으로 채우는 데 쓴다. 못 찾은 필드는 빈 값.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CoverMeta {
    /// "관리번호 : RS-…" 줄 전체(표지 상단 문단에서).
    pub manage_no: String,
    /// 기관명(라벨 "기 관 명" — 공백 제거 정규화로 매칭).
    pub org: String,
    pub dept: String,
    pub project: String,
    pub period: String,
    /// 연구책임자.
    pub lead: String,
    /// 기록자 명단 — "1. 홍길동  2. 임꺽정 …" 번호 매김 값을 이름 리스트로 분해.
    pub recorders: Vec<String>,
}

/// docx에서 추출한 연구노트 구조 전체.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ResearchNoteDoc {
    pub entries: Vec<EntryRecord>,
    pub toc: Vec<TocItem>,
    /// 표지 메타(표지 표를 못 찾으면 None — 항목/목차 변환은 그대로 진행).
    pub cover: Option<CoverMeta>,
}

/// 본문 인라인 그림 참조(rId + EMU 크기). 바이트는 나중에 zip+rels로 해석.
struct ImageRef {
    rid: String,
    width_emu: u64,
    height_emu: u64,
}

/// 최상위 블록(문서 순서 보존).
enum Block {
    Para(String),
    Table(TableData),
    Image(ImageRef),
}

/// 표 한 개. 셀은 row-major, `row_count`로 1행 표(항목 제목)를 식별한다.
struct TableData {
    row_count: usize,
    cells: Vec<String>,
}

impl TableData {
    /// 열 수 추정(셀 수 / 행 수). 행이 없으면 0.
    fn col_count(&self) -> usize {
        self.cells.len().checked_div(self.row_count).unwrap_or(0)
    }
}

/// DOCX 바이트에서 연구노트 구조(항목 + 목차)를 추출한다.
pub fn parse_docx_structure(bytes: &[u8]) -> Result<ResearchNoteDoc, String> {
    let reader = std::io::Cursor::new(bytes);
    let mut archive =
        zip::ZipArchive::new(reader).map_err(|e| format!("DOCX(zip) 열기 실패: {}", e))?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|_| "DOCX에 word/document.xml이 없습니다".to_string())?
        .read_to_string(&mut xml)
        .map_err(|e| format!("document.xml 읽기 실패: {}", e))?;

    // rId → media 경로 매핑(이미지 해석용). 없으면 빈 맵(그림 없는 docx).
    let mut rels = String::new();
    let _ = archive
        .by_name("word/_rels/document.xml.rels")
        .map(|mut f| f.read_to_string(&mut rels));
    let rid_to_target = parse_rels_image_map(&rels);

    let mut doc = parse_structure_from_document_xml(&xml)?;
    // 각 항목 이미지의 바이트(base64)·확장자를 zip+rels로 채운다. 해석 실패한 이미지는 버린다.
    for entry in &mut doc.entries {
        let mut resolved: Vec<EntryImage> = Vec::new();
        for mut img in std::mem::take(&mut entry.images) {
            let Some(target) = rid_to_target.get(&img.rid) else { continue };
            let path = format!("word/{}", target);
            let mut data = Vec::new();
            if archive.by_name(&path).map(|mut f| f.read_to_end(&mut data)).is_err()
                || data.is_empty()
            {
                continue;
            }
            img.ext = target.rsplit('.').next().unwrap_or("png").to_lowercase();
            use base64::{engine::general_purpose::STANDARD, Engine as _};
            img.data_base64 = STANDARD.encode(&data);
            resolved.push(img);
        }
        entry.images = resolved;
    }
    Ok(doc)
}

/// `word/_rels/document.xml.rels`에서 이미지 관계(rId → Target=media 경로)만 추출한다.
fn parse_rels_image_map(rels_xml: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let mut reader = Reader::from_str(rels_xml);
    reader.config_mut().trim_text(false);
    loop {
        match reader.read_event() {
            Ok(Event::Empty(e)) | Ok(Event::Start(e))
                if local_name(e.name().as_ref()) == b"Relationship" =>
            {
                let ty = attr_by_local(&e, b"Type").unwrap_or_default();
                if ty.ends_with("/image") {
                    if let (Some(id), Some(tgt)) =
                        (attr_by_local(&e, b"Id"), attr_by_local(&e, b"Target"))
                    {
                        map.insert(id, tgt);
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    map
}

/// `word/document.xml` 문자열 → 구조(순수 함수 — 테스트 가능).
fn parse_structure_from_document_xml(xml: &str) -> Result<ResearchNoteDoc, String> {
    let blocks = parse_blocks(xml);

    // 항목 제목 표 = 1행 + 첫 셀이 "제목"으로 시작.
    let is_title = |b: &Block| -> bool {
        matches!(b, Block::Table(t)
            if t.row_count == 1 && t.cells.first().is_some_and(|c| c.trim_start().starts_with("제목")))
    };
    let title_idx: Vec<usize> = blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| is_title(b))
        .map(|(i, _)| i)
        .collect();

    let mut entries = Vec::new();
    for (n, &start) in title_idx.iter().enumerate() {
        let end = title_idx.get(n + 1).copied().unwrap_or(blocks.len());
        let title = match &blocks[start] {
            Block::Table(t) => entry_title(t),
            _ => String::new(),
        };
        let mut body_paragraphs = Vec::new();
        let mut meta = MetaFields::default();
        let mut images: Vec<EntryImage> = Vec::new();
        let mut body_tables: Vec<EntryTable> = Vec::new();
        for block in &blocks[start + 1..end] {
            match block {
                Block::Para(p) if !p.trim().is_empty() => body_paragraphs.push(p.clone()),
                Block::Table(t) if t.cells.iter().any(|c| c.contains("기록 일자")) => {
                    meta = parse_meta(t);
                }
                // 메타·제목이 아닌 표 = 본문 데이터 표 → 셀에 진짜 중첩 표로 넣을 위치·내용 기록.
                Block::Table(t) if t.row_count > 0 && t.col_count() > 0 => {
                    body_tables.push(EntryTable {
                        after_body_index: body_paragraphs.len(),
                        rows: t.row_count,
                        cols: t.col_count(),
                        cells: t.cells.clone(),
                    });
                }
                Block::Image(img) => {
                    // EMU→px: 914400 EMU/inch ÷ 96 px/inch = 9525 EMU/px. 바이트(base64)·ext는
                    // parse_docx_structure가 zip+rels로 채운다(여기선 rid·위치·크기만).
                    images.push(EntryImage {
                        after_body_index: body_paragraphs.len(),
                        data_base64: String::new(),
                        ext: String::new(),
                        width_px: (img.width_emu / 9525) as u32,
                        height_px: (img.height_emu / 9525) as u32,
                        rid: img.rid.clone(),
                    });
                }
                _ => {}
            }
        }
        entries.push(EntryRecord {
            title,
            body_paragraphs,
            recorders: meta.recorders,
            confirmer: meta.confirmer,
            record_date: meta.record_date,
            confirm_date: meta.confirm_date,
            images,
            body_tables,
        });
    }

    if entries.is_empty() {
        return Err(
            "연구노트 항목을 찾지 못했습니다 — '제목' 표로 시작하고 '기록 일자' 메타 표로 \
             끝나는 양식이 아닙니다(이 인제스트는 연구노트형 docx를 대상으로 합니다)."
                .to_string(),
        );
    }

    let toc = blocks.iter().find_map(|b| match b {
        Block::Table(t) if t.cells.iter().any(|c| c.contains("일련번호")) => Some(parse_toc(t)),
        _ => None,
    });

    Ok(ResearchNoteDoc {
        entries,
        toc: toc.unwrap_or_default(),
        cover: parse_cover(&blocks),
    })
}

/// 공백(스페이스·탭·개행) 제거 정규화 — 표지 라벨은 "기 관 명"처럼 자간 공백이 들어간다.
fn normalize_ws(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

/// 번호 매김 명단("1. 홍길동   2. 임꺽정 …", 여러 줄 가능)을 이름 리스트로 분해한다.
/// 번호 패턴이 없으면 쉼표 분리로 폴백한다(항목 메타의 기록자 형식과 동일).
fn split_numbered_names(value: &str) -> Vec<String> {
    // "숫자들 + '.'" 경계에서 자른다. 경계 앞까지가 직전 이름.
    let chars: Vec<char> = value.chars().collect();
    let mut boundaries: Vec<(usize, usize)> = Vec::new(); // (번호 시작, 이름 시작)
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i < chars.len() && chars[i] == '.' {
                boundaries.push((start, i + 1));
            }
        } else {
            i += 1;
        }
    }
    if boundaries.is_empty() {
        return value
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
    }
    let mut names = Vec::new();
    for (n, &(_, name_start)) in boundaries.iter().enumerate() {
        let end = boundaries.get(n + 1).map(|&(b, _)| b).unwrap_or(chars.len());
        let name: String = chars[name_start..end].iter().collect();
        let name = name.trim().to_string();
        if !name.is_empty() {
            names.push(name);
        }
    }
    names
}

/// 표지 메타를 추출한다 — 라벨 2열 표(기관명+연구과제명 라벨을 함께 가진 첫 표)와,
/// 그 앞 문단들 중 "관리번호"로 시작하는 줄. 표를 못 찾으면 None.
fn parse_cover(blocks: &[Block]) -> Option<CoverMeta> {
    let cover_idx = blocks.iter().position(|b| match b {
        Block::Table(t) => {
            let labels: Vec<String> = t
                .cells
                .chunks(t.col_count().max(1))
                .filter_map(|row| row.first())
                .map(|c| normalize_ws(c))
                .collect();
            labels.iter().any(|l| l == "기관명") && labels.iter().any(|l| l == "연구과제명")
        }
        _ => false,
    })?;

    let mut cover = CoverMeta {
        manage_no: String::new(),
        org: String::new(),
        dept: String::new(),
        project: String::new(),
        period: String::new(),
        lead: String::new(),
        recorders: Vec::new(),
    };
    // 관리번호: 표지 표 앞 문단들에서 찾는다(docx 표지 상단은 표가 아니라 문단).
    for b in &blocks[..cover_idx] {
        if let Block::Para(p) = b {
            if normalize_ws(p).starts_with("관리번호") {
                cover.manage_no = p.trim().to_string();
                break;
            }
        }
    }
    if let Block::Table(t) = &blocks[cover_idx] {
        let cols = t.col_count().max(1);
        for row in t.cells.chunks(cols) {
            let (Some(label), Some(value)) = (row.first(), row.get(1)) else { continue };
            let value = value.trim();
            match normalize_ws(label).as_str() {
                "기관명" => cover.org = value.to_string(),
                "부서명" => cover.dept = value.to_string(),
                "연구과제명" => cover.project = value.to_string(),
                "연구기간" => cover.period = value.to_string(),
                "연구책임자" => cover.lead = value.to_string(),
                "기록자" => cover.recorders = split_numbered_names(value),
                _ => {}
            }
        }
    }
    Some(cover)
}

/// 항목 제목 표에서 제목 문자열을 뽑는다(라벨 셀 "제목" 제외).
fn entry_title(t: &TableData) -> String {
    if t.cells.len() >= 2 {
        t.cells[1..].join(" ").trim().to_string()
    } else {
        t.cells
            .first()
            .map(|c| c.trim_start().trim_start_matches("제목").trim().to_string())
            .unwrap_or_default()
    }
}

#[derive(Default)]
struct MetaFields {
    recorders: Vec<String>,
    confirmer: String,
    record_date: String,
    confirm_date: String,
}

/// 메타 표(라벨-값 쌍: 기록자/확인자/기록 일자/확인 일자)를 파싱한다.
fn parse_meta(t: &TableData) -> MetaFields {
    let mut m = MetaFields::default();
    let mut i = 0;
    while i + 1 < t.cells.len() {
        let label = t.cells[i].trim();
        let value = t.cells[i + 1].trim();
        match label {
            "기록자" => {
                m.recorders = value
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            }
            "확인자" => m.confirmer = value.to_string(),
            "기록 일자" => m.record_date = value.to_string(),
            "확인 일자" => m.confirm_date = value.to_string(),
            _ => {}
        }
        i += 2;
    }
    m
}

/// 목차 표(헤더행 + N행, 일련번호/제목/날짜)를 레코드로 변환한다.
fn parse_toc(t: &TableData) -> Vec<TocItem> {
    let cols = t.col_count();
    if cols < 2 {
        return Vec::new();
    }
    // 첫 행은 헤더 → 건너뛴다.
    t.cells
        .chunks(cols)
        .skip(1)
        .filter_map(|row| {
            let no = row.first().map(|s| s.trim()).unwrap_or("");
            if no.is_empty() {
                return None;
            }
            Some(TocItem {
                no: no.to_string(),
                title: row.get(1).map(|s| s.trim().to_string()).unwrap_or_default(),
                date: row.last().map(|s| s.trim().to_string()).unwrap_or_default(),
            })
        })
        .collect()
}

/// `word/document.xml`을 최상위 블록(표/단락) 순서대로 수집한다.
///
/// 표 셀 안의 단락(`<w:p>`)과 본문 최상위 단락을 구분하기 위해 표 중첩 깊이를 센다.
/// 중첩 표(표 안의 표)는 본 MVP 대상이 아니며, 바깥 셀 텍스트로 평탄화될 뿐 패닉하지 않는다.
fn parse_blocks(xml: &str) -> Vec<Block> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);

    let mut blocks: Vec<Block> = Vec::new();
    let mut tbl_depth = 0usize;
    let mut in_text = false;
    let mut in_cell = false;
    let mut para = String::new();
    let mut cell_text = String::new();
    let mut table: Option<TableData> = None;
    // 본문(tbl_depth==0) 문단 안 인라인 그림: extent(크기) 다음 blip(rId) 순으로 나타난다.
    let mut cur_extent: Option<(u64, u64)> = None;
    let mut cur_image: Option<ImageRef> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => match local_name(e.name().as_ref()) {
                b"tbl" => {
                    tbl_depth += 1;
                    if tbl_depth == 1 {
                        table = Some(TableData { row_count: 0, cells: Vec::new() });
                    }
                }
                b"tr" if tbl_depth == 1 => {
                    if let Some(t) = table.as_mut() {
                        t.row_count += 1;
                    }
                }
                b"tc" if tbl_depth == 1 => {
                    in_cell = true;
                    cell_text.clear();
                }
                b"t" => in_text = true,
                b"extent" if tbl_depth == 0 => cur_extent = read_extent_emu(&e).or(cur_extent),
                b"blip" if tbl_depth == 0 => {
                    if let Some(img) = blip_image_ref(&e, cur_extent) {
                        cur_image = Some(img);
                    }
                }
                _ => {}
            },
            Ok(Event::End(e)) => match local_name(e.name().as_ref()) {
                b"t" => in_text = false,
                b"tc" if tbl_depth == 1 => {
                    in_cell = false;
                    if let Some(t) = table.as_mut() {
                        t.cells.push(cell_text.trim().to_string());
                    }
                    cell_text.clear();
                }
                b"p" => {
                    if tbl_depth == 0 {
                        blocks.push(Block::Para(std::mem::take(&mut para)));
                        // 이 본문 문단에 인라인 그림이 있었으면 문단 뒤에 이미지 블록으로 둔다.
                        if let Some(img) = cur_image.take() {
                            blocks.push(Block::Image(img));
                        }
                        cur_extent = None;
                    } else if in_cell {
                        // 셀 안 문단 경계 → 줄바꿈으로 이어 붙인다.
                        cell_text.push('\n');
                    }
                }
                b"tbl" => {
                    if tbl_depth == 1 {
                        if let Some(t) = table.take() {
                            blocks.push(Block::Table(t));
                        }
                    }
                    tbl_depth = tbl_depth.saturating_sub(1);
                }
                _ => {}
            },
            Ok(Event::Text(e)) if in_text => {
                if let Ok(text) = e.xml_content() {
                    if tbl_depth >= 1 {
                        if in_cell {
                            cell_text.push_str(&text);
                        }
                    } else {
                        para.push_str(&text);
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                match local_name(e.name().as_ref()) {
                    b"extent" if tbl_depth == 0 => {
                        cur_extent = read_extent_emu(&e).or(cur_extent);
                    }
                    b"blip" if tbl_depth == 0 => {
                        if let Some(img) = blip_image_ref(&e, cur_extent) {
                            cur_image = Some(img);
                        }
                    }
                    b"tab" => {
                        if tbl_depth >= 1 {
                            if in_cell {
                                cell_text.push('\t');
                            }
                        } else {
                            para.push('\t');
                        }
                    }
                    b"br" => {
                        if tbl_depth >= 1 {
                            if in_cell {
                                cell_text.push('\n');
                            }
                        } else {
                            para.push('\n');
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    blocks
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

    // ==================== AC-eb35e918: Block order preserved ====================
    #[test]
    fn ac_eb35e918_parses_blocks_in_document_order() {
        // Test that parse_blocks collects top-level <w:tbl> and <w:p> in order.
        // This is an internal function test; we verify via parse_structure that
        // the order is preserved through the entry extraction.
        let xml = r#"<w:document xmlns:w="x"><w:body>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>제목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>First Title</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
          <w:p><w:r><w:t>Para 1</w:t></w:r></w:p>
          <w:p><w:r><w:t>Para 2</w:t></w:r></w:p>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>기록자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>홍길동</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>확인자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>홍길동</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>기록 일자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026.01.02</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>확인 일자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026.01.30</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>"#;

        let result = parse_structure_from_document_xml(xml);
        assert!(result.is_ok(), "Should parse valid structure");

        let doc = result.unwrap();
        assert_eq!(doc.entries.len(), 1, "Should have exactly 1 entry");

        let entry = &doc.entries[0];
        // Body paragraphs should be in document order: Para 1, then Para 2.
        assert_eq!(entry.body_paragraphs.len(), 2, "Should have 2 body paragraphs in order");
        assert_eq!(entry.body_paragraphs[0], "Para 1", "First body paragraph in document order");
        assert_eq!(entry.body_paragraphs[1], "Para 2", "Second body paragraph in document order");
    }

    // ==================== AC-a4d6b41b: Record fields extracted ====================
    #[test]
    fn ac_a4d6b41b_parses_full_entry_record_with_all_fields() {
        let xml = r#"<w:document xmlns:w="x"><w:body>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>제목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>연구 항목 1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
          <w:p><w:r><w:t>본문 내용</w:t></w:r></w:p>
          <w:tbl>
            <w:tr><w:tc><w:p><w:r><w:t>기록자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>홍길동, 박정근</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>확인자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>홍길동</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>기록 일자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026.01.02</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>확인 일자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026.01.30</w:t></w:r></w:p></w:tc></w:tr>
          </w:tbl>
        </w:body></w:document>"#;

        let result = parse_structure_from_document_xml(xml);
        assert!(result.is_ok(), "Should parse valid entry");

        let doc = result.unwrap();
        assert_eq!(doc.entries.len(), 1, "Should extract exactly 1 entry");

        let entry = &doc.entries[0];
        assert_eq!(entry.title, "연구 항목 1", "Title should be extracted from title table");

        // recorders must be a Vec of comma-split names
        assert_eq!(entry.recorders.len(), 2, "Should split comma-separated recorders");
        assert_eq!(entry.recorders[0], "홍길동", "First recorder name");
        assert_eq!(entry.recorders[1], "박정근", "Second recorder name");

        assert_eq!(entry.confirmer, "홍길동", "Confirmer should be extracted");
        assert_eq!(entry.record_date, "2026.01.02", "Record date should be extracted");
        assert_eq!(entry.confirm_date, "2026.01.30", "Confirm date should be extracted");
        // 그림 없는 항목은 images가 빈 Vec(회귀 없음).
        assert!(entry.images.is_empty(), "No drawings → empty images");
    }

    // ==================== Phase B-1: docx 본문 인라인 이미지 추출 (F-5dc6297e) ====================
    #[test]
    fn parse_rels_image_map_extracts_only_image_relationships() {
        let rels = r#"<Relationships>
            <Relationship Id="rId1" Type="http://x/styles" Target="styles.xml"/>
            <Relationship Id="rId8" Type="http://x/image" Target="media/pic.png"/>
        </Relationships>"#;
        let m = parse_rels_image_map(rels);
        assert_eq!(m.get("rId8").map(|s| s.as_str()), Some("media/pic.png"));
        assert!(m.get("rId1").is_none(), "non-image relationship excluded");
    }

    #[test]
    fn captures_body_inline_image_position_and_size() {
        // 제목표 → 본문 단락 → 그림(drawing) 단락 → 메타표. extent 952500x476250 EMU = 100x50 px.
        let xml = r#"<w:document xmlns:w="x"><w:body>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>제목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>이미지 항목</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
          <w:p><w:r><w:t>본문 줄</w:t></w:r></w:p>
          <w:p><w:r><w:drawing><wp:extent cx="952500" cy="476250"/><a:blip r:embed="rId8"/></w:drawing></w:r></w:p>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>기록 일자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026.01.02</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>"#;
        let doc = parse_structure_from_document_xml(xml).expect("parse");
        let entry = &doc.entries[0];
        assert_eq!(entry.body_paragraphs, vec!["본문 줄".to_string()]);
        assert_eq!(entry.images.len(), 1, "one inline image captured");
        let img = &entry.images[0];
        assert_eq!(img.after_body_index, 1, "image follows the first body paragraph");
        assert_eq!(img.width_px, 100, "952500 EMU / 9525 = 100 px");
        assert_eq!(img.height_px, 50, "476250 EMU / 9525 = 50 px");
        assert_eq!(img.rid, "rId8", "rId carried for byte resolution");
        // 순수 구조 파서는 바이트를 채우지 않는다(zip+rels는 parse_docx_structure가).
        assert!(img.data_base64.is_empty());
    }

    // ==================== AC-ee8674e3: Bullet hierarchy preserved ====================
    #[test]
    fn ac_ee8674e3_preserves_hierarchical_bullets_without_flattening() {
        let xml = r#"<w:document xmlns:w="x"><w:body>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>제목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>계층 항목</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
          <w:p><w:r><w:t>Ÿ 항목</w:t></w:r></w:p>
          <w:p><w:r><w:t>1. 가</w:t></w:r></w:p>
          <w:p><w:r><w:t>– 나</w:t></w:r></w:p>
          <w:p><w:r><w:t>□ ① 다</w:t></w:r></w:p>
          <w:tbl>
            <w:tr><w:tc><w:p><w:r><w:t>기록자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>기자</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>확인자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>확인</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>기록 일자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026.01.01</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>확인 일자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026.01.01</w:t></w:r></w:p></w:tc></w:tr>
          </w:tbl>
        </w:body></w:document>"#;

        let result = parse_structure_from_document_xml(xml);
        assert!(result.is_ok(), "Should parse bullets");

        let doc = result.unwrap();
        let entry = &doc.entries[0];

        // Verify that body_paragraphs preserves each bullet marker verbatim in order.
        assert_eq!(entry.body_paragraphs.len(), 4, "Should have 4 bullet paragraphs");
        assert_eq!(entry.body_paragraphs[0], "Ÿ 항목", "First bullet preserved verbatim");
        assert_eq!(entry.body_paragraphs[1], "1. 가", "Numbered bullet preserved");
        assert_eq!(entry.body_paragraphs[2], "– 나", "Dash bullet preserved");
        assert_eq!(entry.body_paragraphs[3], "□ ① 다", "Complex marker preserved");

        // Verify that bullets are NOT merged into a single entry: each is a separate list item.
        // The key insight is that body_paragraphs must have 4 items (not 1).
        assert!(
            entry.body_paragraphs.len() > 1,
            "Bullets should be preserved as separate paragraphs, not flattened into one"
        );
    }

    // ==================== AC-80febe36: TOC extraction ====================
    #[test]
    fn ac_80febe36_extracts_toc_from_table_with_header_and_data_rows() {
        let xml = r#"<w:document xmlns:w="x"><w:body>
          <w:tbl>
            <w:tr><w:tc><w:p><w:r><w:t>일련번호</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>제목(내용)</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>날짜</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>첫 번째 항목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026.01.05</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>두 번째 항목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026.01.15</w:t></w:r></w:p></w:tc></w:tr>
          </w:tbl>
          <w:tbl><w:tr><w:tc><w:p><w:r><w:t>제목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>엔트리</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
          <w:p><w:r><w:t>본문</w:t></w:r></w:p>
          <w:tbl>
            <w:tr><w:tc><w:p><w:r><w:t>기록자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>기자</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>확인자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>확인</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>기록 일자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026.01.01</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>확인 일자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026.01.01</w:t></w:r></w:p></w:tc></w:tr>
          </w:tbl>
        </w:body></w:document>"#;

        let result = parse_structure_from_document_xml(xml);
        assert!(result.is_ok(), "Should parse document with TOC");

        let doc = result.unwrap();

        // Should have extracted the TOC table
        assert_eq!(doc.toc.len(), 2, "Should extract 2 TOC data rows (header skipped)");

        assert_eq!(doc.toc[0].no, "1", "First TOC item no");
        assert_eq!(doc.toc[0].title, "첫 번째 항목", "First TOC item title");
        assert_eq!(doc.toc[0].date, "2026.01.05", "First TOC item date");

        assert_eq!(doc.toc[1].no, "2", "Second TOC item no");
        assert_eq!(doc.toc[1].title, "두 번째 항목", "Second TOC item title");
        assert_eq!(doc.toc[1].date, "2026.01.15", "Second TOC item date");

        // Verify entry was also extracted
        assert_eq!(doc.entries.len(), 1, "Should still extract 1 entry");
    }

    // ==================== AC-d654e905: Error on unwanted structure ====================
    #[test]
    fn ac_d654e905_returns_error_when_no_entry_found() {
        // Document with no title table (no entry).
        let xml = r#"<w:document xmlns:w="x"><w:body>
          <w:p><w:r><w:t>Just some paragraphs</w:t></w:r></w:p>
          <w:p><w:r><w:t>No title table, no entry</w:t></w:r></w:p>
        </w:body></w:document>"#;

        let result = parse_structure_from_document_xml(xml);
        assert!(result.is_err(), "Should return Err when no entry structure found");
    }

    #[test]
    fn ac_d654e905_returns_error_for_completely_empty_document() {
        // Document with no tables and no paragraphs at all.
        let xml = r#"<w:document xmlns:w="x"><w:body></w:body></w:document>"#;

        let result = parse_structure_from_document_xml(xml);
        assert!(result.is_err(), "Should return Err for completely empty document");

        let err_msg = result.unwrap_err();
        assert!(err_msg.contains("항목을 찾지 못했습니다"), "Error message should explain missing entries");
    }

    #[test]
    fn ac_d654e905_returns_error_for_tables_without_title_marker() {
        // Document with regular tables but no '제목' table (not matching expected structure).
        let xml = r#"<w:document xmlns:w="x"><w:body>
          <w:tbl>
            <w:tr><w:tc><w:p><w:r><w:t>이것은</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>제목이 아님</w:t></w:r></w:p></w:tc></w:tr>
          </w:tbl>
          <w:p><w:r><w:t>Just a paragraph</w:t></w:r></w:p>
        </w:body></w:document>"#;

        let result = parse_structure_from_document_xml(xml);
        assert!(result.is_err(), "Should return Err when no title table found");
    }
}

#[cfg(test)]
mod cover_tests {
    use super::*;

    /// 항목 하나(제목 표 + 메타 표)를 가진 최소 본문 — parse가 Err를 내지 않게 하는 공통 꼬리.
    const MINIMAL_ENTRY: &str = r#"
      <w:tbl><w:tr><w:tc><w:p><w:r><w:t>제목</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>항목1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
      <w:p><w:r><w:t>본문</w:t></w:r></w:p>
      <w:tbl>
        <w:tr><w:tc><w:p><w:r><w:t>기록자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>홍길동</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:p><w:r><w:t>기록 일자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2026.01.02</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>"#;

    #[test]
    fn parses_cover_with_spaced_labels_and_numbered_recorders() {
        // 표지: 관리번호 문단 + 라벨 2열 표(자간 공백 라벨). 기록자는 번호 매김 다행 값.
        let xml = format!(
            r#"<w:document xmlns:w="x"><w:body>
              <w:p><w:r><w:t>관리번호 : RS-2026-00000000-002</w:t></w:r></w:p>
              <w:tbl>
                <w:tr><w:tc><w:p><w:r><w:t>기 관 명</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>㈜가나다연구소</w:t></w:r></w:p></w:tc></w:tr>
                <w:tr><w:tc><w:p><w:r><w:t>부 서 명</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>연구소</w:t></w:r></w:p></w:tc></w:tr>
                <w:tr><w:tc><w:p><w:r><w:t>연구과제명</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>VAPT 상용화 개발</w:t></w:r></w:p></w:tc></w:tr>
                <w:tr><w:tc><w:p><w:r><w:t>연구 기간</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2025.11.01 ~ 2028.10.31</w:t></w:r></w:p></w:tc></w:tr>
                <w:tr><w:tc><w:p><w:r><w:t>연구책임자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>홍길동</w:t></w:r></w:p></w:tc></w:tr>
                <w:tr><w:tc><w:p><w:r><w:t>기 록 자</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1. 홍길동  2. 임꺽정</w:t></w:r></w:p><w:p><w:r><w:t>3. 홍준호</w:t></w:r></w:p></w:tc></w:tr>
              </w:tbl>
              {MINIMAL_ENTRY}
            </w:body></w:document>"#,
        );
        let doc = parse_structure_from_document_xml(&xml).expect("파싱 성공해야 함");
        let cover = doc.cover.expect("표지가 추출돼야 함");
        assert_eq!(cover.manage_no, "관리번호 : RS-2026-00000000-002");
        assert_eq!(cover.org, "㈜가나다연구소");
        assert_eq!(cover.dept, "연구소");
        assert_eq!(cover.project, "VAPT 상용화 개발");
        assert_eq!(cover.period, "2025.11.01 ~ 2028.10.31");
        assert_eq!(cover.lead, "홍길동");
        assert_eq!(cover.recorders, vec!["홍길동", "임꺽정", "홍준호"]);
    }

    #[test]
    fn cover_is_none_when_no_cover_table() {
        // 표지 표(기관명+연구과제명)가 없으면 cover=None — 항목/목차 변환은 그대로.
        let xml = format!(
            r#"<w:document xmlns:w="x"><w:body>{MINIMAL_ENTRY}</w:body></w:document>"#
        );
        let doc = parse_structure_from_document_xml(&xml).expect("파싱 성공해야 함");
        assert!(doc.cover.is_none());
        assert_eq!(doc.entries.len(), 1);
    }

    #[test]
    fn split_numbered_names_handles_multiline_and_comma_fallback() {
        assert_eq!(
            split_numbered_names("1. 홍길동        2. 임꺽정\n13. 권현수   14. 정요한"),
            vec!["홍길동", "임꺽정", "권현수", "정요한"]
        );
        // 번호 없음 → 쉼표 폴백.
        assert_eq!(split_numbered_names("홍길동, 박정근"), vec!["홍길동", "박정근"]);
    }
}
