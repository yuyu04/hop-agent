//! LLM이 반환하는 Action Script의 데이터 모델과 파싱·검증.
//!
//! (스펙 3장) LLM은 자연어 설명 없이 아래 스키마를 만족하는 Raw JSON만 반환한다.
//! Rust 측은 serde로 역직렬화하고, 모든 `target_id`가 직렬화 시점의 화이트리스트에
//! 속하는지 검증한다(스펙 2·7장).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

/// Action Script가 지정하는 편집 명령.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EditCommand {
    InsertBefore,
    InsertAfter,
    Replace,
    Delete,
}

/// 표 편집용 payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableData {
    /// 생략하면 matrix에서 유도한다(`normalize`).
    #[serde(default)]
    pub rows: u32,
    #[serde(default)]
    pub cols: u32,
    #[serde(default)]
    pub matrix: Vec<Vec<String>>,
    /// 병합할 셀 영역들(선택). 헤더 병합·세로 병합 등에 쓴다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub merges: Vec<MergeSpec>,
    /// 열별 상대 폭 가중치(선택, 길이=cols). 긴 텍스트 열은 크게, ○/× 같은 짧은
    /// 열은 작게 지정하면 표가 세로로 덜 늘어나 여러 쪽으로 쪼개지는 것을 줄인다.
    /// 예: [3,3,2,2,8] → 마지막(비고) 열이 가장 넓다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub col_weights: Vec<u32>,
}

/// 기존 표의 구조 편집 스펙(행/열 추가·삭제, 셀 병합). target_id는 그 표의 셀 ID.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableEditSpec {
    /// "insert_row" | "insert_col" | "delete_row" | "delete_col" | "merge_cells" | "split_cell"
    pub op: String,
    /// 기준 행(0-기준). insert_row/delete_row에서 사용.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row: Option<u32>,
    /// 기준 열(0-기준). insert_col/delete_col에서 사용.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub col: Option<u32>,
    /// insert_row: 기준 행 아래에 넣을지(기본 true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub below: Option<bool>,
    /// insert_col: 기준 열 오른쪽에 넣을지(기본 true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<bool>,
    /// merge_cells: 병합 범위(0-기준, 끝 포함).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub merge: Option<MergeSpec>,
    /// split_cell: 셀을 몇 줄로 나눌지(생략 시 1). F-6daa56b3.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub into_rows: Option<u32>,
    /// split_cell: 셀을 몇 칸으로 나눌지(생략 시 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub into_cols: Option<u32>,
    /// split_cell: 나뉜 줄 높이를 균등하게(생략 시 true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub equal_row_height: Option<bool>,
    /// split_cell: 주면 이 범위 안의 셀들을 각각 into_rows×into_cols로 분할한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<MergeSpec>,
    /// insert_row/insert_col: 새 행/열의 셀 텍스트(왼→오 / 위→아래 순, 선택).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub texts: Vec<String>,
}

/// 복제할 원본 양식 표의 식별자(섹션/부모문단/컨트롤 인덱스).
/// serialize가 화이트리스트·컨텍스트에 노출한 양식 표 좌표를 그대로 참조한다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloneSource {
    pub section: u32,
    pub paragraph: u32,
    pub control_index: u32,
}

/// 복제된 표의 한 입력칸 채우기 항목((row,col) → text). text는 `\n`을 포함할 수 있고
/// F-466f8e 다줄 셀 경로로 채워진다. 라벨칸은 채우지 않으면 원본 그대로 보존된다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CellFill {
    pub row: u32,
    pub col: u32,
    pub text: String,
}

/// type="clone_table"일 때: 기존 양식 표를 in-model 복제하고 입력칸만 채운다.
/// 새로 표를 그리지(compose) 않으므로 행·열·병합·테두리가 원본과 100% 동일하다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloneTableSpec {
    /// 복제할 원본 양식 표의 식별자.
    pub clone_from: CloneSource,
    /// 복제 후 채울 입력칸들(라벨칸은 생략 → 원본 보존).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cell_fills: Vec<CellFill>,
}

/// 차트 시리즈 하나(payload.type="chart").
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChartSeries {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// labels와 같은 길이의 숫자 값들.
    pub values: Vec<f64>,
}

impl Eq for ChartSeries {}

/// 데이터 → 차트 이미지 생성 스펙. 프런트가 캔버스로 PNG 렌더 후 그림으로 삽입한다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChartData {
    /// "bar" | "line" | "pie"
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// 가로축(범주) 라벨들.
    pub labels: Vec<String>,
    /// 시리즈 목록(pie는 1개만).
    pub series: Vec<ChartSeries>,
}

impl Eq for ChartData {}

/// 런 단위 부분 서식 스펙(payload.type="format"). 텍스트 내용은 바꾸지 않는다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CharFormatSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strikethrough: Option<bool>,
    /// 글자 크기(pt). 적용 시 HWPUNIT(pt×100)으로 변환된다. 10.5pt 같은 소수도 받는다
    /// (정수만 받으면 한 값 때문에 응답 전체가 파싱 실패했다).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size_pt: Option<f64>,
    /// 글자 색 "#RRGGBB".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<String>,
    /// 글꼴 이름(예 "맑은 고딕"). 문서에 없으면 앱이 등록한다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    /// 형광펜(음영) 색 "#RRGGBB".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub highlight_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superscript: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subscript: Option<bool>,
}

impl Eq for CharFormatSpec {}

/// 문단 서식·번호 목록 스펙(payload.type="para_format", 또는 텍스트 INSERT/REPLACE에 동봉).
///
/// 테마(payload.style)가 정한 기본 서식 위에 덮어쓴다 — 사용자가 "오른쪽 정렬", "1. 가. 번호
/// 매기기", "줄간격 160%"처럼 명시적으로 요구한 경우에만 채운다.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParaFormatSpec {
    /// "left" | "center" | "right" | "justify" | "distribute"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alignment: Option<String>,
    /// 줄 간격(%) — 예 160.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_spacing_percent: Option<f64>,
    /// 첫 줄 들여쓰기(pt). 음수면 내어쓰기.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indent_pt: Option<f64>,
    /// 왼쪽 여백(pt).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margin_left_pt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spacing_before_pt: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spacing_after_pt: Option<f64>,
    /// 다음 문단과 같은 쪽에 두기(제목이 쪽 끝에 홀로 남지 않게).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_with_next: Option<bool>,
    /// 번호·글머리표 목록.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<ListSpec>,
}

impl Eq for ParaFormatSpec {}

/// 문단 번호/글머리표(한글의 문단 번호·글머리표·개요 번호).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListSpec {
    /// "number"(1. 가. 1) …) | "bullet"(● ■ …) | "outline"(개요 번호) | "none"(해제)
    pub kind: String,
    /// 수준 0~6(0=1수준).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<u32>,
    /// bullet일 때 글머리표 문자(생략 시 ●).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bullet_char: Option<String>,
}

/// 쪽 설정(payload.type="page_setup", target_id="doc") — 모든 구역에 적용.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageSetupSpec {
    /// "portrait" | "landscape"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orientation: Option<String>,
    /// "A4" | "A3" | "B5" | "Letter"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper: Option<String>,
    /// 여백(mm). 지정한 변만 바뀐다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub margins_mm: Option<MarginsMm>,
}

impl Eq for PageSetupSpec {}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MarginsMm {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub top: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bottom: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub right: Option<f64>,
}

/// 쪽 번호(payload.type="page_number", target_id="doc") — 머리말/꼬리말에 자동 쪽 번호 필드.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageNumberSpec {
    /// "footer"(기본) | "header"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub position: Option<String>,
    /// "center"(기본) | "left" | "right"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
    /// "plain"(1) | "dash"(- 1 -) | "total"(1 / 10)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
}

/// 문서 전역 찾아 바꾸기 스펙(payload.type="replace_text", F-293e8c99).
///
/// 문단마다 REPLACE 편집을 나열하는 대신 rhwp의 전역 치환 프리미티브를 한 번 부른다 —
/// 100군데를 고칠 때 edit 100개 대신 1개면 된다(토큰·누락·승인 UI 문제 해소).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplaceTextSpec {
    /// 찾을 문자열(비어 있으면 적용하지 않고 사유를 보고한다).
    pub query: String,
    /// 바꿀 문자열(빈 문자열이면 삭제).
    pub new_text: String,
    /// 대소문자 구분(생략 시 false).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub case_sensitive: Option<bool>,
    /// "all"(기본, 전부) | "first"(첫 건만).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// 표 셀 계산식 스펙(payload.type="table_formula", F-8eb1f86f).
///
/// AI가 암산한 숫자를 글자로 넣는 대신 rhwp 표 계산 엔진이 값을 구해 셀에 기입한다.
/// 주의: row/col은 0-기준 정수(다른 표 편집과 동일)지만, formula 안의 셀 참조는 A1 표기다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableFormulaSpec {
    /// 결과를 쓸 셀의 행(0-기준).
    pub row: u32,
    /// 결과를 쓸 셀의 열(0-기준).
    pub col: u32,
    /// 계산식. 예: "=SUM(B2:B5)", "=A1+B2*3". 셀 참조는 A1 표기를 쓴다.
    pub formula: String,
}

/// 각주 달기/떼기 스펙(payload.type="footnote", F-3e2d0f9a).
///
/// 삽입: 본문 문단 ID + command=REPLACE (본문 내용은 그대로, 각주만 추가).
/// 삭제: 각주 ID + command=DELETE (각주 자체를 표식까지 제거).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FootnoteSpec {
    /// 삽입할 각주 내용. 삭제에는 필요 없다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 삽입 위치: 이 문자열 바로 뒤에 각주 표식을 단다(생략 시 문단 끝).
    /// 문단 안에서 유일해야 한다 — 여러 번 나오면 적용하지 않는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_text: Option<String>,
}

/// HTML 붙여넣기 스펙(payload.type="paste_html", F-4f6d826e).
///
/// 웹/워드에서 가져온 내용을 순수 텍스트로 풀어 쓰는 대신 서식(굵기·목록·표)을 유지한 채
/// 반입한다. rhwp가 HTML을 파싱해 문단·런으로 만든다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PasteHtmlSpec {
    /// 붙여넣을 HTML 조각. 비어 있으면 적용하지 않고 사유를 보고한다.
    pub html: String,
}

/// 이미지 크롭 영역(0~1 비율).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CropSpec {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Eq for CropSpec {}

/// 표 셀 병합 영역(0-기준 행/열 범위, 끝 포함).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeSpec {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

/// 편집 대상에 적용할 내용.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EditPayload {
    /// 객체 종류("paragraph" | "table"). DELETE 명령에서는 생략될 수 있다.
    #[serde(rename = "type", default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    /// type="image"일 때 삽입할 첨부 이미지의 0-기준 인덱스.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_index: Option<u32>,
    /// 이미지에서 잘라낼 영역(0~1 비율). PDF 페이지 렌더에서 그림만 잘라낼 때 쓴다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<CropSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_data: Option<TableData>,
    /// type="table_edit"일 때: 기존 표의 구조 편집(행/열 추가·삭제, 셀 병합).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_edit: Option<TableEditSpec>,
    /// type="clone_table"일 때: 기존 양식 표를 그대로 복제하고 입력칸만 채운다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clone_table: Option<CloneTableSpec>,
    /// type="chart"일 때: 차트 데이터(프런트가 PNG로 렌더해 그림으로 삽입).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart_data: Option<ChartData>,
    /// type="format"일 때: 문단 안에서 서식을 바꿀 정확한 문자열(생략=문단 전체).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format_target: Option<String>,
    /// type="format"일 때: 적용할 글자 서식(바꿀 속성만 지정).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub char_format: Option<CharFormatSpec>,
    /// type="replace_text"일 때: 문서 전역 찾아 바꾸기(target_id="doc").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace_text: Option<ReplaceTextSpec>,
    /// type="table_formula"일 때: 표 셀 계산식(엔진이 계산해 셀에 기입).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_formula: Option<TableFormulaSpec>,
    /// type="footnote"일 때: 각주 달기(본문 문단 target) / 떼기(각주 target).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub footnote: Option<FootnoteSpec>,
    /// type="paste_html"일 때: HTML을 서식 유지한 채 붙여넣는다.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paste_html: Option<PasteHtmlSpec>,
    /// type="para_format"이거나 텍스트 INSERT/REPLACE에 동봉: 문단 서식·번호 목록.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub para_format: Option<ParaFormatSpec>,
    /// type="page_setup"일 때(target_id="doc"): 용지 방향·크기·여백.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_setup: Option<PageSetupSpec>,
    /// type="page_number"일 때(target_id="doc"): 머리말/꼬리말 쪽 번호.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_number: Option<PageNumberSpec>,
    /// INSERT 시 참이면 새 페이지에서 시작(본문 문단에만 적용).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_break: Option<bool>,
    /// 다시쓰기 대안들(선택, 2~3개). 사용자가 여러 변형을 요청할 때 채운다.
    /// text에는 추천안(보통 variations[0])을 넣고, UI에서 다른 안을 고를 수 있다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub variations: Vec<String>,
    /// 교정 패스에서 이 편집이 고치는 이슈 설명(예: "맞춤법: '됬다'→'됐다'").
    /// 일반 편집에서는 생략된다. mod.rs가 파싱 결과를 재직렬화해 프런트로 보내므로
    /// 여기 없는 필드는 떨어져 나간다 — 그래서 스키마에 명시한다(col_weights와 동일 이유).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 단일 편집 항목.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edit {
    pub command: EditCommand,
    /// 문서 호스트가 직렬화 시 부여한 고유 ID (예: `sec[0].p[1]`).
    pub target_id: String,
    pub payload: EditPayload,
}

