/**
 * AI Agent 인라인 편집 — 프론트엔드 타입과 이벤트 배선(스펙 1장).
 *
 * 네이티브(Rust) `ai_*` 커맨드 및 `hop-ai-*` 이벤트와 짝을 이룬다. 타입은
 * Rust serde 직렬화 형태를 그대로 따른다:
 *  - DocumentContext: snake_case 키(serialize.rs)
 *  - 이벤트 payload: camelCase 키(mod.rs의 `rename_all = "camelCase"`)
 *  - Action Script JSON: snake_case 키(schema.rs)
 */

/** 직렬화된 콘텐츠 노드(스펙 2장). 현재 PR1은 문단만 직렬화한다. */
export interface ParagraphNode {
  type: 'paragraph';
  id: string;
  text: string;
  /** 휴리스틱으로 추정한 제목 수준(1~3). 글자 크기·굵기·번호 패턴 기반(F-0858f2). */
  heading?: number;
}

export type ContentNode = ParagraphNode;

/** 복제 가능한 최상위 양식 표 한 셀(serialize.rs FormCell). */
export interface FormCell {
  row: number;
  col: number;
  /** "label"(안내 칸 — 건드리지 말 것) | "input"(채울 빈 칸). */
  role: string;
  /** 현재 셀 내용(라벨 식별용). 입력칸이면 보통 빈 문자열. */
  text?: string;
}

/** 복제 대상 최상위 양식 표(serialize.rs FormTable, F-220afd). */
export interface FormTable {
  section: number;
  paragraph: number;
  control_index: number;
  rows: number;
  cols: number;
  cells: FormCell[];
}

/** docx 본문 인라인 이미지(Rust ai::docx::EntryImage serde 매핑, F-5dc6297e). */
export interface ResearchNoteImage {
  /** body_paragraphs의 몇 번째 단락 '뒤'에 넣을지(0=첫 단락 앞). */
  after_body_index: number;
  data_base64: string;
  ext: string;
  width_px: number;
  height_px: number;
}

/** 본문 데이터 표 한 개(Rust ai::docx::EntryTable serde 매핑). 셀에 중첩 표로 삽입. */
export interface ResearchNoteTable {
  /** body_paragraphs의 몇 번째 단락 '뒤'에 넣을지(0=첫 단락 앞). */
  after_body_index: number;
  rows: number;
  cols: number;
  /** 셀 텍스트(row-major, rows×cols). */
  cells: string[];
}

/** 연구노트 docx 한 항목(Rust ai::docx::EntryRecord serde 매핑, F-075bdb05/F-beb35fbb). */
export interface ResearchNoteEntry {
  title: string;
  /** 본문 단락(계층 불릿 Ÿ/1./–/□① 보존, 평탄화 금지). */
  body_paragraphs: string[];
  recorders: string[];
  confirmer: string;
  record_date: string;
  confirm_date: string;
  /** 본문 인라인 이미지(없으면 빈 배열). */
  images: ResearchNoteImage[];
  /** 본문 데이터 표(없으면 빈 배열). */
  body_tables?: ResearchNoteTable[];
}

/** 연구노트 목차 한 행. */
export interface ResearchNoteTocItem {
  no: string;
  title: string;
  date: string;
}

/** 표지(첫 페이지) 메타(Rust ai::docx::CoverMeta serde 매핑). 못 찾은 필드는 빈 값. */
export interface ResearchNoteCover {
  /** "관리번호 : RS-…" 줄 전체. */
  manage_no: string;
  org: string;
  dept: string;
  project: string;
  period: string;
  /** 연구책임자. */
  lead: string;
  /** 기록자 명단(번호 매김 값을 이름 리스트로 분해한 것). */
  recorders: string[];
}

/** docx에서 추출한 연구노트 구조 전체(Rust ai::docx::ResearchNoteDoc serde 매핑). */
export interface ResearchNoteDoc {
  entries: ResearchNoteEntry[];
  toc: ResearchNoteTocItem[];
  /** 표지 메타 — 표지 표를 못 찾았거나 PDF 경로면 없음(표지는 채우지 않음). */
  cover?: ResearchNoteCover | null;
}