/// LLM이 반환하는 최상위 구조.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ActionScript {
    pub edits: Vec<Edit>,
    /// 사용자에게 보여줄 대화형 요약(무엇을 했는지/못 했으면 이유). 한국어 1~3문장.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// 요청 앞 '작성 지침 목록'에서 골라 따른 지침의 이름(없으면 빈 문자열/생략).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
}

/// LLM 응답 문자열을 `ActionScript`로 파싱한다.
///
/// provider가 네이티브 구조화 출력을 쓰면 순수 JSON이 오지만, 방어적으로
/// Markdown 코드펜스(```json ... ```)를 감싸 보낸 경우도 벗겨낸다.
pub fn parse_action_script(raw: &str) -> Result<ActionScript, String> {
    let cleaned = strip_code_fences(raw).trim();
    if cleaned.is_empty() {
        return Err(
            "빈 응답을 받았습니다 — 모델이 출력을 내지 않았습니다(다른 모델/Provider로 시도하세요)."
                .to_string(),
        );
    }
    // 1차: 정리된 전체를 그대로 파싱.
    if let Ok(script) = serde_json::from_str::<ActionScript>(cleaned) {
        return Ok(script);
    }
    // 2차: 설명 문장에 둘러싸인 경우 가장 바깥 `{...}`만 떼어 파싱(특히 CLI 응답).
    if let Some(braced) = extract_braced_object(cleaned) {
        if let Ok(script) = serde_json::from_str::<ActionScript>(braced) {
            return Ok(script);
        }
    }
    Err(format!(
        "Action Script JSON 파싱 실패. 받은 응답 일부: {}",
        preview(cleaned, 200)
    ))
}

/// 편집 단위로 관대하게 파싱한 결과.
#[derive(Debug, Clone, PartialEq)]
pub struct LenientScript {
    pub script: ActionScript,
    /// 형식이 맞지 않아 버린 편집 설명(사용자 안내용).
    pub dropped: Vec<String>,
}

/// LLM 응답을 편집 하나씩 파싱한다 — 한 편집의 형식 오류(예: 숫자 자리에 문자열)가
/// 응답 전체를 버리게 하지 않는다. 최상위 구조(`edits` 배열)가 없을 때만 실패한다.
pub fn parse_action_script_lenient(raw: &str) -> Result<LenientScript, String> {
    let strict_error = match parse_action_script(raw) {
        Ok(mut script) => {
            normalize_script(&mut script);
            return Ok(LenientScript {
                script,
                dropped: Vec::new(),
            });
        }
        Err(message) => message,
    };
    let cleaned = strip_code_fences(raw).trim();
    // 빈 응답은 관대 파싱으로 살릴 게 없다 — "다른 모델로 시도" 안내를 그대로 돌려준다.
    if cleaned.is_empty() {
        return Err(strict_error);
    }
    let value: Value = serde_json::from_str(cleaned)
        .ok()
        .or_else(|| extract_braced_object(cleaned).and_then(|b| serde_json::from_str(b).ok()))
        .ok_or_else(|| {
            format!(
                "Action Script JSON 파싱 실패. 받은 응답 일부: {}",
                preview(cleaned, 200)
            )
        })?;
    let edits_value = value
        .get("edits")
        .and_then(Value::as_array)
        .ok_or_else(|| "Action Script에 edits 배열이 없습니다.".to_string())?;
    let mut edits = Vec::new();
    let mut dropped = Vec::new();
    for (index, item) in edits_value.iter().enumerate() {
        match serde_json::from_value::<Edit>(item.clone()) {
            Ok(edit) => edits.push(edit),
            Err(error) => dropped.push(format!("편집 {}번 형식 오류({})", index + 1, error)),
        }
    }
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string);
    let skill = value.get("skill").and_then(Value::as_str).map(str::to_string);
    let mut script = ActionScript { edits, message, skill };
    normalize_script(&mut script);
    Ok(LenientScript { script, dropped })
}

/// 생략된 표 차원을 matrix에서 채운다(rows=행 수, cols=가장 긴 행의 칸 수).
fn normalize_script(script: &mut ActionScript) {
    for edit in &mut script.edits {
        if let Some(table) = edit.payload.table_data.as_mut() {
            if table.rows == 0 {
                table.rows = table.matrix.len() as u32;
            }
            if table.cols == 0 {
                table.cols = table.matrix.iter().map(Vec::len).max().unwrap_or(0) as u32;
            }
        }
    }
}

/// 화이트리스트에 없는 대상을 겨눈 편집을 떼어 낸다. 반환: 떼어 낸 대상 ID들.
pub fn drop_violations(script: &mut ActionScript, whitelist: &HashSet<String>) -> Vec<String> {
    let mut removed = Vec::new();
    script.edits.retain(|edit| {
        let allowed = is_allowed_target(edit, whitelist);
        if !allowed {
            removed.push(edit.target_id.clone());
        }
        allowed
    });
    removed
}

/// 출력 한도·시간 초과로 중간에 끊긴 응답에서 '끝까지 닫힌' 편집만 건져, 유효한 Action
/// Script JSON으로 다시 만든다. 완결된 편집이 하나도 없으면 None.
///
/// 최상위 객체의 `edits` 배열을 문자열·괄호 깊이를 따라 훑어, 닫는 `}`까지 온 원소만
/// 모은다(쓰다 만 마지막 원소는 버린다). `message`가 완결돼 있으면 살리고, 잘렸다는
/// 안내를 덧붙여 사용자가 '이어서 써줘'로 계속할 수 있게 한다.
pub fn salvage_truncated_script(partial: &str) -> Option<String> {
    let text = strip_code_fences(partial);
    let start = text.find('{')?;
    let bytes = text.as_bytes();

    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    // 최상위(깊이 1) 문자열 — 키 후보와 그 값.
    let mut string_start = 0usize;
    let mut last_key: Option<String> = None;
    let mut after_colon = false;
    let mut message: Option<String> = None;
    let mut skill: Option<String> = None;
    // edits 배열 안(깊이 2)의 원소 시작 위치.
    let mut in_edits = false;
    let mut element_start: Option<usize> = None;
    let mut elements: Vec<&str> = Vec::new();

    let mut i = start;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if c == b'\\' {
                escaped = true;
            } else if c == b'"' {
                in_string = false;
                if depth == 1 {
                    let raw = &text[string_start..=i];
                    if after_colon {
                        if last_key.as_deref() == Some("message") {
                            message = serde_json::from_str::<String>(raw).ok();
                        } else if last_key.as_deref() == Some("skill") {
                            skill = serde_json::from_str::<String>(raw).ok();
                        }
                        after_colon = false;
                    } else {
                        last_key = serde_json::from_str::<String>(raw).ok();
                    }
                }
            }
            i += 1;
            continue;
        }
        match c {
            b'"' => {
                in_string = true;
                string_start = i;
            }
            b':' if depth == 1 => after_colon = true,
            b',' if depth == 1 => after_colon = false,
            b'{' | b'[' => {
                if depth == 1 && c == b'[' && after_colon && last_key.as_deref() == Some("edits") {
                    in_edits = true;
                } else if depth == 2 && in_edits && c == b'{' {
                    element_start = Some(i);
                }
                depth += 1;
            }
            b'}' | b']' => {
                depth = depth.saturating_sub(1);
                if depth == 2 && in_edits && c == b'}' {
                    if let Some(s0) = element_start.take() {
                        elements.push(&text[s0..=i]);
                    }
                } else if depth == 1 && in_edits && c == b']' {
                    in_edits = false;
                    after_colon = false;
                }
                if depth == 0 {
                    break;
                }
            }
            _ => {}
        }
        i += 1;
    }

    let edits: Vec<Value> = elements
        .iter()
        .filter_map(|raw| serde_json::from_str::<Value>(raw).ok())
        .filter(Value::is_object)
        .collect();
    if edits.is_empty() {
        return None;
    }
    let note = format!(
        "(응답이 출력 한도에서 끊겨 앞의 {}건까지만 받았습니다 — '이어서 써줘'라고 하면 나머지를 이어서 씁니다.)",
        edits.len()
    );
    let message = match message {
        Some(m) if !m.trim().is_empty() => format!("{} {}", m.trim(), note),
        _ => note,
    };
    let mut out = serde_json::json!({ "message": message, "edits": edits });
    if let Some(skill) = skill {
        out["skill"] = Value::String(skill);
    }
    Some(out.to_string())
}

/// 텍스트에서 첫 `{`부터 마지막 `}`까지(가장 바깥 객체 후보)를 잘라낸다.
fn extract_braced_object(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end > start {
        Some(&text[start..=end])
    } else {
        None
    }
}

/// 진단 메시지용 — 앞 `max_chars`자만, 길면 말줄임표.
fn preview(text: &str, max_chars: usize) -> String {
    let collected: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        format!("{}…", collected)
    } else {
        collected
    }
}

// ── 양식 이어쓰기(form_fill) 응답 스키마 (F-ae778890) ──────────────────────
//
// 핵심 원칙: 이 모드에서 AI는 표 구조를 절대 결정하지 않는다. 응답은 '항목 내용
// 리스트'뿐이며, 각 항목은 라벨→값 쌍의 집합이다. 표/compose/edit 액션을 일절
// 포함하지 않는다(AC-0cd01fc1). 앱이 항목마다 소스 양식 표를 결정적으로 복제하고
// (cloneTableAt) 라벨↔인접 값칸 매핑으로 값칸만 채운다(AC-6bdb1e17/AC-86e329eb).

/// 한 항목의 라벨→값 쌍 하나(예: {label:"제목", value:"실험 A 재현"}).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormFillField {
    /// 소스 양식 표의 라벨 셀 이름(예: 제목/연구내용/기록자/확인자/기록 일자).
    pub label: String,
    /// 그 라벨에 대응하는 값칸에 채울 내용(여러 줄이면 `\n` 포함 가능).
    pub value: String,
}

/// 새로 추가할 항목 하나 — 라벨→값 쌍 + (선택) 본문. 표 구조 정보는 일절 없다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormFillEntry {
    pub fields: Vec<FormFillField>,
    /// 라벨 없는 '본문 통칸'에 넣을 단락들(F-86317c64). 연구노트처럼 제목·날짜 칸 외에
    /// 내용 본문이 있는 양식에서 쓴다. **여기 없으면 canonical 재직렬화에서 버려져
    /// 프론트가 본문을 영영 못 받는다** — 스키마에만 추가하면 안 된다.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub body: Vec<String>,
}

/// 양식 이어쓰기 응답(내용 전용). entries.len() = 추가할 항목 수 N. 표/compose 없음.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FormFillResponse {
    pub entries: Vec<FormFillEntry>,
    /// 사용자에게 보여줄 요약(선택, 한국어 1~3문장).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 양식 이어쓰기 응답 문자열을 `FormFillResponse`로 파싱한다. action_script와 동일하게
/// 코드펜스/설명 문장 래핑을 방어적으로 벗겨낸다.
pub fn parse_form_fill_response(raw: &str) -> Result<FormFillResponse, String> {
    let cleaned = strip_code_fences(raw).trim();
    if cleaned.is_empty() {
        return Err("빈 응답을 받았습니다 — 모델이 항목 내용을 내지 않았습니다.".to_string());
    }
    if let Ok(resp) = serde_json::from_str::<FormFillResponse>(cleaned) {
        return Ok(resp);
    }
    if let Some(braced) = extract_braced_object(cleaned) {
        if let Ok(resp) = serde_json::from_str::<FormFillResponse>(braced) {
            return Ok(resp);
        }
    }
    Err(format!(
        "양식 이어쓰기 응답 JSON 파싱 실패. 받은 응답 일부: {}",
        preview(cleaned, 200)
    ))
}