export interface DocumentContext {
  document_metadata: {
    total_sections: number;
    current_cursor_path?: string;
    /** 복제 가능한 양식 표 목록(F-220afd). 비어 있으면 양식 표가 없는 일반 문서. */
    form_tables?: FormTable[];
  };
  content: ContentNode[];
}

export type EditCommand = 'INSERT_BEFORE' | 'INSERT_AFTER' | 'REPLACE' | 'DELETE';

/**
 * 문서 전역 편집을 가리키는 target_id 고정값(F-293e8c99). 문단 ID가 아니라 "문서 전체"다.
 * Rust `ai::schema::DOC_SCOPE_TARGET`과 같은 값이어야 한다.
 */
export const DOC_SCOPE_TARGET = 'doc';

export interface EditPayload {
  type?:
    | 'paragraph'
    | 'table'
    | 'image'
    | 'table_edit'
    | 'clone_table'
    | 'format'
    | 'chart'
    | 'replace_text'
    | 'table_formula'
    | 'footnote'
    | 'paste_html';
  text?: string;
  style?: string;
  /** type="image"일 때 삽입할 첨부 이미지의 0-기준 인덱스(첨부 순서). */
  image_index?: number;
  /** 이미지에서 잘라낼 영역(0~1 비율). PDF 페이지에서 그림만 잘라낼 때. */
  crop?: { x: number; y: number; w: number; h: number };
  /** INSERT 시 참이면 새 페이지에서 시작(본문 문단에만 적용). */
  page_break?: boolean;
  /** 다시쓰기 대안들(2~3개). 사용자가 여러 변형을 원할 때. text는 추천안(보통 첫 번째). */
  variations?: string[];
  /** 교정 패스에서만: 이 편집이 고치는 이슈 설명("분류: 설명", 분류=맞춤법/문법/어색한 표현/일관성). */
  reason?: string;
  table_data?: {
    rows: number;
    cols: number;
    matrix: string[][];
    /** 병합할 셀 영역(0-기준, 끝 포함). */
    merges?: { start_row: number; start_col: number; end_row: number; end_col: number }[];
    /** 열별 상대 폭 가중치(길이=cols). 긴 텍스트 열은 크게, 짧은 열은 작게. */
    col_weights?: number[];
  };
  /** type="chart"일 때: 차트 데이터(프런트가 캔버스로 PNG 렌더 후 그림으로 삽입). */
  chart_data?: {
    kind: 'bar' | 'line' | 'pie';
    title?: string;
    labels: string[];
    series: { name?: string; values: number[] }[];
  };
  /** type="format"일 때: 문단 안에서 서식을 바꿀 정확한 문자열(생략=문단 전체, 문단 내 유일해야 함). */
  format_target?: string;
  /** type="format"일 때: 적용할 글자 서식(바꿀 속성만). 텍스트 내용은 바뀌지 않는다. */
  char_format?: {
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    /** 글자 크기(pt). 적용 시 HWPUNIT(pt×100)으로 변환. */
    font_size_pt?: number;
    /** 글자 색 #RRGGBB. */
    text_color?: string;
  };
  /**
   * type="replace_text"일 때: 문서 전역 찾아 바꾸기(F-293e8c99). target_id는 `DOC_SCOPE_TARGET`.
   * 같은 문자열을 여러 문단에서 바꿀 때 문단별 REPLACE를 나열하는 대신 이 편집 하나를 쓴다.
   */
  replace_text?: {
    query: string;
    new_text: string;
    /** 대소문자 구분(기본 false). */
    case_sensitive?: boolean;
    /** 'all'=전부(기본) | 'first'=첫 건만. */
    scope?: 'all' | 'first';
  };
  /**
   * type="paste_html"일 때: HTML을 서식 유지한 채 넣는다(F-4f6d826e).
   * target_id는 본문 문단 ID 또는 최상위 표 셀 ID.
   */
  paste_html?: {
    /** 붙여넣을 HTML 조각. */
    html: string;
  };
  /**
   * type="footnote"일 때: 각주 달기/떼기(F-3e2d0f9a).
   * 달기 = 본문 문단 ID + REPLACE, 떼기 = 각주 ID + DELETE.
   * (payload.type 없이 각주 ID에 REPLACE 하면 기존처럼 '내용만' 고친다 — F-191fd6.)
   */
  footnote?: {
    /** 달 각주의 내용(달기에만 필요). */
    text?: string;
    /** 이 문자열 바로 뒤에 표식을 단다(생략=문단 끝). 문단 안에서 유일해야 한다. */
    anchor_text?: string;
  };
  /**
   * type="table_formula"일 때: 표 값을 엔진이 계산해 셀에 기입한다(F-8eb1f86f).
   * target_id는 그 표 안의 셀 ID. row/col은 0-기준이지만 formula의 셀 참조는 A1 표기다.
   */
  table_formula?: {
    /** 결과를 쓸 셀의 행(0-기준). */
    row: number;
    /** 결과를 쓸 셀의 열(0-기준). */
    col: number;
    /** 계산식. 예: '=SUM(B2:B5)'. */
    formula: string;
  };
  /** type="table_edit"일 때: 기존 표의 구조 편집(행/열 추가·삭제, 셀 병합). target_id는 그 표의 셀 ID. */
  table_edit?: {
    op: 'insert_row' | 'insert_col' | 'delete_row' | 'delete_col' | 'merge_cells' | 'split_cell';
    row?: number;
    col?: number;
    below?: boolean;
    right?: boolean;
    merge?: { start_row: number; start_col: number; end_row: number; end_col: number };
    /** split_cell: 셀을 몇 줄로 나눌지(기본 1). F-6daa56b3. */
    into_rows?: number;
    /** split_cell: 셀을 몇 칸으로 나눌지(기본 1). */
    into_cols?: number;
    /** split_cell: 나뉜 줄 높이를 균등하게(기본 true). */
    equal_row_height?: boolean;
    /** split_cell: 주면 이 범위 안의 셀들을 각각 into_rows×into_cols로 분할한다. */
    range?: { start_row: number; start_col: number; end_row: number; end_col: number };
    /** 새 행/열의 셀 텍스트(순서대로, 선택). */
    texts?: string[];
  };
  /**
   * type="clone_table"일 때: 반복 양식 표를 그대로 복제하고 입력칸만 채운다(F-220afd).
   * 새로 그리지 않으므로 행·열·병합·테두리가 원본과 100% 동일하다. command=INSERT_AFTER,
   * target_id는 새 항목을 넣을 본문 문단 ID.
   */
  clone_table?: {
    /** 복제할 원본 양식 표의 좌표(컨텍스트 document_metadata.form_tables에서 고름). */
    clone_from: { section: number; paragraph: number; control_index: number };
    /** 채울 입력칸들(0-기준 row/col). 라벨칸은 생략(원본 보존). text는 \n으로 여러 줄. */
    cell_fills?: { row: number; col: number; text: string }[];
    /**
     * 본문 통셀에 넣을 인라인 이미지(F-5dc6297e/Phase B). row/col=본문 셀 좌표,
     * after_para=셀 안 몇 번째 문단 뒤(채운 본문 단락 기준), data_base64=이미지 바이트.
     */
    body_images?: {
      row: number;
      col: number;
      after_para: number;
      data_base64: string;
      ext: string;
      width_px: number;
      height_px: number;
    }[];
    /**
     * 본문 통셀에 넣을 데이터 표(중첩 표). row/col=본문 셀 좌표, after_para=셀 안 몇 번째
     * 문단 뒤, rows/cols/cells=표 내용(row-major).
     */
    body_tables?: {
      row: number;
      col: number;
      after_para: number;
      rows: number;
      cols: number;
      cells: string[];
    }[];
    /**
     * 복제된 표의 데이터 행을 이 값으로 재구성한다(F-toc-chunk): 헤더 행(0)은 보존하고
     * 기존 데이터 행을 모두 지운 뒤 각 항목 = 한 행으로 채운다. 목차를 페이지 분량씩
     * 여러 표로 나눠 페이지마다 이어 보이게 할 때 쓴다(한 표 자동 페이지분할이 안 되는 경우).
     */
    toc_rows?: string[][];
  };
}

export interface Edit {
  command: EditCommand;
  target_id: string;
  payload: EditPayload;
}

export interface ActionScript {
  edits: Edit[];
  /** 사용자에게 보여줄 대화형 요약(AI가 무엇을 했는지). */
  message?: string;
}

/** `hop-ai-stream-delta` payload. */
export interface AiStreamDelta {
  requestId: string;
  partialText: string;
}

/** `hop-ai-edit-ready` payload. */
export interface AiEditReady {
  requestId: string;
  actionScriptJson: string;
}

/** `hop-ai-edit-failed` payload. */
export interface AiEditFailed {
  requestId: string;
  reason: string;
  code: AiFailureCode;
}

export type AiFailureCode =
  | 'PARSE_ERROR'
  | 'WHITELIST_VIOLATION'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PROVIDER_ERROR'
  | string;

export interface AiEventHandlers {
  onDelta?(delta: AiStreamDelta): void;
  onEditReady?(ready: AiEditReady): void;
  onEditFailed?(failed: AiEditFailed): void;
}

/** 정리(unlisten) 함수. */
export type AiEventUnsubscribe = () => void;

/**
 * `hop-ai-*` 이벤트를 구독한다. Tauri 런타임에서만 실제 리스너를 등록하고,
 * 반환된 함수를 호출하면 모두 해제한다.
 */