/// 긴 문서 분할 작성(F-866a1c71)의 개요 — 제목과 절 목록만(본문 없음).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocOutline {
    pub title: String,
    /// 요청 앞 '작성 지침 목록'에서 고른 지침 이름(없으면 생략).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub sections: Vec<OutlineSection>,
}

/// 개요의 절 하나.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutlineSection {
    /// 번호를 포함한 절 제목(예: "1. 사업 개요").
    pub heading: String,
    /// 그 절에 쓸 핵심 내용(1~2문장).
    #[serde(default)]
    pub brief: String,
    /// 그 절 본문의 목표 글자 수.
    #[serde(default = "default_section_chars")]
    pub target_chars: u32,
    /// 표가 꼭 필요한 절인가.
    #[serde(default)]
    pub table: bool,
}

fn default_section_chars() -> u32 {
    1_300
}

/// 개요 절 수 상한 — 더 많으면 절 하나가 너무 얇거나 요청이 과하다.
const MAX_OUTLINE_SECTIONS: usize = 20;
/// 절 하나의 목표 글자 수 범위(한 번의 응답으로 안전하게 쓸 수 있는 분량).
const SECTION_CHARS_RANGE: (u32, u32) = (200, 6_000);

/// 개요 응답을 파싱·검증한다. 절이 0개이거나 상한을 넘으면 오류, 목표 글자 수는 범위로 맞춘다.
pub fn parse_outline_response(raw: &str) -> Result<DocOutline, String> {
    let cleaned = strip_code_fences(raw).trim();
    let mut outline: DocOutline = serde_json::from_str(cleaned)
        .or_else(|_| {
            extract_braced_object(cleaned)
                .ok_or_else(|| "개요 JSON을 찾지 못했습니다.".to_string())
                .and_then(|b| serde_json::from_str(b).map_err(|e| e.to_string()))
        })
        .map_err(|e| format!("개요 파싱 실패: {} (받은 응답 일부: {})", e, preview(cleaned, 160)))?;
    outline.title = outline.title.trim().to_string();
    outline.sections.retain(|s| !s.heading.trim().is_empty());
    if outline.sections.is_empty() {
        return Err("개요에 절이 없습니다.".to_string());
    }
    if outline.sections.len() > MAX_OUTLINE_SECTIONS {
        return Err(format!(
            "개요의 절이 너무 많습니다({}개 — 최대 {}개).",
            outline.sections.len(),
            MAX_OUTLINE_SECTIONS
        ));
    }
    for section in &mut outline.sections {
        section.heading = section.heading.trim().to_string();
        section.target_chars = section
            .target_chars
            .clamp(SECTION_CHARS_RANGE.0, SECTION_CHARS_RANGE.1);
    }
    Ok(outline)
}

/// 개요 요청의 출력 JSON Schema(F-866a1c71).
pub fn outline_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "title": { "type": "string", "description": "문서 제목." },
            "skill": {
                "type": "string",
                "description": "요청 앞 '작성 지침 목록'에서 골라 따른 지침의 이름(### 제목 그대로). 없으면 빈 문자열."
            },
            "message": { "type": "string", "description": "개요를 한 문장으로 요약." },
            "sections": {
                "type": "array",
                "description": "절(장) 목록, 문서 순서대로 4~12개.",
                "items": {
                    "type": "object",
                    "properties": {
                        "heading": { "type": "string", "description": "번호를 포함한 절 제목(예: 1. 사업 개요)." },
                        "brief": { "type": "string", "description": "그 절에 쓸 핵심 내용 1~2문장." },
                        "target_chars": { "type": "integer", "description": "그 절 본문의 목표 글자 수(200~6000)." },
                        "table": { "type": "boolean", "description": "그 절에 표(일정·예산·지표 등)가 꼭 필요한가." }
                    },
                    "required": ["heading", "brief", "target_chars", "table"]
                }
            }
        },
        "required": ["title", "sections"]
    })
}

/// provider에 주입할 양식 이어쓰기 출력 JSON Schema(F-ae778890). 표/compose 구조를
/// 일절 노출하지 않으므로 AI가 표를 그릴 여지가 없다(AC-0cd01fc1).
pub fn form_fill_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "사용자에게 보여줄 요약(무엇을 추가했는지). 한국어 1~3문장."
            },
            "entries": {
                "type": "array",
                "description": "추가할 항목들. 배열 길이가 곧 추가할 항목(표) 수다. 각 항목은 라벨→값 쌍의 집합이며, 표 구조는 절대 포함하지 않는다(앱이 기존 양식 표를 그대로 복제한다).",
                "items": {
                    "type": "object",
                    "properties": {
                        "fields": {
                            "type": "array",
                            "description": "그 항목의 라벨→값 쌍. label은 소스 양식의 필드 라벨(제목/연구내용/기록자 등), value는 그 칸에 넣을 내용(여러 줄이면 \\n).",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "label": { "type": "string" },
                                    "value": { "type": "string" }
                                },
                                "required": ["label", "value"]
                            }
                        },
                        "body": {
                            "type": "array",
                            "description": "라벨 없는 '본문 통칸'에 들어갈 단락들. 연구노트처럼 제목·날짜 칸 외에 내용 본문이 있는 양식에서 채운다. 배열 원소 1개 = 문단 1개.",
                            "items": { "type": "string" }
                        }
                    },
                    "required": ["fields"]
                }
            }
        },
        "required": ["entries"]
    })
}

/// 화이트리스트에 없는 `target_id`(환각으로 간주) 목록을 반환한다. 빈 벡터면 통과.
#[cfg(test)]
pub fn collect_violations(script: &ActionScript, whitelist: &HashSet<String>) -> Vec<String> {
    script
        .edits
        .iter()
        .filter(|edit| !is_allowed_target(edit, whitelist))
        .map(|edit| edit.target_id.clone())
        .collect()
}

/// 문서 전체를 가리키는 target_id 토큰(전역 찾아 바꾸기 전용, F-293e8c99).
///
/// 구간 스코프 요청(serialize::build_scoped_context)에서는 화이트리스트에 넣지 않는다 —
/// 구간 밖까지 바꾸는 전역 치환은 스코프 위반이기 때문이다.
pub const DOC_SCOPE_TARGET: &str = "doc";

/// 이 편집의 target_id가 허용되는가. 문단/셀 ID는 화이트리스트 membership으로 판정하고,
/// 문서 스코프 토큰은 "화이트리스트에 있고 + 실제로 전역 치환 payload일 때"만 허용한다
/// (다른 payload가 "doc"을 target으로 잡는 환각을 막는다).
fn is_allowed_target(edit: &Edit, whitelist: &HashSet<String>) -> bool {
    if edit.target_id == DOC_SCOPE_TARGET {
        // 프론트 판정과 같게: 쪽 번호는 필드가 모두 선택이라 type만으로도 유효하다.
        let doc_scoped = edit.payload.replace_text.is_some()
            || edit.payload.page_setup.is_some()
            || edit.payload.page_number.is_some()
            || edit.payload.kind.as_deref() == Some("page_number");
        return whitelist.contains(DOC_SCOPE_TARGET) && doc_scoped;
    }
    whitelist.contains(&edit.target_id)
}