export async function listenAiEvents(
  handlers: AiEventHandlers,
): Promise<AiEventUnsubscribe> {
  const { listen } = await import('@tauri-apps/api/event');
  const unlisteners = await Promise.all([
    listen<AiStreamDelta>('hop-ai-stream-delta', (event) => handlers.onDelta?.(event.payload)),
    listen<AiEditReady>('hop-ai-edit-ready', (event) => handlers.onEditReady?.(event.payload)),
    listen<AiEditFailed>('hop-ai-edit-failed', (event) => handlers.onEditFailed?.(event.payload)),
  ]);
  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}

/** 실패 코드(스펙 7장)를 사용자에게 보여줄 한국어 메시지로 변환한다. */
export function interpretAiFailure(code: AiFailureCode): string {
  switch (code) {
    case 'PARSE_ERROR':
      return '편집 변환 실패: 정형화된 데이터를 수신하지 못했습니다.';
    case 'WHITELIST_VIOLATION':
      return '문서에 존재하지 않는 대상을 편집하려 했습니다. 다시 시도해 주세요.';
    case 'TIMEOUT':
      return '응답 시간이 초과되었습니다. 다시 시도해 주세요.';
    case 'CANCELLED':
      return '요청이 취소되었습니다.';
    case 'PROVIDER_ERROR':
      return 'AI 제공자 호출에 실패했습니다.';
    default:
      return '알 수 없는 오류가 발생했습니다.';
  }
}

/**
 * `hop-ai-edit-ready`의 `actionScriptJson` 문자열을 파싱한다. 형식이 어긋나면
 * `null`을 반환한다(휘발성 상태로만 두고 코어에는 적용하지 않는다).
 */
export function parseActionScript(json: string): ActionScript | null {
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== 'object' || !Array.isArray((value as ActionScript).edits)) {
      return null;
    }
    return value as ActionScript;
  } catch {
    return null;
  }
}

/** 양식 이어쓰기 응답(F-ae778890) — 내용 전용. 표/compose 구조는 일절 없다. */
export interface FormFillResponse {
  entries: {
    fields: { label: string; value: string }[];
    /**
     * 라벨 없는 '본문 통칸'에 넣을 단락들(F-86317c64). 연구노트처럼 제목·날짜 칸 외에
     * 내용 본문이 있는 양식에서만 온다. 원소 1개 = 문단 1개.
     */
    body?: string[];
  }[];
  message?: string;
}

/**
 * 양식 이어쓰기 응답 JSON({entries:[{fields:[{label,value}]}]})을 파싱한다. 형식이
 * 어긋나면 `null`. AI가 표 구조를 결정하지 못하도록 entries(라벨→값)만 받는다.
 */
export function parseFormFillResponse(json: string): FormFillResponse | null {
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== 'object' || !Array.isArray((value as FormFillResponse).entries)) {
      return null;
    }
    return value as FormFillResponse;
  } catch {
    return null;
  }
}