/// provider에 주입할 출력 JSON Schema(스펙 3장)를 생성한다.
pub fn action_script_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "message": {
                "type": "string",
                "description": "사용자에게 보여줄 대화형 요약(무엇을 했는지, 못 했으면 이유). 한국어 1~3문장."
            },
            "skill": {
                "type": "string",
                "description": "요청 앞 '작성 지침 목록'에서 골라 따른 지침의 이름(목록의 ### 제목 그대로). 목록이 없거나 따른 지침이 없으면 빈 문자열."
            },
            "edits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "enum": ["INSERT_BEFORE", "INSERT_AFTER", "REPLACE", "DELETE"]
                        },
                        "target_id": { "type": "string" },
                        "payload": {
                            "type": "object",
                            "properties": {
                                "type": { "type": "string", "enum": ["paragraph", "table", "image", "table_edit", "clone_table", "format", "chart", "replace_text", "table_formula", "footnote", "paste_html", "para_format", "page_setup", "page_number"] },
                                "text": { "type": "string" },
                                "style": {
                                    "type": "string",
                                    "enum": ["title", "heading", "subheading", "body", "caption", "quote", "emphasis"],
                                    "description": "문단의 의미 역할. 제목=title, 큰 제목=heading, 소제목=subheading, 본문=body, 그림/표 설명=caption, 인용=quote, 강조 한 줄=emphasis. 실제 글꼴 크기·정렬·간격은 앱이 일관되게 적용한다."
                                },
                                "image_index": {
                                    "type": "integer",
                                    "description": "type=\"image\"일 때 삽입할 첨부 이미지의 0-기준 인덱스(첨부된 순서)."
                                },
                                "crop": {
                                    "type": "object",
                                    "description": "이미지에서 잘라낼 영역(0~1 비율, 좌상단 기준). PDF 페이지 렌더에서 원하는 그림만 잘라낼 때 지정. 그림 전체면 생략.",
                                    "properties": {
                                        "x": { "type": "number" },
                                        "y": { "type": "number" },
                                        "w": { "type": "number" },
                                        "h": { "type": "number" }
                                    }
                                },
                                "page_break": {
                                    "type": "boolean",
                                    "description": "참이면 삽입한 문단을 새 페이지에서 시작한다(INSERT에만 유효)."
                                },
                                "variations": {
                                    "type": "array",
                                    "description": "다시쓰기 대안 2~3개(선택). 사용자가 여러 안을 원할 때만 채운다. text에는 추천안(보통 첫 번째)을 넣는다.",
                                    "items": { "type": "string" }
                                },
                                "reason": {
                                    "type": "string",
                                    "description": "교정 패스에서만: 이 편집이 고치는 이슈를 '분류: 설명' 형식 한국어 한 문장으로(분류는 맞춤법/문법/어색한 표현/일관성 중 하나). 일반 편집에서는 생략."
                                },
                                "chart_data": {
                                    "type": "object",
                                    "description": "type=\"chart\"일 때: 데이터로 차트 이미지를 만들어 본문에 삽입한다. command=INSERT_AFTER, target은 표 바깥 본문 문단 ID. 값은 반드시 숫자(단위·콤마 제거).",
                                    "properties": {
                                        "kind": { "type": "string", "enum": ["bar", "line", "pie"] },
                                        "title": { "type": "string" },
                                        "labels": { "type": "array", "items": { "type": "string" }, "description": "범주 라벨(가로축). pie면 조각 이름." },
                                        "series": {
                                            "type": "array",
                                            "description": "시리즈 목록(pie는 1개만). 각 values 길이는 labels와 같아야 한다.",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "name": { "type": "string" },
                                                    "values": { "type": "array", "items": { "type": "number" } }
                                                },
                                                "required": ["values"]
                                            }
                                        }
                                    },
                                    "required": ["kind", "labels", "series"]
                                },
                                "format_target": {
                                    "type": "string",
                                    "description": "type=\"format\"일 때: 그 문단 안에서 서식을 바꿀 정확한 문자열. 문단 전체면 생략. 문단 내에서 유일해야 한다(여러 번 나오면 적용되지 않음)."
                                },
                                "char_format": {
                                    "type": "object",
                                    "description": "type=\"format\"일 때: 적용할 글자 서식(바꿀 속성만). 텍스트 내용은 바뀌지 않는다(command=REPLACE, payload.text 불필요).",
                                    "properties": {
                                        "bold": { "type": "boolean" },
                                        "italic": { "type": "boolean" },
                                        "underline": { "type": "boolean" },
                                        "strikethrough": { "type": "boolean" },
                                        "font_size_pt": { "type": "number", "description": "글자 크기(pt, 예 10.5)" },
                                        "text_color": { "type": "string", "description": "글자 색 #RRGGBB" },
                                        "font_family": { "type": "string", "description": "글꼴 이름(예 \"맑은 고딕\", \"함초롬바탕\")" },
                                        "highlight_color": { "type": "string", "description": "형광펜(음영) 색 #RRGGBB" },
                                        "superscript": { "type": "boolean", "description": "위 첨자" },
                                        "subscript": { "type": "boolean", "description": "아래 첨자" }
                                    }
                                },
                                "para_format": {
                                    "type": "object",
                                    "description": "문단 서식·번호 목록. type=\"para_format\"+command=REPLACE면 그 문단의 텍스트는 그대로 두고 서식만 바꾼다(본문 문단·표 셀 문단 ID). 텍스트를 넣는 INSERT/REPLACE 편집에 함께 넣으면 새 문단에 바로 적용된다. 사용자가 정렬·줄간격·들여쓰기·번호 매기기를 명시적으로 요구할 때만 채운다(평소 모양은 style이 정한다).",
                                    "properties": {
                                        "alignment": { "type": "string", "enum": ["left", "center", "right", "justify", "distribute"] },
                                        "line_spacing_percent": { "type": "number", "description": "줄 간격(%) 예 160" },
                                        "indent_pt": { "type": "number", "description": "첫 줄 들여쓰기(pt), 음수=내어쓰기" },
                                        "margin_left_pt": { "type": "number", "description": "왼쪽 여백(pt)" },
                                        "spacing_before_pt": { "type": "number", "description": "문단 위 간격(pt)" },
                                        "spacing_after_pt": { "type": "number", "description": "문단 아래 간격(pt)" },
                                        "keep_with_next": { "type": "boolean", "description": "다음 문단과 같은 쪽에" },
                                        "list": {
                                            "type": "object",
                                            "description": "번호·글머리표. number=1. 가. 1) 순 문단 번호, bullet=글머리표, outline=개요 번호, none=해제.",
                                            "properties": {
                                                "kind": { "type": "string", "enum": ["number", "bullet", "outline", "none"] },
                                                "level": { "type": "integer", "description": "수준 0~6(0=1수준: 1., 1=2수준: 가. …)" },
                                                "bullet_char": { "type": "string", "description": "bullet 문자(생략 시 ●)" }
                                            },
                                            "required": ["kind"]
                                        }
                                    }
                                },
                                "page_setup": {
                                    "type": "object",
                                    "description": "type=\"page_setup\"일 때: 용지 방향·크기·여백. command=REPLACE, target_id=\"doc\". 모든 구역에 적용된다.",
                                    "properties": {
                                        "orientation": { "type": "string", "enum": ["portrait", "landscape"] },
                                        "paper": { "type": "string", "enum": ["A4", "A3", "B5", "Letter"] },
                                        "margins_mm": {
                                            "type": "object",
                                            "properties": {
                                                "top": { "type": "number" },
                                                "bottom": { "type": "number" },
                                                "left": { "type": "number" },
                                                "right": { "type": "number" }
                                            }
                                        }
                                    }
                                },
                                "page_number": {
                                    "type": "object",
                                    "description": "type=\"page_number\"일 때: 모든 쪽에 자동 쪽 번호를 넣는다(직접 \"1\"을 쓰면 모든 쪽이 1이 된다). command=REPLACE, target_id=\"doc\". 그 위치(머리말/꼬리말)의 기존 내용은 쪽 번호로 대체된다.",
                                    "properties": {
                                        "position": { "type": "string", "enum": ["footer", "header"] },
                                        "align": { "type": "string", "enum": ["center", "left", "right"] },
                                        "format": { "type": "string", "enum": ["plain", "dash", "total"], "description": "plain=1, dash=- 1 -, total=1 / 10" }
                                    }
                                },
                                "replace_text": {
                                    "type": "object",
                                    "description": "type=\"replace_text\"일 때: 문서 전체에서 찾아 바꾸기. 같은 문자열을 여러 문단에서 바꿀 때는 문단마다 REPLACE를 내지 말고 반드시 이걸 한 번 써라. command=REPLACE, target_id=\"doc\"(문서 전체를 뜻하는 고정값). 본문과 표 셀 안을 모두 바꾼다.",
                                    "properties": {
                                        "query": { "type": "string", "description": "찾을 문자열(정확히 일치). 비우면 적용되지 않는다." },
                                        "new_text": { "type": "string", "description": "바꿀 문자열. 빈 문자열이면 찾은 부분을 지운다." },
                                        "case_sensitive": { "type": "boolean", "description": "대소문자 구분(기본 false)" },
                                        "scope": { "type": "string", "enum": ["all", "first"], "description": "all=전부 바꾸기(기본), first=처음 한 건만" }
                                    },
                                    "required": ["query", "new_text"]
                                },
                                "paste_html": {
                                    "type": "object",
                                    "description": "type=\"paste_html\"일 때: HTML을 서식을 유지한 채 문서에 넣는다. 굵기·기울임·목록·표가 살아 있는 내용을 넣어야 할 때 쓴다(순수 텍스트면 그냥 payload.text를 쓰는 게 낫다). command=REPLACE면 그 문단 내용을 대신하고, INSERT_AFTER/INSERT_BEFORE면 새 문단을 만들어 거기에 넣는다. target_id는 본문 문단 ID 또는 최상위 표 셀 ID.",
                                    "properties": {
                                        "html": { "type": "string", "description": "붙여넣을 HTML 조각. 예: \"<p><b>제목</b></p><ul><li>항목</li></ul>\"" }
                                    },
                                    "required": ["html"]
                                },
                                "footnote": {
                                    "type": "object",
                                    "description": "type=\"footnote\"일 때: 각주를 달거나 뗀다. [달기] command=REPLACE, target_id는 각주를 달 본문 문단 ID, text에 각주 내용을 넣는다(문단 본문은 바뀌지 않는다). anchor_text를 주면 그 문자열 바로 뒤에 표식이 붙고, 생략하면 문단 끝에 붙는다. [떼기] command=DELETE, target_id는 각주 ID(sec[S].p[P].fn[C].p[I]) — 각주가 표식까지 사라진다. 각주 '내용만' 고칠 때는 payload.type 없이 그 각주 ID에 REPLACE 하면 된다.",
                                    "properties": {
                                        "text": { "type": "string", "description": "달 각주의 내용(달기에만 필요)" },
                                        "anchor_text": { "type": "string", "description": "이 문자열 바로 뒤에 각주 표식을 단다. 문단 안에서 유일해야 한다. 생략하면 문단 끝." }
                                    }
                                },
                                "table_formula": {
                                    "type": "object",
                                    "description": "type=\"table_formula\"일 때: 표의 값을 직접 계산해 셀에 적는다. 합계·평균·곱셈 같은 계산을 요청받으면 절대 직접 암산해서 숫자를 text로 넣지 말고 이걸 쓴다(원본 값이 바뀌어도 다시 계산할 수 있고 계산 실수가 없다). command=REPLACE, target_id는 그 표 안의 아무 셀 ID. 주의: row/col은 0-기준 정수지만 formula 안의 셀 참조는 A1 표기다(첫 행이 1, 첫 열이 A).",
                                    "properties": {
                                        "row": { "type": "integer", "description": "결과를 쓸 셀의 행(0-기준)" },
                                        "col": { "type": "integer", "description": "결과를 쓸 셀의 열(0-기준)" },
                                        "formula": { "type": "string", "description": "계산식. 예: \"=SUM(B2:B5)\", \"=A1+B2*3\". 셀 참조는 A1 표기." }
                                    },
                                    "required": ["row", "col", "formula"]
                                },
                                "table_edit": {
                                    "type": "object",
                                    "description": "type=\"table_edit\"일 때: 기존 표의 구조 편집. target_id는 그 표 안의 아무 셀 ID(예: sec[0].p[2].tbl[0].cell[0].p[0]). command는 REPLACE를 쓴다.",
                                    "properties": {
                                        "op": { "type": "string", "enum": ["insert_row", "insert_col", "delete_row", "delete_col", "merge_cells", "split_cell"] },
                                        "row": { "type": "integer", "description": "기준 행(0-기준) — insert_row/delete_row" },
                                        "col": { "type": "integer", "description": "기준 열(0-기준) — insert_col/delete_col" },
                                        "below": { "type": "boolean", "description": "insert_row: 기준 행 아래에 삽입(기본 true)" },
                                        "right": { "type": "boolean", "description": "insert_col: 기준 열 오른쪽에 삽입(기본 true)" },
                                        "merge": {
                                            "type": "object",
                                            "description": "merge_cells: 병합 범위(0-기준, 끝 포함)",
                                            "properties": {
                                                "start_row": { "type": "integer" },
                                                "start_col": { "type": "integer" },
                                                "end_row": { "type": "integer" },
                                                "end_col": { "type": "integer" }
                                            }
                                        },
                                        "texts": {
                                            "type": "array",
                                            "description": "insert_row/insert_col: 새 행/열에 채울 셀 텍스트(순서대로, 선택)",
                                            "items": { "type": "string" }
                                        },
                                        "into_rows": { "type": "integer", "description": "split_cell: 셀을 몇 줄로 나눌지(기본 1)" },
                                        "into_cols": { "type": "integer", "description": "split_cell: 셀을 몇 칸으로 나눌지(기본 1)" },
                                        "equal_row_height": { "type": "boolean", "description": "split_cell: 나뉜 줄 높이를 균등하게(기본 true)" },
                                        "range": {
                                            "type": "object",
                                            "description": "split_cell: 주면 이 범위 안의 셀들을 각각 into_rows×into_cols로 분할한다(0-기준, 끝 포함).",
                                            "properties": {
                                                "start_row": { "type": "integer" },
                                                "start_col": { "type": "integer" },
                                                "end_row": { "type": "integer" },
                                                "end_col": { "type": "integer" }
                                            }
                                        }
                                    },
                                    "required": ["op"]
                                },
                                "clone_table": {
                                    "type": "object",
                                    "description": "type=\"clone_table\"일 때: 반복 양식 문서에서 기존 표를 그대로 복제하고 입력칸만 채운다(새로 그리지 않음 → 행·열·병합·테두리 원본과 100% 동일). command=INSERT_AFTER, target_id는 새 항목을 넣을 위치의 본문 문단 ID. clone_from은 컨텍스트의 '복제 가능 양식 표' 좌표(formTables[])에서 고른다.",
                                    "properties": {
                                        "clone_from": {
                                            "type": "object",
                                            "description": "복제할 원본 양식 표의 좌표. 컨텍스트 document_metadata.form_tables의 항목을 그대로 쓴다.",
                                            "properties": {
                                                "section": { "type": "integer" },
                                                "paragraph": { "type": "integer" },
                                                "control_index": { "type": "integer" }
                                            },
                                            "required": ["section", "paragraph", "control_index"]
                                        },
                                        "cell_fills": {
                                            "type": "array",
                                            "description": "복제된 표에서 채울 입력칸들. 라벨칸은 넣지 말 것(생략하면 원본 라벨이 그대로 보존된다). text는 \\n으로 여러 줄을 넣을 수 있다.",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "row": { "type": "integer", "description": "0-기준 행" },
                                                    "col": { "type": "integer", "description": "0-기준 열" },
                                                    "text": { "type": "string" }
                                                },
                                                "required": ["row", "col", "text"]
                                            }
                                        }
                                    },
                                    "required": ["clone_from"]
                                },
                                "table_data": {
                                    "type": "object",
                                    "properties": {
                                        "rows": { "type": "integer" },
                                        "cols": { "type": "integer" },
                                        "matrix": {
                                            "type": "array",
                                            "items": { "type": "array", "items": { "type": "string" } }
                                        },
                                        "merges": {
                                            "type": "array",
                                            "description": "병합할 셀 영역(0-기준, 끝 포함). 헤더·세로 병합 등.",
                                            "items": {
                                                "type": "object",
                                                "properties": {
                                                    "start_row": { "type": "integer" },
                                                    "start_col": { "type": "integer" },
                                                    "end_row": { "type": "integer" },
                                                    "end_col": { "type": "integer" }
                                                }
                                            }
                                        },
                                        "col_weights": {
                                            "type": "array",
                                            "description": "열별 상대 폭 가중치(길이=cols). 긴 설명/비고 열은 크게(예 8), ○/× 같은 짧은 열은 작게(예 2) 두어 표가 세로로 덜 늘어나게 한다.",
                                            "items": { "type": "integer" }
                                        }
                                    }
                                }
                            }
                        }
                    },
                    "required": ["command", "target_id", "payload"]
                }
            }
        },
        "required": ["edits"]
    })
}

fn strip_code_fences(raw: &str) -> &str {
    let trimmed = raw.trim();
    let Some(rest) = trimmed.strip_prefix("```") else {
        return trimmed;
    };
    // ```json 또는 ``` 다음 첫 줄바꿈 이후가 본문이다.
    let body = match rest.find('\n') {
        Some(idx) => &rest[idx + 1..],
        None => rest,
    };
    body.trim().strip_suffix("```").unwrap_or(body).trim()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whitelist(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_insert_after_edit() {
        let raw = r#"{
            "edits": [
                {
                    "command": "INSERT_AFTER",
                    "target_id": "sec[0].p[1]",
                    "payload": { "type": "paragraph", "text": "추가 문장." }
                }
            ]
        }"#;

        let script = parse_action_script(raw).unwrap();
        assert_eq!(script.edits.len(), 1);
        assert_eq!(script.edits[0].command, EditCommand::InsertAfter);
        assert_eq!(script.edits[0].target_id, "sec[0].p[1]");
        assert_eq!(
            script.edits[0].payload.text.as_deref(),
            Some("추가 문장.")
        );
    }

    #[test]
    fn strips_markdown_code_fences() {
        let raw = "```json\n{\"edits\":[]}\n```";
        let script = parse_action_script(raw).unwrap();
        assert!(script.edits.is_empty());
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(parse_action_script("{not json").is_err());
    }

    #[test]
    fn empty_response_gives_clear_message() {
        let err = parse_action_script("   \n  ").unwrap_err();
        assert!(err.contains("빈 응답"));
    }

    #[test]
    fn extracts_json_object_wrapped_in_prose() {
        // CLI 등이 설명 문장으로 감싼 경우에도 가장 바깥 객체를 떼어 파싱한다.
        let raw = "물론이죠! 아래가 결과입니다:\n{\"edits\":[]}\n도움이 되었길 바랍니다.";
        let script = parse_action_script(raw).unwrap();
        assert!(script.edits.is_empty());
    }

    #[test]
    fn parse_failure_includes_received_preview() {
        let err = parse_action_script("죄송하지만 편집할 수 없습니다.").unwrap_err();
        assert!(err.contains("받은 응답 일부"));
        assert!(err.contains("죄송하지만"));
    }

    #[test]
    fn collect_violations_flags_unknown_target_ids() {
        let script = parse_action_script(
            r#"{"edits":[
                {"command":"DELETE","target_id":"sec[0].p[0]","payload":{}},
                {"command":"REPLACE","target_id":"sec[9].p[9]","payload":{"text":"x"}}
            ]}"#,
        )
        .unwrap();

        let violations = collect_violations(&script, &whitelist(&["sec[0].p[0]"]));
        assert_eq!(violations, vec!["sec[9].p[9]".to_string()]);
    }

    #[test]
    fn collect_violations_empty_when_all_known() {
        let script = parse_action_script(
            r#"{"edits":[{"command":"DELETE","target_id":"sec[0].p[0]","payload":{}}]}"#,
        )
        .unwrap();
        assert!(collect_violations(&script, &whitelist(&["sec[0].p[0]"])).is_empty());
    }

    #[test]
    fn parses_paste_html_and_round_trips() {
        let raw = r#"{"edits":[
            {"command":"INSERT_AFTER","target_id":"sec[0].p[3]",
             "payload":{"type":"paste_html","paste_html":{"html":"<p><b>제목</b></p><ul><li>항목</li></ul>"}}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        let spec = script.edits[0].payload.paste_html.as_ref().unwrap();
        assert!(spec.html.contains("<b>제목</b>"));
        let json = serde_json::to_string(&script).unwrap();
        assert_eq!(parse_action_script(&json).unwrap(), script);
    }

    #[test]
    fn action_script_schema_exposes_all_editing_kinds() {
        // AI가 낼 수 있는 편집 어휘 전체 — 여기 없는 건 AI가 할 수 없는 일이다.
        let schema = action_script_schema().to_string();
        for kind in [
            "paragraph",
            "table",
            "image",
            "table_edit",
            "clone_table",
            "format",
            "chart",
            "replace_text",
            "table_formula",
            "footnote",
            "paste_html",
        ] {
            assert!(schema.contains(kind), "스키마에 payload type이 없습니다: {}", kind);
        }
    }

    #[test]
    fn parses_footnote_and_round_trips() {
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[4]",
             "payload":{"type":"footnote","footnote":{"text":"한국연구재단(2026)","anchor_text":"유의미했다"}}},
            {"command":"DELETE","target_id":"sec[0].p[4].fn[1].p[0]","payload":{"type":"footnote"}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        let add = script.edits[0].payload.footnote.as_ref().unwrap();
        assert_eq!(add.text.as_deref(), Some("한국연구재단(2026)"));
        assert_eq!(add.anchor_text.as_deref(), Some("유의미했다"));
        // 떼기는 footnote 객체 없이 type만 오는 게 정상 — 갈래는 payload.type으로 가른다.
        assert_eq!(script.edits[1].payload.kind.as_deref(), Some("footnote"));
        assert!(script.edits[1].payload.footnote.is_none());
        let json = serde_json::to_string(&script).unwrap();
        assert_eq!(parse_action_script(&json).unwrap(), script);
    }

    #[test]
    fn footnote_content_only_edit_stays_untyped() {
        // F-191fd6 하위 호환: payload.type이 없으면 '각주 내용만' 수정하는 기존 경로다.
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[4].fn[1].p[0]","payload":{"text":"새 내용"}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        assert!(script.edits[0].payload.kind.is_none());
        assert!(script.edits[0].payload.footnote.is_none());
    }

    #[test]
    fn parses_table_formula_and_round_trips() {
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[3].tbl[0].cell[0].p[0]",
             "payload":{"type":"table_formula","table_formula":{"row":5,"col":1,"formula":"=SUM(B2:B5)"}}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        let spec = script.edits[0].payload.table_formula.as_ref().unwrap();
        assert_eq!((spec.row, spec.col), (5, 1));
        assert_eq!(spec.formula, "=SUM(B2:B5)");
        let json = serde_json::to_string(&script).unwrap();
        assert_eq!(parse_action_script(&json).unwrap(), script);
    }

    #[test]
    fn action_script_schema_warns_against_mental_arithmetic() {
        // 계산을 요청받았을 때 모델이 암산한 숫자를 text로 넣지 않도록 스키마가 막아야 한다.
        let schema = action_script_schema().to_string();
        assert!(schema.contains("table_formula") && schema.contains("formula"));
        assert!(schema.contains("암산"));
        // 0-기준 좌표와 A1 표기가 섞이는 실수를 막는 안내.
        assert!(schema.contains("A1 표기"));
    }

    #[test]
    fn parses_split_cell_and_round_trips() {
        // F-6daa56b3: merge_cells의 짝. 분할 수·균등 높이·범위가 모두 살아남아야 한다.
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[2].tbl[1].cell[0].p[0]",
             "payload":{"type":"table_edit","table_edit":{"op":"split_cell","row":1,"col":2,
              "into_rows":2,"into_cols":3,"equal_row_height":false,
              "range":{"start_row":1,"start_col":0,"end_row":3,"end_col":0}}}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        let spec = script.edits[0].payload.table_edit.as_ref().unwrap();
        assert_eq!(spec.op, "split_cell");
        assert_eq!(spec.into_rows, Some(2));
        assert_eq!(spec.into_cols, Some(3));
        assert_eq!(spec.equal_row_height, Some(false));
        assert_eq!(spec.range.as_ref().unwrap().end_row, 3);
        let json = serde_json::to_string(&script).unwrap();
        assert_eq!(parse_action_script(&json).unwrap(), script);
    }

    #[test]
    fn action_script_schema_offers_split_alongside_merge() {
        // 병합만 있고 분할이 없으면 모델이 셀을 나눠 달라는 요청에 표를 다시 그린다.
        let schema = action_script_schema().to_string();
        assert!(schema.contains("split_cell") && schema.contains("merge_cells"));
        assert!(schema.contains("into_rows") && schema.contains("into_cols"));
    }

    #[test]
    fn doc_scope_target_allowed_only_for_replace_text() {
        // F-293e8c99: "doc"은 전역 찾아 바꾸기 전용 스코프 토큰이다. 다른 payload가
        // 문서 전체를 target으로 잡는 환각은 화이트리스트 위반으로 걸러야 한다.
        let script = parse_action_script(
            r#"{"edits":[
                {"command":"REPLACE","target_id":"doc",
                 "payload":{"type":"replace_text","replace_text":{"query":"2025","new_text":"2026"}}},
                {"command":"REPLACE","target_id":"doc",
                 "payload":{"type":"paragraph","text":"문서 전체를 이걸로"}}
            ]}"#,
        )
        .unwrap();

        let violations = collect_violations(&script, &whitelist(&["doc"]));
        assert_eq!(violations, vec!["doc".to_string()]);
    }

    #[test]
    fn doc_scope_target_rejected_when_not_whitelisted() {
        // 구간 스코프 요청(build_scoped_context)은 "doc"을 화이트리스트에 넣지 않는다 —
        // 구간 밖까지 바꾸는 전역 치환은 스코프 위반이므로 거부돼야 한다.
        let script = parse_action_script(
            r#"{"edits":[
                {"command":"REPLACE","target_id":"doc",
                 "payload":{"type":"replace_text","replace_text":{"query":"a","new_text":"b"}}}
            ]}"#,
        )
        .unwrap();

        let violations = collect_violations(&script, &whitelist(&["sec[0].p[0]"]));
        assert_eq!(violations, vec!["doc".to_string()]);
    }

    #[test]
    fn parses_replace_text_and_round_trips() {
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"doc","payload":{"type":"replace_text",
             "replace_text":{"query":"2025년","new_text":"2026년","case_sensitive":true,"scope":"first"}}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        let spec = script.edits[0].payload.replace_text.as_ref().unwrap();
        assert_eq!(spec.query, "2025년");
        assert_eq!(spec.new_text, "2026년");
        assert_eq!(spec.case_sensitive, Some(true));
        assert_eq!(spec.scope.as_deref(), Some("first"));
        // 재직렬화 라운드트립 — mod.rs가 파싱 결과를 다시 직렬화해 프런트로 보낸다.
        let json = serde_json::to_string(&script).unwrap();
        let again = parse_action_script(&json).unwrap();
        assert_eq!(script, again);
    }

    #[test]
    fn action_script_schema_exposes_replace_text() {
        let schema = action_script_schema().to_string();
        assert!(schema.contains("replace_text"));
        assert!(schema.contains("case_sensitive"));
        // 모델이 문단마다 REPLACE를 나열하지 않도록 유도하는 안내가 스키마에 있어야 한다.
        assert!(schema.contains("문단마다 REPLACE를 내지 말고"));
    }

    #[test]
    fn parses_variations_and_round_trips() {
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[1]",
             "payload":{"type":"paragraph","text":"안 1","variations":["안 1","안 2","안 3"]}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        assert_eq!(script.edits[0].payload.variations, vec!["안 1", "안 2", "안 3"]);
        // 재직렬화 시 프런트로 그대로 전달되어야 한다.
        let json = serde_json::to_string(&script).unwrap();
        assert!(json.contains("variations"));
        // 빈 variations는 직렬화에서 생략된다.
        let raw2 = r#"{"edits":[{"command":"DELETE","target_id":"sec[0].p[0]","payload":{}}]}"#;
        let s2 = parse_action_script(raw2).unwrap();
        assert!(!serde_json::to_string(&s2).unwrap().contains("variations"));
    }

    #[test]
    fn parses_reason_and_round_trips() {
        // 교정 패스의 payload.reason은 재직렬화(emit_validated)에서 살아남아야 한다.
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[1]",
             "payload":{"type":"paragraph","text":"됐다","reason":"맞춤법: '됬다'→'됐다'"}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        assert_eq!(script.edits[0].payload.reason.as_deref(), Some("맞춤법: '됬다'→'됐다'"));
        let json = serde_json::to_string(&script).unwrap();
        assert!(json.contains("reason"));
        // reason 없는 일반 편집은 직렬화에서 생략된다.
        let raw2 = r#"{"edits":[{"command":"DELETE","target_id":"sec[0].p[0]","payload":{}}]}"#;
        let s2 = parse_action_script(raw2).unwrap();
        assert!(!serde_json::to_string(&s2).unwrap().contains("reason"));
    }

    #[test]
    fn parses_table_edit_and_round_trips() {
        // 표 구조 편집 payload는 재직렬화(emit_validated)에서 살아남아야 한다.
        let raw = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[2].tbl[0].cell[0].p[0]",
             "payload":{"type":"table_edit","table_edit":{"op":"insert_row","row":1,"below":true,"texts":["가","나"]}}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        let spec = script.edits[0].payload.table_edit.as_ref().unwrap();
        assert_eq!(spec.op, "insert_row");
        assert_eq!(spec.row, Some(1));
        assert_eq!(spec.texts, vec!["가", "나"]);
        let json = serde_json::to_string(&script).unwrap();
        assert!(json.contains("table_edit") && json.contains("insert_row"));
        // merge 범위도 라운드트립된다.
        let raw2 = r#"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[2].tbl[0].cell[0].p[0]",
             "payload":{"type":"table_edit","table_edit":{"op":"merge_cells","merge":{"start_row":0,"start_col":0,"end_row":1,"end_col":0}}}}
        ]}"#;
        let s2 = parse_action_script(raw2).unwrap();
        assert!(serde_json::to_string(&s2).unwrap().contains("merge_cells"));
    }

    #[test]
    fn parses_char_format_and_round_trips() {
        // 부분 서식 payload(format_target+char_format)는 재직렬화에서 살아남아야 한다.
        let raw = r##"{"edits":[
            {"command":"REPLACE","target_id":"sec[0].p[1]",
             "payload":{"type":"format","format_target":"핵심 성과",
                        "char_format":{"bold":true,"text_color":"#C00000","font_size_pt":14}}}
        ]}"##;
        let script = parse_action_script(raw).unwrap();
        assert_eq!(script.edits[0].payload.format_target.as_deref(), Some("핵심 성과"));
        let spec = script.edits[0].payload.char_format.as_ref().unwrap();
        assert_eq!(spec.bold, Some(true));
        assert_eq!(spec.font_size_pt, Some(14.0));
        let json = serde_json::to_string(&script).unwrap();
        assert!(json.contains("char_format") && json.contains("format_target"));
    }

    #[test]
    fn parses_chart_data_and_round_trips() {
        let raw = r#"{"edits":[
            {"command":"INSERT_AFTER","target_id":"sec[0].p[3]",
             "payload":{"type":"chart","chart_data":{"kind":"bar","title":"분기별 매출",
               "labels":["1분기","2분기"],"series":[{"name":"매출","values":[120.5,98.0]}]}}}
        ]}"#;
        let script = parse_action_script(raw).unwrap();
        let chart = script.edits[0].payload.chart_data.as_ref().unwrap();
        assert_eq!(chart.kind, "bar");
        assert_eq!(chart.labels.len(), 2);
        assert_eq!(chart.series[0].values, vec![120.5, 98.0]);
        // 재직렬화(emit_validated)에서 살아남아 프런트로 전달된다.
        let json = serde_json::to_string(&script).unwrap();
        assert!(json.contains("chart_data") && json.contains("분기별 매출"));
    }

    #[test]
    fn parses_form_fill_response_and_round_trips() {
        // 양식 이어쓰기 응답은 entries[].fields[]{label,value}만 가진다 — 표/compose 없음.
        let raw = r#"{
            "message": "연구노트 항목 2개를 추가했습니다.",
            "entries": [
                {"fields": [
                    {"label": "제목", "value": "실험 A 재현"},
                    {"label": "연구내용", "value": "첫째 줄\n둘째 줄"}
                ]},
                {"fields": [{"label": "제목", "value": "실험 B"}]}
            ]
        }"#;
        let resp = parse_form_fill_response(raw).unwrap();
        assert_eq!(resp.entries.len(), 2);
        assert_eq!(resp.entries[0].fields.len(), 2);
        assert_eq!(resp.entries[0].fields[1].label, "연구내용");
        assert_eq!(resp.entries[0].fields[1].value, "첫째 줄\n둘째 줄");
        assert_eq!(resp.message.as_deref(), Some("연구노트 항목 2개를 추가했습니다."));
        // 재직렬화 라운드트립.
        let json = serde_json::to_string(&resp).unwrap();
        let again = parse_form_fill_response(&json).unwrap();
        assert_eq!(resp, again);
    }

    #[test]
    fn form_fill_schema_has_no_table_or_compose_constructs() {
        // 스키마에 표/compose/edit 구성요소가 없어야 한다(AC-0cd01fc1 — AI가 표를 그릴 여지 제거).
        let schema = form_fill_schema().to_string();
        assert!(schema.contains("entries") && schema.contains("fields"));
        assert!(schema.contains("label") && schema.contains("value"));
        for forbidden in [
            "table_data",
            "clone_table",
            "table_edit",
            "matrix",
            "merges",
            "\"rows\"",
            "\"cols\"",
        ] {
            assert!(
                !schema.contains(forbidden),
                "form_fill 스키마가 표/compose 구성요소를 노출하면 안 됩니다: {}",
                forbidden
            );
        }
    }

    #[test]
    fn form_fill_response_struct_has_no_table_fields() {
        // 구조체 자체에도 표 관련 필드가 없음을 직렬화 키로 확인한다.
        let resp = FormFillResponse {
            entries: vec![FormFillEntry {
                fields: vec![FormFillField {
                    label: "제목".to_string(),
                    value: "x".to_string(),
                }],
                body: Vec::new(),
            }],
            message: None,
        };
        let json = serde_json::to_string(&resp).unwrap();
        for forbidden in ["table", "clone", "matrix", "merge", "compose", "command"] {
            assert!(!json.contains(forbidden), "표/compose 키 노출 금지: {}", forbidden);
        }
    }

    #[test]
    fn form_fill_body_survives_parse_and_canonical_reserialization() {
        // emit_form_fill은 파싱 결과를 다시 직렬화해 프론트로 보낸다 — 구조체에 body가
        // 없으면 모델이 본문을 줘도 조용히 사라진다(F-86317c64 AC-fcef045d).
        let raw = r#"{"entries":[{"fields":[{"label":"제목","value":"1주차"}],
                       "body":["첫 단락","둘째 단락"]}]}"#;
        let resp = parse_form_fill_response(raw).unwrap();
        assert_eq!(resp.entries[0].body, vec!["첫 단락", "둘째 단락"]);
        let canonical = serde_json::to_string(&resp).unwrap();
        assert!(canonical.contains("첫 단락"), "canonical: {}", canonical);
        assert!(canonical.contains("\"body\""), "canonical: {}", canonical);
    }

    #[test]
    fn form_fill_body_is_optional_and_omitted_when_empty() {
        // 본문 칸이 없는 양식에서는 body를 안 보낸다 — 빈 배열 키로 프롬프트를 오염시키지 않는다.
        let resp = parse_form_fill_response(r#"{"entries":[{"fields":[]}]}"#).unwrap();
        assert!(resp.entries[0].body.is_empty());
        assert!(!serde_json::to_string(&resp).unwrap().contains("body"));
    }

    #[test]
    fn form_fill_schema_offers_a_body_channel() {
        let schema = form_fill_schema().to_string();
        assert!(schema.contains("body"), "본문 통칸 채널이 스키마에 없다");
    }

    #[test]
    fn parse_form_fill_response_rejects_empty_and_garbage() {
        assert!(parse_form_fill_response("   ").unwrap_err().contains("빈 응답"));
        assert!(parse_form_fill_response("not json").is_err());
        // 코드펜스 래핑도 벗겨낸다.
        let fenced = "```json\n{\"entries\":[]}\n```";
        assert!(parse_form_fill_response(fenced).unwrap().entries.is_empty());
    }

    #[test]
    fn command_round_trips_to_screaming_snake_case() {
        let value = serde_json::to_value(EditCommand::InsertBefore).unwrap();
        assert_eq!(value, json!("INSERT_BEFORE"));
    }

    // ── F-45cee3df AC-e0560800: 새 서식 명령의 스키마 노출과 "doc" 화이트리스트 ──

    /// "doc"을 겨눈 편집 네 가지: 쪽 설정·쪽 번호(허용) / 일반 텍스트·문단 서식(거부).
    fn doc_scoped_script() -> ActionScript {
        parse_action_script(
            r#"{"edits":[
                {"command":"REPLACE","target_id":"doc",
                 "payload":{"type":"page_setup","page_setup":{"orientation":"landscape","paper":"A4"}}},
                {"command":"REPLACE","target_id":"doc",
                 "payload":{"type":"page_number","page_number":{"align":"center","format":"dash"}}},
                {"command":"REPLACE","target_id":"doc",
                 "payload":{"type":"paragraph","text":"문서 전체를 이걸로"}},
                {"command":"REPLACE","target_id":"doc",
                 "payload":{"type":"para_format","para_format":{"alignment":"center"}}}
            ]}"#,
        )
        .unwrap()
    }

    #[test]
    fn f45cee3df_ac_e0560800_doc_target_passes_only_for_page_setup_and_page_number() {
        let script = doc_scoped_script();
        let types = |s: &ActionScript| -> Vec<Option<String>> {
            s.edits.iter().map(|e| e.payload.kind.clone()).collect()
        };

        // collect_violations: 텍스트·문단 서식 payload만 위반으로 잡힌다.
        let violations = collect_violations(&script, &whitelist(&["doc", "sec[0].p[0]"]));
        assert_eq!(violations, vec!["doc".to_string(), "doc".to_string()]);

        // drop_violations: 쪽 설정·쪽 번호는 남고, 나머지 두 편집만 떨어진다.
        let mut kept = script.clone();
        let removed = drop_violations(&mut kept, &whitelist(&["doc", "sec[0].p[0]"]));
        assert_eq!(removed.len(), 2);
        assert_eq!(
            types(&kept),
            vec![Some("page_setup".to_string()), Some("page_number".to_string())]
        );
    }

    #[test]
    fn f45cee3df_ac_e0560800_doc_page_edits_rejected_when_doc_not_whitelisted() {
        // 구간 스코프 요청은 "doc"을 화이트리스트에 넣지 않는다 — 쪽 설정·쪽 번호도 거부.
        let mut script = doc_scoped_script();
        let removed = drop_violations(&mut script, &whitelist(&["sec[0].p[0]"]));
        assert_eq!(removed.len(), 4);
        assert!(script.edits.is_empty());
    }

    #[test]
    fn f45cee3df_ac_e0560800_schema_exposes_format_commands() {
        let schema = action_script_schema();
        let payload = &schema["properties"]["edits"]["items"]["properties"]["payload"]["properties"];

        let kinds: Vec<&str> = payload["type"]["enum"]
            .as_array()
            .expect("payload.type enum")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        for kind in ["para_format", "page_setup", "page_number", "format", "replace_text"] {
            assert!(kinds.contains(&kind), "payload.type enum에 {kind} 없음: {kinds:?}");
        }

        let para = &payload["para_format"]["properties"];
        for key in [
            "alignment",
            "line_spacing_percent",
            "indent_pt",
            "margin_left_pt",
            "spacing_before_pt",
            "spacing_after_pt",
            "keep_with_next",
            "list",
        ] {
            assert!(para.get(key).is_some(), "para_format.{key} 누락");
        }
        assert_eq!(
            para["list"]["properties"]["kind"]["enum"],
            json!(["number", "bullet", "outline", "none"])
        );

        let page_setup = &payload["page_setup"]["properties"];
        assert_eq!(page_setup["orientation"]["enum"], json!(["portrait", "landscape"]));
        assert_eq!(page_setup["paper"]["enum"], json!(["A4", "A3", "B5", "Letter"]));
        for side in ["top", "bottom", "left", "right"] {
            assert!(page_setup["margins_mm"]["properties"].get(side).is_some(), "margins_mm.{side}");
        }

        let page_number = &payload["page_number"]["properties"];
        assert_eq!(page_number["position"]["enum"], json!(["footer", "header"]));
        assert_eq!(page_number["align"]["enum"], json!(["center", "left", "right"]));
        assert_eq!(page_number["format"]["enum"], json!(["plain", "dash", "total"]));

        let char_format = &payload["char_format"]["properties"];
        for key in ["font_family", "highlight_color", "superscript", "subscript"] {
            assert!(char_format.get(key).is_some(), "char_format.{key} 누락");
        }
    }

    #[test]
    fn f45cee3df_ac_e0560800_format_commands_round_trip_through_parse() {
        // 스키마에만 있고 구조체에 없으면 canonical 재직렬화에서 조용히 버려진다.
        let raw = r##"{"edits":[
            {"command":"REPLACE","target_id":"doc",
             "payload":{"type":"page_setup","page_setup":{"orientation":"landscape","paper":"B5",
              "margins_mm":{"top":20,"left":15.5}}}},
            {"command":"REPLACE","target_id":"doc",
             "payload":{"type":"page_number","page_number":{"position":"header","align":"right","format":"total"}}},
            {"command":"REPLACE","target_id":"sec[0].p[1]",
             "payload":{"type":"para_format","para_format":{"alignment":"center","list":{"kind":"number","level":1}}}},
            {"command":"REPLACE","target_id":"sec[0].p[2]",
             "payload":{"type":"format","char_format":{"font_family":"맑은 고딕","highlight_color":"#FFFF00","superscript":true}}}
        ]}"##;
        let script = parse_action_script(raw).unwrap();
        let json = serde_json::to_value(&script).unwrap();
        let payloads: Vec<&Value> = json["edits"].as_array().unwrap().iter().map(|e| &e["payload"]).collect();
        assert_eq!(payloads[0]["page_setup"]["paper"], json!("B5"));
        assert_eq!(payloads[0]["page_setup"]["margins_mm"]["left"], json!(15.5));
        assert_eq!(payloads[1]["page_number"]["format"], json!("total"));
        assert_eq!(payloads[2]["para_format"]["list"]["kind"], json!("number"));
        assert_eq!(payloads[3]["char_format"]["font_family"], json!("맑은 고딕"));
        assert_eq!(payloads[3]["char_format"]["highlight_color"], json!("#FFFF00"));
        assert_eq!(parse_action_script(&json.to_string()).unwrap(), script);
    }

    #[test]
    fn f45cee3df_ac_e0560800_type_only_page_number_on_doc_passes_like_the_frontend() {
        // 쪽 번호 필드는 모두 선택이라 프론트는 {"type":"page_number"}만으로도 기본값(가운데 꼬리말)
        // 쪽 번호를 넣는다 — 화이트리스트가 이를 위반으로 버리면 안 된다.
        let script = parse_action_script(
            r#"{"edits":[
                {"command":"REPLACE","target_id":"doc","payload":{"type":"page_number"}},
                {"command":"REPLACE","target_id":"doc","payload":{"type":"page_setup"}}
            ]}"#,
        )
        .unwrap();
        assert!(script.edits[0].payload.page_number.is_none());

        let mut kept = script.clone();
        let removed = drop_violations(&mut kept, &whitelist(&["doc"]));
        assert_eq!(kept.edits.len(), 1);
        assert_eq!(kept.edits[0].payload.kind.as_deref(), Some("page_number"));
        // page_setup은 바꿀 값이 없으면 프론트도 적용하지 않는다 — 객체 없이 오면 그대로 거부.
        assert_eq!(removed, vec!["doc".to_string()]);

        // "doc"이 화이트리스트에 없으면(구간 스코프) type만 있는 쪽 번호도 거부.
        let mut scoped = script.clone();
        assert_eq!(drop_violations(&mut scoped, &whitelist(&["sec[0].p[0]"])).len(), 2);
    }

    // ── F-bae302c6 AC-d7a9a930: 형식 오류 편집만 버리고 나머지를 살린다 ──

    #[test]
    fn fbae302c6_ac_d7a9a930_lenient_parse_drops_only_the_malformed_edit() {
        let raw = r#"{"message":"작성했습니다.","edits":[
            {"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"제목"}},
            {"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"type":"chart",
             "chart_data":{"kind":"bar","labels":["a"],"series":[{"name":"s","values":["10억"]}]}}},
            {"command":"MOVE","target_id":"sec[0].p[0]","payload":{"text":"x"}},
            {"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"본문"}}
        ]}"#;
        // 엄격 파싱은 응답 전체를 버린다 — 관대 파싱이 필요한 이유.
        assert!(parse_action_script(raw).is_err());

        let parsed = parse_action_script_lenient(raw).unwrap();
        let texts: Vec<Option<&str>> =
            parsed.script.edits.iter().map(|e| e.payload.text.as_deref()).collect();
        assert_eq!(texts, vec![Some("제목"), Some("본문")], "정상 편집은 순서대로 남는다");
        assert_eq!(parsed.dropped.len(), 2);
        assert!(parsed.dropped[0].contains("편집 2번"), "{:?}", parsed.dropped);
        assert!(parsed.dropped[1].contains("편집 3번"), "{:?}", parsed.dropped);
        assert_eq!(parsed.script.message.as_deref(), Some("작성했습니다."));
    }

    #[test]
    fn fbae302c6_ac_d7a9a930_lenient_parse_of_valid_script_drops_nothing() {
        let parsed = parse_action_script_lenient(
            r#"{"edits":[{"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"a"}}]}"#,
        )
        .unwrap();
        assert_eq!(parsed.script.edits.len(), 1);
        assert!(parsed.dropped.is_empty());
    }

    #[test]
    fn fbae302c6_ac_d7a9a930_lenient_parse_keeps_the_empty_response_message() {
        for raw in ["", "   \n  ", "```json\n```"] {
            let err = parse_action_script_lenient(raw).unwrap_err();
            assert!(err.contains("빈 응답"), "{raw:?} → {err}");
        }
    }

    #[test]
    fn fbae302c6_ac_d7a9a930_lenient_parse_still_fails_without_edits_array() {
        let err = parse_action_script_lenient(r#"{"message":"설명만 했습니다"}"#).unwrap_err();
        assert!(err.contains("edits"), "{err}");
        let err = parse_action_script_lenient("죄송하지만 편집할 수 없습니다.").unwrap_err();
        assert!(err.contains("받은 응답 일부"), "{err}");
    }

    // ── F-a7b2c7ba AC-ee075a19: 출력 한도·시간 초과로 끊긴 응답에서 완결된 편집만 살린다 ──

    const EDIT_TITLE: &str = r#"{"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"사업계획서","style":"title"}}"#;
    const EDIT_BODY: &str = r#"{"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"1. 사업 개요","style":"heading"}}"#;
    const HALF_EDIT: &str = r#"{"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"본문이 쓰이다 끊"#;

    /// 살린 결과는 엄격 파서(`parse_action_script`)로도 그대로 읽혀야 한다.
    fn salvage(partial: &str) -> ActionScript {
        let json = salvage_truncated_script(partial).expect("완결된 편집이 있으면 Some");
        parse_action_script(&json).unwrap_or_else(|e| panic!("살린 JSON이 유효하지 않다: {e}\n{json}"))
    }

    fn targets_and_texts(script: &ActionScript) -> Vec<(String, String)> {
        script
            .edits
            .iter()
            .map(|e| (e.target_id.clone(), e.payload.text.clone().unwrap_or_default()))
            .collect()
    }

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_keeps_only_fully_closed_edits_and_drops_the_half_written_last() {
        let partial = format!(r#"{{"edits":[{EDIT_TITLE},{EDIT_BODY},{HALF_EDIT}"#);
        let script = salvage(&partial);
        assert_eq!(
            targets_and_texts(&script),
            vec![
                ("sec[0].p[0]".to_string(), "사업계획서".to_string()),
                ("sec[0].p[0]".to_string(), "1. 사업 개요".to_string()),
            ]
        );
        assert_eq!(script.edits[0].command, EditCommand::Replace);
        assert_eq!(script.edits[1].payload.style.as_deref(), Some("heading"));
    }

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_keeps_a_complete_message_and_appends_the_count_notice() {
        let partial = format!(r#"{{"message":"사업계획서 1~2절을 작성했습니다.","edits":[{EDIT_TITLE},{EDIT_BODY},{HALF_EDIT}"#);
        let message = salvage(&partial).message.unwrap();
        assert!(message.starts_with("사업계획서 1~2절을 작성했습니다. "), "{message}");
        assert!(message.contains("출력 한도"), "{message}");
        assert!(message.contains("앞의 2건까지만 받았습니다"), "{message}");
        assert!(message.contains("'이어서 써줘'라고 하면 나머지를 이어서 씁니다"), "{message}");
    }

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_synthesizes_the_notice_when_message_is_missing_or_cut() {
        let notice = "(응답이 출력 한도에서 끊겨 앞의 1건까지만 받았습니다 — '이어서 써줘'라고 하면 나머지를 이어서 씁니다.)";
        // message가 아예 없다.
        let no_message = format!(r#"{{"edits":[{EDIT_TITLE},{HALF_EDIT}"#);
        assert_eq!(salvage(&no_message).message.as_deref(), Some(notice));
        // message가 edits 뒤에 오다 끊겼다.
        let cut_message = format!(r#"{{"edits":[{EDIT_TITLE}],"message":"작성을 마치"#);
        assert_eq!(salvage(&cut_message).message.as_deref(), Some(notice));
        // 공백뿐인 message는 없는 것으로 본다.
        let blank = format!(r#"{{"message":"  ","edits":[{EDIT_TITLE},{HALF_EDIT}"#);
        assert_eq!(salvage(&blank).message.as_deref(), Some(notice));
    }

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_message_after_edits_is_kept_when_complete() {
        let partial = format!(r#"{{"edits":[{EDIT_TITLE},{EDIT_BODY}],"message":"두 문단을 넣었습니다.""#);
        let script = salvage(&partial);
        assert_eq!(script.edits.len(), 2);
        let message = script.message.unwrap();
        assert!(message.starts_with("두 문단을 넣었습니다."), "{message}");
        assert!(message.contains("앞의 2건"), "{message}");
    }

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_handles_markdown_json_fences() {
        let partial = format!("```json\n{{\"edits\":[{EDIT_TITLE},{EDIT_BODY},{HALF_EDIT}");
        assert_eq!(salvage(&partial).edits.len(), 2);
    }

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_brackets_and_escaped_quotes_inside_strings_do_not_confuse_depth() {
        // 문자열 안의 { } [ ] 와 \" \\ 는 구조로 세지 않는다. 마지막 편집은 문자열 안의 '{'에서 끊겼다.
        let tricky = r#"{"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"괄호 {중괄호} [대괄호] ]} 와 \"인용\" 그리고 역슬래시 \\ 끝"}}"#;
        let half = r#"{"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"열린 { 괄호와 \"따옴표 [ 와 }"#;
        let partial = format!(r#"{{"message":"요약 {{초안}} [1/2] \"끝\"","edits":[{EDIT_TITLE},{tricky},{half}"#);
        let script = salvage(&partial);
        assert_eq!(script.edits.len(), 2);
        assert_eq!(
            script.edits[1].payload.text.as_deref(),
            Some(r#"괄호 {중괄호} [대괄호] ]} 와 "인용" 그리고 역슬래시 \ 끝"#)
        );
        assert!(script.message.unwrap().starts_with(r#"요약 {초안} [1/2] "끝""#));
    }

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_nested_payload_objects_and_arrays_survive_intact() {
        let table = r#"{"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"type":"table","table_data":{"rows":3,"cols":2,"matrix":[["구분","내용"],["인건비","[1] 연구원 {2}명"],["재료비","시약"]],"merges":[{"start_row":1,"start_col":0,"end_row":2,"end_col":0}]}}}"#;
        let half_table = r#"{"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"type":"table","table_data":{"rows":2,"cols":2,"matrix":[["a","b"],["c""#;
        let partial = format!(r#"{{"edits":[{EDIT_TITLE},{table},{half_table}"#);
        let script = salvage(&partial);
        assert_eq!(script.edits.len(), 2);
        let data = script.edits[1].payload.table_data.as_ref().expect("표 편집");
        assert_eq!((data.rows, data.cols), (3, 2));
        assert_eq!(
            data.matrix,
            vec![
                vec!["구분".to_string(), "내용".to_string()],
                vec!["인건비".to_string(), "[1] 연구원 {2}명".to_string()],
                vec!["재료비".to_string(), "시약".to_string()],
            ]
        );
        assert_eq!(data.merges.len(), 1);
        assert_eq!(data.merges[0].end_row, 2);
    }

    #[test]
    fn f_a7b2c7ba_ac_ee075a19_returns_none_without_any_complete_edit() {
        let only_half = format!(r#"{{"message":"작성 중","edits":[{HALF_EDIT}"#);
        for partial in [
            "",
            "응답 없음",
            r#"{"message":"생각 중"#,
            r#"{"message":"다 썼습니다","edits":["#,
            r#"{"message":"다 썼습니다","edits":[]"#,
            only_half.as_str(),
            r#"```json
{"edits":[{"comm"#,
        ] {
            assert_eq!(salvage_truncated_script(partial), None, "{partial:?}");
        }
    }

    // ── F-fb6592e9 AC-ae417d5d: 따른 지침 이름(skill)을 응답 형식에 두고, 파싱·잘림 복구를
    //    거쳐도 잃지 않는다 ──

    const SKILL_EDIT: &str = r#"{"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"협조 요청"}}"#;

    #[test]
    fn f_fb6592e9_ac_ae417d5d_schema_declares_skill_as_an_optional_string() {
        let schema = action_script_schema();
        assert_eq!(schema["properties"]["skill"]["type"], "string", "{}", schema["properties"]["skill"]);
        let required: Vec<&str> = schema["required"]
            .as_array()
            .expect("최상위 required 배열")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        // skill은 선택 항목 — 지침 목록이 없는 요청에서도 응답이 스키마를 만족해야 한다.
        assert_eq!(required, vec!["edits"]);
    }

    #[test]
    fn f_fb6592e9_ac_ae417d5d_strict_and_lenient_parsing_keep_skill() {
        let raw = format!(r#"{{"message":"공문을 작성했습니다.","skill":"공문","edits":[{SKILL_EDIT}]}}"#);
        assert_eq!(parse_action_script(&raw).unwrap().skill.as_deref(), Some("공문"));
        let lenient = parse_action_script_lenient(&raw).unwrap();
        assert_eq!(lenient.script.skill.as_deref(), Some("공문"));
        assert!(lenient.dropped.is_empty());

        // 코드펜스로 감싼 응답(CLI)에서도 남는다.
        let fenced = format!("```json\n{raw}\n```");
        assert_eq!(parse_action_script(&fenced).unwrap().skill.as_deref(), Some("공문"));
    }

    #[test]
    fn f_fb6592e9_ac_ae417d5d_lenient_fallback_path_keeps_skill() {
        // 형식이 틀린 편집(MOVE)이 섞여 엄격 파싱이 실패하고 관대 파싱이 편집 단위로 살리는 경로.
        let raw = format!(
            r#"{{"skill":"보고서","edits":[{SKILL_EDIT},{{"command":"MOVE","target_id":"sec[0].p[0]","payload":{{"text":"x"}}}}]}}"#
        );
        assert!(parse_action_script(&raw).is_err(), "엄격 파싱은 실패해야 관대 경로를 탄다");
        let lenient = parse_action_script_lenient(&raw).unwrap();
        assert_eq!(lenient.dropped.len(), 1, "{:?}", lenient.dropped);
        assert_eq!(lenient.script.edits.len(), 1);
        assert_eq!(lenient.script.skill.as_deref(), Some("보고서"));
    }

    #[test]
    fn f_fb6592e9_ac_ae417d5d_skill_serializes_only_when_present() {
        let without = parse_action_script(&format!(r#"{{"edits":[{SKILL_EDIT}]}}"#)).unwrap();
        assert_eq!(without.skill, None);
        let json = serde_json::to_string(&without).unwrap();
        assert!(!json.contains("skill"), "skill이 없으면 키를 내보내지 않는다: {json}");

        let with = parse_action_script(&format!(r#"{{"skill":"사업계획서","edits":[{SKILL_EDIT}]}}"#)).unwrap();
        let json = serde_json::to_string(&with).unwrap();
        assert!(json.contains(r#""skill":"사업계획서""#), "{json}");
        // 직렬화 → 다시 파싱해도 같은 값(프런트로 보내는 정규 JSON 왕복).
        assert_eq!(parse_action_script(&json).unwrap(), with);
    }

    #[test]
    fn f_fb6592e9_ac_ae417d5d_salvage_keeps_a_complete_skill_written_before_edits() {
        let partial = format!(r#"{{"skill":"사업계획서","message":"작성 중","edits":[{EDIT_TITLE},{HALF_EDIT}"#);
        let script = salvage(&partial);
        assert_eq!(script.edits.len(), 1);
        assert_eq!(script.skill.as_deref(), Some("사업계획서"));
    }

    #[test]
    fn f_fb6592e9_ac_ae417d5d_salvage_keeps_a_complete_skill_written_after_edits() {
        // edits 배열은 닫혔고, 그 뒤 skill은 완결, message가 쓰이다 끊겼다.
        let partial = format!(r#"{{"edits":[{EDIT_TITLE},{EDIT_BODY}],"skill":"보고서","message":"보고서를 작성"#);
        let script = salvage(&partial);
        assert_eq!(script.edits.len(), 2);
        assert_eq!(script.skill.as_deref(), Some("보고서"));
    }

    #[test]
    fn f_fb6592e9_ac_ae417d5d_salvage_drops_a_truncated_skill() {
        let partial = format!(r#"{{"edits":[{EDIT_TITLE}],"skill":"보고"#);
        let json = salvage_truncated_script(&partial).expect("완결된 편집이 있으면 Some");
        assert!(!json.contains("skill"), "쓰다 만 skill은 싣지 않는다: {json}");
        let script = salvage(&partial);
        assert_eq!(script.edits.len(), 1);
        assert_eq!(script.skill, None);
    }

    #[test]
    fn f_fb6592e9_ac_ae417d5d_salvage_ignores_a_skill_key_nested_inside_an_edit() {
        // 최상위 skill만 따른 지침 이름이다 — 편집 payload 안의 같은 이름 키는 무시한다.
        let nested = r#"{"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"x","skill":"가짜"}}"#;
        let partial = format!(r#"{{"edits":[{nested},{HALF_EDIT}"#);
        let script = salvage(&partial);
        assert_eq!(script.edits.len(), 1);
        assert_eq!(script.skill, None);
    }

    // ── F-866a1c71 긴 문서 분할 작성 — 개요 응답 검증(AC-a622a229) ──────────────

    /// 절 n개짜리 개요 JSON(제목·요점·목표 글자 수·표 여부 모두 채움).
    fn outline_json(n: usize) -> String {
        let sections: Vec<String> = (1..=n)
            .map(|i| {
                format!(
                    r#"{{"heading":"{i}. 절 {i}","brief":"요점 {i}","target_chars":1500,"table":false}}"#
                )
            })
            .collect();
        format!(r#"{{"title":"사업계획서","sections":[{}]}}"#, sections.join(","))
    }

    #[test]
    fn f_866a1c71_ac_a622a229_parses_a_full_outline() {
        let raw = r#"{"title":"  2027 신규 사업계획서 ","skill":"사업계획서","message":"5개 절로 구성",
            "sections":[
                {"heading":"1. 사업 개요","brief":"사업 목적과 배경","target_chars":1200,"table":false},
                {"heading":"2. 추진 일정","brief":"분기별 일정","target_chars":800,"table":true}
            ]}"#;
        let outline = parse_outline_response(raw).expect("유효한 개요");
        assert_eq!(outline.title, "2027 신규 사업계획서", "제목 앞뒤 공백은 잘라낸다");
        assert_eq!(outline.skill.as_deref(), Some("사업계획서"));
        assert_eq!(outline.message.as_deref(), Some("5개 절로 구성"));
        assert_eq!(
            outline.sections,
            vec![
                OutlineSection {
                    heading: "1. 사업 개요".into(),
                    brief: "사업 목적과 배경".into(),
                    target_chars: 1200,
                    table: false,
                },
                OutlineSection {
                    heading: "2. 추진 일정".into(),
                    brief: "분기별 일정".into(),
                    target_chars: 800,
                    table: true,
                },
            ]
        );
    }

    #[test]
    fn f_866a1c71_ac_a622a229_strips_code_fences() {
        let raw = format!("```json\n{}\n```", outline_json(4));
        let outline = parse_outline_response(&raw).expect("코드펜스로 감싼 개요도 읽는다");
        assert_eq!(outline.title, "사업계획서");
        assert_eq!(outline.sections.len(), 4);
        assert_eq!(outline.sections[3].heading, "4. 절 4");
    }

    #[test]
    fn f_866a1c71_ac_a622a229_extracts_json_from_surrounding_prose() {
        let raw = format!("다음과 같이 개요를 설계했습니다.\n{}\n이상입니다.", outline_json(5));
        let outline = parse_outline_response(&raw).expect("설명 문장 사이의 JSON을 찾아 읽는다");
        assert_eq!(outline.sections.len(), 5);
        assert_eq!(outline.sections[0].brief, "요점 1");
    }

    #[test]
    fn f_866a1c71_ac_a622a229_trims_headings_and_drops_empty_ones() {
        let raw = r#"{"title":"보고서","sections":[
            {"heading":"  1. 서론  ","brief":"a","target_chars":1000,"table":false},
            {"heading":"   ","brief":"빈 제목","target_chars":1000,"table":false},
            {"heading":"","brief":"빈 제목 2","target_chars":1000,"table":false},
            {"heading":"2. 본론","brief":"b","target_chars":1000,"table":false}
        ]}"#;
        let outline = parse_outline_response(raw).unwrap();
        let headings: Vec<&str> = outline.sections.iter().map(|s| s.heading.as_str()).collect();
        assert_eq!(headings, vec!["1. 서론", "2. 본론"]);
        assert_eq!(outline.sections[1].brief, "b", "남은 절의 순서·내용은 그대로");
    }

    #[test]
    fn f_866a1c71_ac_a622a229_zero_sections_is_an_error() {
        let empty = parse_outline_response(r#"{"title":"보고서","sections":[]}"#);
        assert!(empty.is_err(), "절 0개는 오류: {empty:?}");
        assert!(empty.unwrap_err().contains("절이 없습니다"));
        // 제목이 모두 비어 걸러지고 나면 0개 — 역시 오류다.
        let blank = parse_outline_response(
            r#"{"title":"보고서","sections":[{"heading":"  ","brief":"x","target_chars":500,"table":false}]}"#,
        );
        assert!(blank.is_err(), "빈 제목만 있으면 오류: {blank:?}");
    }

    #[test]
    fn f_866a1c71_ac_a622a229_more_than_twenty_sections_is_an_error() {
        let twenty = parse_outline_response(&outline_json(20)).expect("20개는 상한 이내");
        assert_eq!(twenty.sections.len(), 20);
        let over = parse_outline_response(&outline_json(21));
        let err = over.expect_err("21개는 오류");
        assert!(err.contains("21개"), "몇 개였는지 알린다: {err}");
        assert!(err.contains("20개"), "상한을 알린다: {err}");
    }

    #[test]
    fn f_866a1c71_ac_a622a229_clamps_target_chars_to_200_6000() {
        let raw = r#"{"title":"t","sections":[
            {"heading":"1","brief":"","target_chars":50,"table":false},
            {"heading":"2","brief":"","target_chars":199,"table":false},
            {"heading":"3","brief":"","target_chars":200,"table":false},
            {"heading":"4","brief":"","target_chars":1800,"table":false},
            {"heading":"5","brief":"","target_chars":6000,"table":false},
            {"heading":"6","brief":"","target_chars":6001,"table":false},
            {"heading":"7","brief":"","target_chars":90000,"table":false}
        ]}"#;
        let outline = parse_outline_response(raw).unwrap();
        let chars: Vec<u32> = outline.sections.iter().map(|s| s.target_chars).collect();
        assert_eq!(chars, vec![200, 200, 200, 1800, 6000, 6000, 6000]);
    }

    #[test]
    fn f_866a1c71_ac_a622a229_missing_fields_get_defaults() {
        let raw = r#"{"title":"t","sections":[{"heading":"1. 개요"}]}"#;
        let outline = parse_outline_response(raw).unwrap();
        assert_eq!(
            outline.sections,
            vec![OutlineSection {
                heading: "1. 개요".into(),
                brief: String::new(),
                target_chars: 1300,
                table: false,
            }]
        );
        assert_eq!(outline.skill, None);
        assert_eq!(outline.message, None);
    }

    #[test]
    fn f_866a1c71_ac_a622a229_garbage_is_an_error() {
        let err = parse_outline_response("개요를 만들 수 없습니다.").expect_err("JSON 없음");
        assert!(err.contains("개요"), "{err}");
        assert!(parse_outline_response("").is_err());
        // sections 키가 없으면(필수) 오류다.
        assert!(parse_outline_response(r#"{"title":"t"}"#).is_err());
    }

    #[test]
    fn f_866a1c71_ac_a622a229_canonical_json_omits_absent_skill_and_keeps_normalized_values() {
        // emit_outline이 프론트로 보내는 정규화 JSON — 앞뒤 공백·범위 보정이 반영되고,
        // 지침을 고르지 않았으면 skill 키가 없다.
        let raw = r#"{"title":" t ","sections":[{"heading":" 1. 개요 ","brief":"b","target_chars":10,"table":true}]}"#;
        let outline = parse_outline_response(raw).unwrap();
        let json: Value = serde_json::from_str(&serde_json::to_string(&outline).unwrap()).unwrap();
        assert_eq!(
            json,
            json!({
                "title": "t",
                "sections": [{ "heading": "1. 개요", "brief": "b", "target_chars": 200, "table": true }]
            })
        );
    }

    #[test]
    fn f_866a1c71_ac_a622a229_outline_schema_requires_title_sections_and_section_fields() {
        let schema = outline_schema();
        assert_eq!(schema["type"], "object");
        assert_eq!(schema["required"], json!(["title", "sections"]));
        let props = &schema["properties"];
        assert_eq!(props["title"]["type"], "string");
        assert_eq!(props["skill"]["type"], "string");
        assert_eq!(props["message"]["type"], "string");
        assert_eq!(props["sections"]["type"], "array");
        let item = &props["sections"]["items"];
        assert_eq!(item["type"], "object");
        assert_eq!(item["required"], json!(["heading", "brief", "target_chars", "table"]));
        assert_eq!(item["properties"]["heading"]["type"], "string");
        assert_eq!(item["properties"]["brief"]["type"], "string");
        assert_eq!(item["properties"]["target_chars"]["type"], "integer");
        assert_eq!(item["properties"]["table"]["type"], "boolean");
        // 개요 스키마는 본문 편집(edits)을 노출하지 않는다 — 개요 단계는 본문을 쓰지 않는다.
        assert!(props.get("edits").is_none());
    }
}
