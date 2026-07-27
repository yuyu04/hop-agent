/**
 * Action Script를 라이브 WASM 문서 엔진에 적용한다(스펙 4장 — 승인 시점).
 *
 * 화면 문서는 WASM rhwp 엔진이 그리므로, 승인된 편집은 이 엔진에 적용한 뒤
 * `eventBus.emit('document-changed')`로 재렌더한다(적용은 호출 측에서 트리거).
 * 여기서는 순수하게 편집 변환만 수행해 테스트 가능하게 한다.
 */

import type { ActionScript, Edit, ResearchNoteCover, ResearchNoteEntry } from './ai-bridge';
import { DEFAULT_COMPILED_THEME, type CompiledTheme } from './doc-theme';

/** `applyActionScript`가 의존하는 최소 WASM 편집 표면(WasmBridge가 구조적으로 충족). */
export interface WasmEditing {
  getParagraphLength(sec: number, para: number): number;
  insertText(sec: number, para: number, charOffset: number, text: string): string;
  deleteText(sec: number, para: number, charOffset: number, count: number): string;
  splitParagraph(sec: number, para: number, charOffset: number): string;
  mergeParagraph(sec: number, para: number): string;
  insertPageBreak(sec: number, para: number, charOffset: number): string;
  /** 표를 생성한다. 생성된 표가 놓인 문단/컨트롤 인덱스를 반환한다. */
  createTable(
    sec: number,
    para: number,
    charOffset: number,
    rows: number,
    cols: number,
  ): { ok: boolean; paraIdx: number; controlIdx: number };
  /** 표 셀 영역을 병합한다(0-기준 행/열, 끝 포함). */
  mergeTableCells(
    sec: number,
    parentPara: number,
    controlIdx: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): { ok: boolean; cellCount: number };
  // 최상위 표 셀 편집(플랫). by-path와 달리 셀 줄 재배치(reflow)를 수행해
  // 긴 텍스트가 줄바꿈되고 셀 높이가 늘어난다.
  getCellParagraphLength(
    sec: number,
    parentPara: number,
    controlIdx: number,
    cellIdx: number,
    cellParaIdx: number,
  ): number;
  insertTextInCell(
    sec: number,
    parentPara: number,
    controlIdx: number,
    cellIdx: number,
    cellParaIdx: number,
    charOffset: number,
    text: string,
  ): string;
  deleteTextInCell(
    sec: number,
    parentPara: number,
    controlIdx: number,
    cellIdx: number,
    cellParaIdx: number,
    charOffset: number,
    count: number,
  ): string;
  /** 셀/글상자 내부 문단 분할(플랫, reflow 수행). 글상자는 cellIdx가 무시된다. */
  splitParagraphInCell(
    sec: number,
    parentPara: number,
    controlIdx: number,
    cellIdx: number,
    cellParaIdx: number,
    charOffset: number,
  ): string;
  // 표 셀 편집(중첩 포함, 스펙 2장). pathJson은 `[{controlIndex,cellIndex,cellParaIndex}, …]`.
  getCellParagraphLengthByPath(sec: number, parentPara: number, pathJson: string): number;
  insertTextInCellByPath(
    sec: number,
    parentPara: number,
    pathJson: string,
    charOffset: number,
    text: string,
  ): string;
  splitParagraphInCellByPath(
    sec: number,
    parentPara: number,
    pathJson: string,
    charOffset: number,
  ): string;
  deleteTextInCellByPath(
    sec: number,
    parentPara: number,
    pathJson: string,
    charOffset: number,
    count: number,
  ): string;
  /** 누름틀(Field) 값 교체(F-10a6a5). 서식·구조는 템플릿 그대로 보존된다. */
  setFieldValue(
    fieldId: number,
    value: string,
  ): { ok: boolean; fieldId: number; oldValue: string; newValue: string };
  // 머리말/꼬리말 편집(F-191fd6). get*/create*는 JSON 문자열을 반환한다.
  getHeaderFooter(sec: number, isHeader: boolean, applyTo: number): string;
  createHeaderFooter(sec: number, isHeader: boolean, applyTo: number): string;
  getHeaderFooterParaInfo(sec: number, isHeader: boolean, applyTo: number, hfParaIdx: number): string;
  insertTextInHeaderFooter(
    sec: number,
    isHeader: boolean,
    applyTo: number,
    hfParaIdx: number,
    charOffset: number,
    text: string,
  ): string;
  deleteTextInHeaderFooter(
    sec: number,
    isHeader: boolean,
    applyTo: number,
    hfParaIdx: number,
    charOffset: number,
    count: number,
  ): string;
  splitParagraphInHeaderFooter(
    sec: number,
    isHeader: boolean,
    applyTo: number,
    hfParaIdx: number,
    charOffset: number,
  ): string;
  // 각주 텍스트 편집(F-191fd6). REPLACE/DELETE만 지원(문단 분할 API 미노출).
  getFootnoteInfo(
    sec: number,
    para: number,
    controlIdx: number,
  ): { ok: boolean; paraCount: number; totalTextLen: number; number: number; texts: string[] };
  insertTextInFootnote(
    sec: number,
    para: number,
    controlIdx: number,
    fnParaIdx: number,
    charOffset: number,
    text: string,
  ): { ok: boolean; charOffset: number };
  deleteTextInFootnote(
    sec: number,
    para: number,
    controlIdx: number,
    fnParaIdx: number,
    charOffset: number,
    count: number,
  ): { ok: boolean; charOffset: number };
  // 기존 표 구조 편집(F-7a3dbe). rhwp가 셀 내용을 보존하며 행/열을 넣고 뺀다.
  insertTableRow(
    sec: number,
    parentPara: number,
    controlIdx: number,
    rowIdx: number,
    below: boolean,
  ): { ok: boolean; rowCount: number; colCount: number };
  insertTableColumn(
    sec: number,
    parentPara: number,
    controlIdx: number,
    colIdx: number,
    right: boolean,
  ): { ok: boolean; rowCount: number; colCount: number };
  deleteTableRow(
    sec: number,
    parentPara: number,
    controlIdx: number,
    rowIdx: number,
  ): { ok: boolean; rowCount: number; colCount: number };
  deleteTableColumn(
    sec: number,
    parentPara: number,
    controlIdx: number,
    colIdx: number,
  ): { ok: boolean; rowCount: number; colCount: number };
  // 열 폭 조절용(선택). 표 생성 후 긴 텍스트 열을 넓혀 표가 세로로 덜 늘어나게 한다.
  // WasmBridge가 제공하지만 일부(테스트용) 브리지엔 없을 수 있어 optional.
  getTableProperties?(
    sec: number,
    parentPara: number,
    controlIdx: number,
  ): { tableWidth?: number };
  getTableCellBboxes?(
    sec: number,
    parentPara: number,
    controlIdx: number,
    pageHint?: number,
  ): Array<{ cellIdx: number; col: number; row: number; colSpan: number; w?: number; h?: number }>;
  setCellProperties?(
    sec: number,
    parentPara: number,
    controlIdx: number,
    cellIdx: number,
    props: { width?: number; fillType?: string; fillColor?: string; verticalAlign?: number },
  ): { ok: boolean };
  /** 셀 문단 서식 적용(정렬 등). propsJson 예: `{"alignment":"left"}`. */
  applyParaFormatInCell?(
    sec: number,
    parentPara: number,
    controlIdx: number,
    cellIdx: number,
    cellParaIdx: number,
    propsJson: string,
  ): string;
  /** 문서에 정의된 스타일 목록(한컴 F6 스타일 — 바탕글/개요1 등). */
  getStyleList?(): Array<{ id: number; name: string; englishName: string }>;
  /** 문단에 문서 스타일을 적용한다(Ctrl+숫자와 동일 — 글자+문단 모양 일괄). */
  applyStyle?(sec: number, para: number, styleId: number): { ok: boolean };
  /** 본문 문단의 글자 서식(굵게·크기·색 등)을 [start,end) 범위에 적용. propsJson은 CharProperties. */
  applyCharFormat?(sec: number, para: number, startOffset: number, endOffset: number, propsJson: string): string;
  /** 본문 문단의 [start,end) 텍스트를 읽는다(부분 서식의 대상 위치 탐색용). */
  getTextRange?(sec: number, para: number, startOffset: number, endOffset: number): string;
  /** 본문 문단의 문단 서식(정렬·줄간격·여백 등) 적용. propsJson은 ParaProperties. */
  applyParaFormat?(sec: number, para: number, propsJson: string): string;
  /** 셀 문단의 글자 서식을 [start,end) 범위에 적용(헤더 굵게 등). */
  applyCharFormatInCell?(
    sec: number,
    parentPara: number,
    controlIdx: number,
    cellIdx: number,
    cellParaIdx: number,
    startOffset: number,
    endOffset: number,
    propsJson: string,
  ): string;
  /**
   * 표 속성(쪽 나눔 등). pageBreak: 0=없음, 1=셀 단위, 2=행 단위.
   * treatAsChar=false + pageBreak=2 라야 표가 페이지 경계에서 행 단위로 분할된다
   * (글자처럼취급 표는 인라인이라 안 나뉘고 클립됨 — 목차 다페이지 분할에 필요).
   */
  setTableProperties?(
    sec: number,
    parentPara: number,
    controlIdx: number,
    props: { pageBreak?: number; treatAsChar?: boolean; textWrap?: string },
  ): { ok: boolean };
  /**
   * 표 문단과 쪽 나누기 문단 사이에 낀 빈 문단을 제거한다(한컴 빈 페이지 방지).
   * 양식 이어쓰기에서 표 복제 시 표 뒤에 남는 빈 문단이 페이지를 가득 채운 표 다음으로
   * 흘러 한컴에서 빈 페이지를 만든다 — 다음이 쪽 나누기라 불필요하므로 제거한다.
   */
  removeOrphanParasBeforePageBreaks?(sec: number): { removed: number };
  /**
   * 복제 원본인 빈 양식(샘플) 표 + 바로 뒤 쪽 나누기를 제거한다. 양식 이어쓰기는 원본
   * 표를 항목마다 복제하므로 원본이 빈 샘플로 남는다(보통 첫 항목 앞 페이지). 그 표만
   * 지우면(문단은 구역정의/머리말 보존) 뒤 쪽 나누기가 첫 항목을 다음 페이지로 밀고 빈
   * 페이지가 남으므로, 쪽 나누기도 함께 제거해 첫 항목이 첫 페이지에서 시작하게 한다.
   */
  removeSourceFormTable?(sec: number, para: number, controlIdx: number): { removedBreak: boolean };
  /**
   * 구역 끝 '마지막 표 뒤'에 남은 빈 문단들을 제거한다(문서 끝 빈 페이지 방지). 마지막
   * 항목 표가 페이지를 거의 꽉 채우므로 뒤에 남은 빈 문단 한 줄이 다음 페이지로 밀려
   * 끝 빈 페이지가 된다. 표 뒤에 보이는 내용이 있으면 아무것도 지우지 않는다.
   */
  trimTrailingParasAfterLastTable?(sec: number): { removed: number };
  /**
   * 항목 표 '바로 위'의 빈 선행 문단(구역/쪽 나눔 문단)을 최소 높이로 압축한다. 항목 표가
   * 페이지를 거의 꽉 채워 표 위 한 줄(~20px)이 한컴에서 표를 다음 페이지로 밀어내는 문제를
   * 막는다 — 빈 줄을 접어 표가 페이지 상단 가까이서 시작하게 한다. 반환: 압축한 문단 수.
   */
  compactLeadingParasBeforeTables?(sec: number): { compacted: number };
  /**
   * 컨트롤(표·그림·도형)을 내부 클립보드에 복제한다(F-220afd). 같은 문서 내 복제이므로
   * doc-로컬 ID(border_fill/char_shape/para_shape)가 그대로 유효해 구조가 100% 보존된다.
   * 반환: JSON 문자열 `{"ok":true,"text":"[표]"}` (WasmBridge가 파싱 없이 그대로 넘김).
   */
  copyControl?(sec: number, para: number, controlIdx: number): string;
  /**
   * 내부 클립보드의 컨트롤을 캐럿 위치에 붙여넣는다.
   * 반환: JSON 문자열 `{"ok":true,"paraIdx":<N>,"controlIdx":0}`.
   */
  pasteControl?(sec: number, para: number, charOffset: number): string;
  /** 내부 클립보드에 컨트롤(표/그림/도형)이 들어 있는지. */
  clipboardHasControl?(): boolean;
  /** 그림(이미지) 삽입. width/height는 표시 크기(HWPUNIT), natural*는 원본 픽셀. */
  insertPicture?(
    sec: number,
    paraIdx: number,
    charOffset: number,
    imageData: Uint8Array,
    width: number,
    height: number,
    naturalWidthPx: number,
    naturalHeightPx: number,
    extension: string,
    description?: string,
  ): { ok: boolean; paraIdx: number; controlIdx: number };
  /** 표 셀 안에 그림을 넣는다(F-5dc6297e/Phase B). 선택 — 없으면 그림 삽입을 생략. */
  insertPictureInCell?(
    sec: number,
    parentPara: number,
    controlIdx: number,
    cellIdx: number,
    cellParaIdx: number,
    imageData: Uint8Array,
    width: number,
    height: number,
    naturalWidthPx: number,
    naturalHeightPx: number,
    extension: string,
    description?: string,
  ): { ok: boolean };
  /** 표 셀 안에 중첩 표를 만들어 넣는다(본문 데이터 표). cellTextsJson=셀 텍스트 JSON 배열. */
  createTableInCell?(
    sec: number,
    parentPara: number,
    controlIdx: number,
    cellIdx: number,
    cellParaIdx: number,
    rows: number,
    cols: number,
    cellTextsJson: string,
  ): { ok: boolean };
}

/** 문서에 삽입할 이미지(첨부에서 디코드해 호출 측이 제공). */
export interface ImageForInsert {
  bytes: Uint8Array;
  /** 확장자(png/jpg/gif/bmp 등, 점 없이). */
  extension: string;
  naturalWidthPx: number;
  naturalHeightPx: number;
}

export interface ApplySkip {
  targetId: string;
  reason: string;
}

/** 적용 후 새로/바뀐 본문 문단의 최종 위치(녹색 변경 표시용). */
export interface ChangedPara {
  sec: number;
  para: number;
}

export interface ApplyResult {
  applied: number;
  skipped: ApplySkip[];
  /** 새로 추가·교체된 본문 문단의 최종 인덱스(셀/표 내부는 제외). */
  changed: ChangedPara[];
}

const TARGET_PATTERN = /^sec\[(\d+)\]\.p\[(\d+)\]$/;
const CELL_BASE_PATTERN = /^sec\[(\d+)\]\.p\[(\d+)\]((?:\.tbl\[\d+\]\.cell\[\d+\]\.p\[\d+\])+)$/;
const CELL_SEGMENT_PATTERN = /\.tbl\[(\d+)\]\.cell\[(\d+)\]\.p\[(\d+)\]/g;

/** `sec[s].p[p]` 형식의 문단 타깃을 파싱한다. 다른 형식이면 `null`. */
export function parseParagraphTarget(targetId: string): { sec: number; para: number } | null {
  const match = TARGET_PATTERN.exec(targetId);
  if (!match) return null;
  return { sec: Number(match[1]), para: Number(match[2]) };
}

/** 표 셀 경로 한 단계(by-path API의 JSON 항목). */
export interface CellPathEntry {
  controlIndex: number;
  cellIndex: number;
  cellParaIndex: number;
}

export interface CellTarget {
  sec: number;
  parentPara: number;
  /** 본문 → (중첩) 셀 문단까지의 경로. 길이 1=최상위 표, 2+=중첩 표. */
  path: CellPathEntry[];
}

/**
 * `sec[s].p[p].tbl[c].cell[k].p[i]`(+ 중첩 시 `.tbl[..].cell[..].p[..]` 반복) 형식의
 * 표 셀 타깃을 파싱한다. 다른 형식이면 `null`.
 */
export function parseCellTarget(targetId: string): CellTarget | null {
  const base = CELL_BASE_PATTERN.exec(targetId);
  if (!base) return null;
  const path: CellPathEntry[] = [];
  CELL_SEGMENT_PATTERN.lastIndex = 0;
  let seg: RegExpExecArray | null;
  while ((seg = CELL_SEGMENT_PATTERN.exec(base[3])) !== null) {
    path.push({
      controlIndex: Number(seg[1]),
      cellIndex: Number(seg[2]),
      cellParaIndex: Number(seg[3]),
    });
  }
  return { sec: Number(base[1]), parentPara: Number(base[2]), path };
}

/** `sec[s].header|footer[a].p[i]` 형식의 머리말/꼬리말 문단 타깃(F-191fd6). */
export interface HeaderFooterTarget {
  sec: number;
  isHeader: boolean;
  /** 적용 대상: 0=양쪽, 1=짝수, 2=홀수. */
  applyTo: number;
  paraIdx: number;
}

const HF_PATTERN = /^sec\[(\d+)\]\.(header|footer)\[(\d+)\]\.p\[(\d+)\]$/;

export function parseHeaderFooterTarget(targetId: string): HeaderFooterTarget | null {
  const m = HF_PATTERN.exec(targetId);
  if (!m) return null;
  return {
    sec: Number(m[1]),
    isHeader: m[2] === 'header',
    applyTo: Number(m[3]),
    paraIdx: Number(m[4]),
  };
}

/** `sec[s].p[p].fn[c].p[i]` 형식의 각주 문단 타깃(F-191fd6). */
export interface FootnoteTarget {
  sec: number;
  para: number;
  controlIdx: number;
  fnParaIdx: number;
}

const FN_PATTERN = /^sec\[(\d+)\]\.p\[(\d+)\]\.fn\[(\d+)\]\.p\[(\d+)\]$/;

export function parseFootnoteTarget(targetId: string): FootnoteTarget | null {
  const m = FN_PATTERN.exec(targetId);
  if (!m) return null;
  return {
    sec: Number(m[1]),
    para: Number(m[2]),
    controlIdx: Number(m[3]),
    fnParaIdx: Number(m[4]),
  };
}

/** `field[<id>:<이름>]` 형식의 누름틀 타깃(F-10a6a5). */
const FIELD_PATTERN = /^field\[(\d+):/;

export function parseFieldTarget(targetId: string): { fieldId: number } | null {
  const m = FIELD_PATTERN.exec(targetId);
  return m ? { fieldId: Number(m[1]) } : null;
}

type LocatedEdit =
  | { kind: 'body'; edit: Edit; sec: number; para: number; order: number }
  | { kind: 'cell'; edit: Edit; cell: CellTarget; order: number }
  | { kind: 'hf'; edit: Edit; hf: HeaderFooterTarget; order: number }
  | { kind: 'fn'; edit: Edit; fn: FootnoteTarget; order: number }
  | { kind: 'field'; edit: Edit; fieldId: number; order: number };

function locatedSec(item: LocatedEdit): number {
  if (item.kind === 'body') return item.sec;
  if (item.kind === 'cell') return item.cell.sec;
  if (item.kind === 'hf') return item.hf.sec;
  if (item.kind === 'field') return 0;
  return item.fn.sec;
}
function locatedPara(item: LocatedEdit): number {
  if (item.kind === 'body') return item.para;
  if (item.kind === 'cell') return item.cell.parentPara;
  // 머리말/꼬리말·누름틀은 본문 인덱스와 무관 — 항상 마지막에 적용되도록 -1.
  if (item.kind === 'hf' || item.kind === 'field') return -1;
  return item.fn.para;
}

/**
 * Action Script의 각 편집을 WASM 편집 프리미티브로 변환·적용한다.
 *
 * 다중 편집은 문단 인덱스가 큰 것부터(내림차순) 적용해, 앞선 편집의 문단
 * 삽입/삭제가 뒤따르는 `target_id`의 인덱스를 어긋나게 만들지 않도록 한다.
 */
export function applyActionScript(
  wasm: WasmEditing,
  script: ActionScript,
  images: ImageForInsert[] = [],
  theme?: CompiledTheme,
): ApplyResult {
  activeTheme = theme ?? DEFAULT_COMPILED_THEME;
  const located: LocatedEdit[] = [];
  const skipped: ApplySkip[] = [];

  script.edits.forEach((edit, order) => {
    // INSERT/REPLACE는 새 텍스트가 반드시 있어야 한다. text가 비면 적용 시 원문이
    // 빈 문단으로 지워지므로(조용한 내용 손실), 적용하지 않고 건너뛴다.
    // 표 생성(type="table")·이미지 삽입(type="image")은 text가 없어도 되므로 예외다.
    const needsText =
      edit.command !== 'DELETE' &&
      !isTableEdit(edit) &&
      !isImageEdit(edit) &&
      !isCloneTableEdit(edit) &&
      !isTableStructEdit(edit) &&
      !isFormatEdit(edit);
    if (needsText && (edit.payload.text ?? '') === '') {
      skipped.push({
        targetId: edit.target_id,
        reason: '새 텍스트(payload.text)가 비어 있어 건너뜀 — 모델이 본문을 채우지 못했습니다.',
      });
      return;
    }

    const cell = parseCellTarget(edit.target_id);
    if (cell) {
      // 부분 서식은 본문 문단 전용(셀 텍스트 읽기 API가 없어 대상 탐색 불가).
      if (isFormatEdit(edit)) {
        skipped.push({
          targetId: edit.target_id,
          reason: '부분 서식(format)은 본문 문단만 지원합니다(표 셀 내부는 아직 불가).',
        });
        return;
      }
      // 표 셀 안에는 표/이미지/복제표를 넣지 않는다(셀은 페이지로 늘어나지 않음). 본문에 넣는다.
      if (isTableEdit(edit) || isImageEdit(edit) || isCloneTableEdit(edit)) {
        skipped.push({
          targetId: edit.target_id,
          reason: '표 셀 안에는 표·이미지를 넣을 수 없습니다. 표 바깥 본문 문단에 INSERT 하세요.',
        });
        return;
      }
      located.push({ kind: 'cell', edit, cell, order });
      return;
    }

    const field = parseFieldTarget(edit.target_id);
    if (field) {
      if (edit.command !== 'REPLACE' && edit.command !== 'DELETE') {
        skipped.push({
          targetId: edit.target_id,
          reason: '누름틀은 값 교체(REPLACE)·비우기(DELETE)만 가능합니다.',
        });
        return;
      }
      located.push({ kind: 'field', edit, fieldId: field.fieldId, order });
      return;
    }

    const hf = parseHeaderFooterTarget(edit.target_id);
    if (hf) {
      if (isTableEdit(edit) || isImageEdit(edit) || isTableStructEdit(edit) || isFormatEdit(edit)) {
        skipped.push({
          targetId: edit.target_id,
          reason: '머리말/꼬리말에는 텍스트 편집(REPLACE/DELETE/INSERT)만 가능합니다.',
        });
        return;
      }
      located.push({ kind: 'hf', edit, hf, order });
      return;
    }

    const footnote = parseFootnoteTarget(edit.target_id);
    if (footnote) {
      if (edit.command !== 'REPLACE' && edit.command !== 'DELETE') {
        skipped.push({
          targetId: edit.target_id,
          reason: '각주는 내용 수정(REPLACE)·비우기(DELETE)만 지원합니다.',
        });
        return;
      }
      located.push({ kind: 'fn', edit, fn: footnote, order });
      return;
    }

    const target = parseParagraphTarget(edit.target_id);
    if (!target) {
      skipped.push({
        targetId: edit.target_id,
        reason: '문단/표 셀 대상이 아닙니다.',
      });
      return;
    }
    if (isTableStructEdit(edit)) {
      skipped.push({
        targetId: edit.target_id,
        reason: '표 구조 편집(table_edit)은 그 표 안의 셀 ID를 target_id로 지정해야 합니다.',
      });
      return;
    }
    located.push({ kind: 'body', edit, sec: target.sec, para: target.para, order });
  });

  // 문단 인덱스가 큰 것부터 적용해, 앞선 편집이 뒤 target의 인덱스를 어긋나게
  // 만들지 않도록 한다. 같은 문단에 여러 INSERT_AFTER가 있으면 입력 역순으로
  // 적용해야 문서에 입력 순서대로(정순) 남는다(split→insert가 매번 앞에 끼우므로).
  // 단, 표 구조 편집(table_edit)끼리는 입력 정순 — 행/열 인덱스가 앞 편집의 결과를
  // 기준으로 누적되기 때문(예: 행 추가 후 그 아래 행 삭제).
  located.sort((a, b) => {
    const byPos =
      locatedSec(b) - locatedSec(a) || locatedPara(b) - locatedPara(a);
    if (byPos !== 0) return byPos;
    if (isTableStructEdit(a.edit) && isTableStructEdit(b.edit)) return a.order - b.order;
    // 누름틀도 입력 정순 — 같은 필드를 여러 번 만지면 마지막 지시가 남는다.
    if (a.kind === 'field' && b.kind === 'field') return a.order - b.order;
    return b.order - a.order;
  });

  // 본문 INSERT/REPLACE의 최종 위치를 추적한다. 적용 순서(내림차순)에서 낮은
  // 문단에 삽입이 일어나면 이미 기록된(더 높은) 위치를 +1 밀어 정합을 유지한다.
  const changed: ChangedPara[] = [];
  const shiftFrom = (sec: number, fromPara: number, by = 1) => {
    for (const c of changed) if (c.sec === sec && c.para >= fromPara) c.para += by;
  };

  let applied = 0;
  for (const item of located) {
    try {
      if (item.kind === 'cell') {
        if (isTableStructEdit(item.edit)) applyTableEdit(wasm, item.edit, item.cell);
        else applyOneCell(wasm, item.edit, item.cell);
      } else if (item.kind === 'field') {
        // 누름틀 값만 교체 — 서식·구조는 템플릿 그대로(F-10a6a5).
        const result = wasm.setFieldValue(
          item.fieldId,
          item.edit.command === 'DELETE' ? '' : (item.edit.payload.text ?? ''),
        );
        if (!result.ok) throw new Error('누름틀을 찾지 못했습니다.');
      } else if (item.kind === 'hf') {
        applyOneHeaderFooter(wasm, item.edit, item.hf);
      } else if (item.kind === 'fn') {
        applyOneFootnote(wasm, item.edit, item.fn);
      } else if (isFormatEdit(item.edit)) {
        // 부분 서식 — 텍스트는 그대로, 지정 범위 런에만 글자 서식을 입힌다.
        applyFormatEdit(wasm, item.edit, item.sec, item.para);
        changed.push({ sec: item.sec, para: item.para });
      } else {
        // extra = 다줄 분할로 첫 결과 문단 외에 추가된 문단 수(\n 없으면 0).
        const extra = applyOne(wasm, item, images);
        const { sec, para, edit } = item;
        if (edit.command === 'INSERT_AFTER') {
          // para+1..para+1+extra 에 총 (1+extra)개 문단이 끼어든다.
          shiftFrom(sec, para + 1, 1 + extra);
          for (let i = 0; i <= extra; i += 1) changed.push({ sec, para: para + 1 + i });
        } else if (edit.command === 'INSERT_BEFORE') {
          shiftFrom(sec, para, 1 + extra);
          for (let i = 0; i <= extra; i += 1) changed.push({ sec, para: para + i });
        } else if (edit.command === 'REPLACE') {
          // 원문 문단은 제자리, 그 뒤에 extra개 새 문단이 추가된다.
          if (extra > 0) shiftFrom(sec, para + 1, extra);
          for (let i = 0; i <= extra; i += 1) changed.push({ sec, para: para + i });
        }
      }
      applied += 1;
    } catch (error) {
      skipped.push({ targetId: item.edit.target_id, reason: String(error) });
    }
  }

  return { applied, skipped, changed };
}

/**
 * 의미 기반(semantic) 문단 스타일 → 글자/문단 서식 매핑. AI는 payload.style에 역할만
 * 지정하고(title/heading/…), 실제 폰트 크기·정렬·간격은 여기서 일관되게 적용한다.
 * fontSize는 HWPUNIT(1pt=100). 색/크기는 과하지 않게 — 깔끔한 문서 톤.
 */
// 시각 수치(간격·크기·색)는 하드코딩하지 않고 테마(core/doc-theme)가 결정한다.
// applyActionScript 진입 시 호출 측이 고른 테마로 설정된다(JS 단일 스레드라 안전).
let activeTheme: CompiledTheme = DEFAULT_COMPILED_THEME;

/** 테마가 지정한 '문서 스타일 이름'을 문서 스타일 목록에서 찾아 적용한다. 성공 시 true. */
function applyNamedDocStyle(wasm: WasmEditing, sec: number, para: number, styleName: string): boolean {
  if (!wasm.getStyleList || !wasm.applyStyle) return false;
  try {
    const wanted = styleName.replace(/\s+/g, '');
    const match = wasm
      .getStyleList()
      .find((s) => s.name.replace(/\s+/g, '') === wanted || s.englishName.replace(/\s+/g, '') === wanted);
    if (!match) return false;
    return wasm.applyStyle(sec, para, match.id).ok === true;
  } catch {
    return false;
  }
}

/** 삽입된 본문 문단(sec,para)의 [0,len)에 semantic 스타일을 적용한다. 미지정·미지원이면 무시. */
function applyParaStyle(wasm: WasmEditing, sec: number, para: number, text: string, style?: string): void {
  if (!style) return;
  const spec = activeTheme.styles[style];
  if (!spec) return;
  // 테마가 문서 스타일 이름을 지정했고 문서에 존재하면 그 스타일을 통째로 적용 —
  // 한컴 스타일 시스템을 그대로 타므로 문서 전체와 디자인이 일치한다. 못 찾으면 수치 폴백.
  if (spec.styleName && applyNamedDocStyle(wasm, sec, para, spec.styleName)) return;
  const len = [...text].length;
  try {
    if (spec.char && len > 0 && wasm.applyCharFormat) {
      wasm.applyCharFormat(sec, para, 0, len, JSON.stringify(spec.char));
    }
    if (spec.para && wasm.applyParaFormat) {
      wasm.applyParaFormat(sec, para, JSON.stringify(spec.para));
    }
  } catch {
    /* 서식 적용 실패는 무시 — 텍스트 내용은 이미 들어갔다. */
  }
}

/**
 * 채우기 텍스트를 줄(\n) 단위로 나눈다. \n이 없으면 길이 1 배열(기존 단일 경로).
 * 빈 줄(\n\n)도 빈 문자열로 보존해 빈 문단이 되게 한다(AC-dcebbb).
 */
function splitLines(text: string): string[] {
  return text.split('\n');
}

/**
 * 본문 문단 `firstPara`부터 여러 줄을 각각 별도 문단으로 채운다. 첫 줄은 이미
 * (호출 측이) 빈 문단으로 만들어 둔 `firstPara`에 넣고, 이후 줄마다 문단 끝에서
 * 분할해 새 문단에 넣는다. 각 파생 문단에 동일 style을 적용해 서식을 상속한다.
 * 반환값은 첫 줄 외에 추가로 만든 문단 수(lines.length - 1).
 */
function fillBodyLines(
  wasm: WasmEditing,
  sec: number,
  firstPara: number,
  lines: string[],
  style: string | undefined,
): number {
  for (let i = 0; i < lines.length; i += 1) {
    const para = firstPara + i;
    if (i > 0) {
      // 직전 문단 끝에서 분할 → 새 빈 문단(para)을 만든다.
      const prevLen = wasm.getParagraphLength(sec, firstPara + i - 1);
      wasm.splitParagraph(sec, firstPara + i - 1, prevLen);
    }
    if (lines[i]) wasm.insertText(sec, para, 0, lines[i]);
    applyParaStyle(wasm, sec, para, lines[i], style);
  }
  return lines.length - 1;
}

/**
 * 본문 편집을 적용한다. INSERT/REPLACE에서 텍스트에 \n이 있으면 줄마다 별도
 * 문단으로 분할 삽입한다(AC-dcebbb). 반환값은 첫 결과 문단 외에 추가로 생성된
 * 문단 수 — 호출 측 changed/shiftFrom 정합 유지에 쓴다(0이면 기존과 동일).
 */
function applyOne(
  wasm: WasmEditing,
  { edit, sec, para }: { edit: Edit; sec: number; para: number },
  images: ImageForInsert[],
): number {
  const text = edit.payload.text ?? '';
  const pageBreak = edit.payload.page_break === true;
  const lines = splitLines(text);
  switch (edit.command) {
    case 'INSERT_AFTER': {
      const length = wasm.getParagraphLength(sec, para);
      wasm.splitParagraph(sec, para, length);
      if (isCloneTableEdit(edit)) {
        cloneTableAt(wasm, sec, para + 1, edit);
        // 복제 표를 새 페이지에서 시작시킨다(1항목=1페이지, 빈 페이지 없음 — F-32a1a7d2).
        // 쪽나누기는 표 '앞' 앵커 문단 끝(para,length)에 넣는다: insert_page_break_native는
        // 대상 문단을 split_at해 그 '뒤'에 쪽나누기 빈 문단을 만들고 컨트롤(표)은 원본에 남긴다.
        // 따라서 표 문단(para+1)에 직접 넣으면 쪽나누기가 표 '뒤'로 가 빈 페이지가 생긴다(v5/v7
        // 실측). 앵커(para)에 넣으면 쪽나누기 문단이 표 '앞'에 와 표가 새 페이지 머리에서 시작한다.
        if (pageBreak) wasm.insertPageBreak(sec, para, length);
        return 0;
      }
      if (isTableEdit(edit)) {
        createTableAt(wasm, sec, para + 1, edit);
      } else if (isImageEdit(edit)) {
        insertImageAt(wasm, sec, para + 1, edit, images);
      } else {
        // 새 문단은 style 미지정 시 body 기본 — 미적용 시 문단 간격 0으로 빽빽해진다.
        const extra = fillBodyLines(wasm, sec, para + 1, lines, edit.payload.style ?? 'body');
        // 새 문단을 새 페이지에서 시작(긴 새 내용/새 절 추가용).
        if (pageBreak) wasm.insertPageBreak(sec, para + 1, 0);
        return extra;
      }
      // 새 문단을 새 페이지에서 시작(긴 새 내용/새 절 추가용).
      if (pageBreak) wasm.insertPageBreak(sec, para + 1, 0);
      return 0;
    }
    case 'INSERT_BEFORE': {
      // 오프셋 0에서 분할하면 빈 문단이 para 위치에 생기고 원문은 para+1로 밀린다.
      wasm.splitParagraph(sec, para, 0);
      if (isTableEdit(edit)) {
        createTableAt(wasm, sec, para, edit);
      } else if (isImageEdit(edit)) {
        insertImageAt(wasm, sec, para, edit, images);
      } else {
        const extra = fillBodyLines(wasm, sec, para, lines, edit.payload.style ?? 'body');
        if (pageBreak) wasm.insertPageBreak(sec, para, 0);
        return extra;
      }
      if (pageBreak) wasm.insertPageBreak(sec, para, 0);
      return 0;
    }
    case 'REPLACE': {
      const length = wasm.getParagraphLength(sec, para);
      if (length > 0) wasm.deleteText(sec, para, 0, length);
      return fillBodyLines(wasm, sec, para, lines, edit.payload.style);
    }
    case 'DELETE': {
      const length = wasm.getParagraphLength(sec, para);
      if (length > 0) wasm.deleteText(sec, para, 0, length);
      // 문단 경계를 이웃과 병합해 빈 문단을 제거한다.
      wasm.mergeParagraph(sec, para > 0 ? para : 1);
      return 0;
    }
  }
  return 0;
}

/**
 * 표 셀 문단에 편집을 적용한다(REPLACE = 값 변경, DELETE = 값 비우기).
 *
 * 셀의 문단 구조는 건드리지 않고 텍스트만 교체한다 — 표 행/열 구조 변경(문단
 * 삽입·삭제)은 호출 측에서 INSERT를 미리 건너뛰므로 여기 들어오지 않는다.
 */
/** INSERT로 표를 생성하는 편집인지(payload.type="table" + table_data). */
function isTableEdit(edit: Edit): boolean {
  return (
    (edit.command === 'INSERT_AFTER' || edit.command === 'INSERT_BEFORE') &&
    edit.payload.type === 'table' &&
    !!edit.payload.table_data &&
    edit.payload.table_data.rows > 0 &&
    edit.payload.table_data.cols > 0
  );
}

/** 양식 표 복제 편집인지(payload.type="clone_table" + clone_from). F-220afd. */
function isCloneTableEdit(edit: Edit): boolean {
  return (
    edit.command === 'INSERT_AFTER' &&
    edit.payload.type === 'clone_table' &&
    !!edit.payload.clone_table?.clone_from
  );
}

/** INSERT로 이미지를 넣는 편집인지(payload.type="image" + image_index). */
function isImageEdit(edit: Edit): boolean {
  return (
    (edit.command === 'INSERT_AFTER' || edit.command === 'INSERT_BEFORE') &&
    edit.payload.type === 'image' &&
    typeof edit.payload.image_index === 'number'
  );
}

/**
 * 머리말/꼬리말 문단 편집(F-191fd6). 존재하지 않으면 먼저 생성한다(placeholder를
 * REPLACE/INSERT한 경우 — AC3). rhwp가 모든 페이지에 반영·리플로우한다.
 */
function applyOneHeaderFooter(wasm: WasmEditing, edit: Edit, t: HeaderFooterTarget): void {
  const { sec, isHeader, applyTo, paraIdx } = t;
  const text = edit.payload.text ?? '';
  const exists =
    (JSON.parse(wasm.getHeaderFooter(sec, isHeader, applyTo)) as { exists?: boolean }).exists ===
    true;
  if (!exists) {
    if (edit.command === 'DELETE') return; // 없는 머리말 비우기 — 할 일 없음.
    wasm.createHeaderFooter(sec, isHeader, applyTo); // 빈 문단 1개로 생성.
  }
  const info = JSON.parse(wasm.getHeaderFooterParaInfo(sec, isHeader, applyTo, paraIdx)) as {
    paraCount?: number;
    charCount?: number;
  };
  const paraCount = info.paraCount ?? 0;
  if (paraIdx >= paraCount) {
    throw new Error(`머리말/꼬리말 문단 ${paraIdx} 범위 초과(총 ${paraCount}개)`);
  }
  const length = info.charCount ?? 0;
  switch (edit.command) {
    case 'REPLACE':
      if (length > 0) wasm.deleteTextInHeaderFooter(sec, isHeader, applyTo, paraIdx, 0, length);
      wasm.insertTextInHeaderFooter(sec, isHeader, applyTo, paraIdx, 0, text);
      break;
    case 'DELETE':
      if (length > 0) wasm.deleteTextInHeaderFooter(sec, isHeader, applyTo, paraIdx, 0, length);
      break;
    case 'INSERT_AFTER':
      wasm.splitParagraphInHeaderFooter(sec, isHeader, applyTo, paraIdx, length);
      wasm.insertTextInHeaderFooter(sec, isHeader, applyTo, paraIdx + 1, 0, text);
      break;
    case 'INSERT_BEFORE':
      wasm.splitParagraphInHeaderFooter(sec, isHeader, applyTo, paraIdx, 0);
      wasm.insertTextInHeaderFooter(sec, isHeader, applyTo, paraIdx, 0, text);
      break;
  }
}

/**
 * 각주 문단 내용 수정/비우기(F-191fd6). 분할 API가 없어 REPLACE/DELETE만.
 * 문단 끝의 공백 표시 문자(자동번호 컨트롤이 텍스트로는 공백으로 보인다)는 지우지
 * 않고 보존한다 — 전부 지우면 각주 번호 표식이 사라질 수 있다.
 */
function applyOneFootnote(wasm: WasmEditing, edit: Edit, t: FootnoteTarget): void {
  const info = wasm.getFootnoteInfo(t.sec, t.para, t.controlIdx);
  if (!info.ok) throw new Error('각주를 찾을 수 없습니다.');
  if (t.fnParaIdx >= info.texts.length) {
    throw new Error(`각주 문단 ${t.fnParaIdx} 범위 초과(총 ${info.texts.length}개)`);
  }
  const chars = Array.from(info.texts[t.fnParaIdx] ?? '');
  let deleteCount = chars.length;
  while (deleteCount > 0 && chars[deleteCount - 1] === ' ') deleteCount -= 1;
  if (deleteCount > 0) {
    wasm.deleteTextInFootnote(t.sec, t.para, t.controlIdx, t.fnParaIdx, 0, deleteCount);
  }
  if (edit.command === 'REPLACE') {
    wasm.insertTextInFootnote(t.sec, t.para, t.controlIdx, t.fnParaIdx, 0, edit.payload.text ?? '');
  }
}

/** 기존 표 구조 편집(행/열 추가·삭제, 셀 병합 — F-7a3dbe). target은 그 표의 셀 ID. */
function isTableStructEdit(edit: Edit): boolean {
  return edit.payload.type === 'table_edit' && !!edit.payload.table_edit;
}

/** 런 단위 부분 서식(F-04a91c) — 텍스트는 그대로 두고 글자 서식만 바꾼다. */
function isFormatEdit(edit: Edit): boolean {
  return edit.payload.type === 'format' && !!edit.payload.char_format;
}

/** 표시용 — 앞 30자만, 길면 말줄임표. */
function preview(text: string): string {
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

/** 문자 배열에서 부분 문자열(문자 배열)의 시작 인덱스를 찾는다(없으면 -1). */
function indexOfChars(haystack: string[], needle: string[], from = 0): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * 본문 문단의 [format_target] 범위(생략 시 문단 전체)에 글자 서식을 적용한다.
 * rhwp 오프셋은 문자 단위라 Array.from으로 센다. 대상이 없거나 문단에 여러 번
 * 나타나면 오류를 던져 skipped(사유)로 보고되게 한다(AC4 — 모호하면 적용 금지).
 */
function applyFormatEdit(wasm: WasmEditing, edit: Edit, sec: number, para: number): void {
  if (!wasm.applyCharFormat || !wasm.getTextRange) {
    throw new Error('이 환경에서는 부분 서식 편집을 지원하지 않습니다.');
  }
  const spec = edit.payload.char_format!;
  const length = wasm.getParagraphLength(sec, para);
  const target = (edit.payload.format_target ?? '').trim();
  let start = 0;
  let end = length;
  if (target) {
    const chars = Array.from(wasm.getTextRange(sec, para, 0, length));
    const needle = Array.from(target);
    const first = indexOfChars(chars, needle);
    if (first < 0) {
      throw new Error(`문단에서 대상 문자열을 찾지 못했습니다: "${preview(target)}"`);
    }
    if (indexOfChars(chars, needle, first + 1) >= 0) {
      throw new Error(
        `대상 문자열이 문단에 여러 번 나타나 적용하지 않았습니다(더 길게 지정하세요): "${preview(target)}"`,
      );
    }
    start = first;
    end = first + needle.length;
  }
  if (end <= start) {
    throw new Error('서식을 적용할 텍스트가 없습니다(빈 문단).');
  }
  const props: Record<string, unknown> = {};
  if (spec.bold !== undefined) props.bold = spec.bold;
  if (spec.italic !== undefined) props.italic = spec.italic;
  if (spec.underline !== undefined) props.underline = spec.underline;
  if (spec.strikethrough !== undefined) props.strikethrough = spec.strikethrough;
  if (typeof spec.font_size_pt === 'number' && spec.font_size_pt > 0) {
    props.fontSize = Math.round(spec.font_size_pt * 100); // pt → HWPUNIT
  }
  if (spec.text_color) props.textColor = spec.text_color;
  if (!Object.keys(props).length) {
    throw new Error('char_format에 적용할 속성이 없습니다.');
  }
  wasm.applyCharFormat(sec, para, start, end, JSON.stringify(props));
}

/**
 * 기존 표의 구조를 편집한다. rhwp 네이티브가 셀 내용을 보존하며 행/열을 넣고 빼고,
 * 잘못된 범위·기존 병합과의 부분 겹침은 rhwp가 오류로 거부한다(→ skipped로 보고,
 * 문서는 바뀌지 않는다). 최상위 표(경로 1단계)만 지원한다.
 */
function applyTableEdit(wasm: WasmEditing, edit: Edit, c: CellTarget): void {
  const spec = edit.payload.table_edit!;
  if (c.path.length !== 1) {
    throw new Error('중첩 표의 구조 편집은 지원하지 않습니다(최상위 표 셀 ID를 지정하세요).');
  }
  const { controlIndex: ci } = c.path[0];
  const requireIdx = (value: number | undefined, name: string): number => {
    if (typeof value !== 'number' || value < 0) {
      throw new Error(`table_edit.${name}이(가) 필요합니다(0-기준 정수).`);
    }
    return value;
  };
  switch (spec.op) {
    case 'insert_row': {
      const row = requireIdx(spec.row, 'row');
      const below = spec.below ?? true;
      wasm.insertTableRow(c.sec, c.parentPara, ci, row, below);
      fillNewTableLine(wasm, c.sec, c.parentPara, ci, 'row', below ? row + 1 : row, spec.texts);
      break;
    }
    case 'insert_col': {
      const col = requireIdx(spec.col, 'col');
      const right = spec.right ?? true;
      wasm.insertTableColumn(c.sec, c.parentPara, ci, col, right);
      fillNewTableLine(wasm, c.sec, c.parentPara, ci, 'col', right ? col + 1 : col, spec.texts);
      break;
    }
    case 'delete_row':
      wasm.deleteTableRow(c.sec, c.parentPara, ci, requireIdx(spec.row, 'row'));
      break;
    case 'delete_col':
      wasm.deleteTableColumn(c.sec, c.parentPara, ci, requireIdx(spec.col, 'col'));
      break;
    case 'merge_cells': {
      const m = spec.merge;
      if (!m) throw new Error('table_edit.merge(병합 범위)가 필요합니다.');
      wasm.mergeTableCells(c.sec, c.parentPara, ci, m.start_row, m.start_col, m.end_row, m.end_col);
      break;
    }
    default:
      throw new Error(`지원하지 않는 표 편집 동작입니다: ${String(spec.op)}`);
  }
}

/** 새로 삽입된 행/열의 셀들에 texts를 순서대로 채운다(셀 위치는 bbox로 정확히 찾는다). */
function fillNewTableLine(
  wasm: WasmEditing,
  sec: number,
  parentPara: number,
  controlIdx: number,
  axis: 'row' | 'col',
  index: number,
  texts: string[] | undefined,
): void {
  if (!texts?.length || !wasm.getTableCellBboxes) return;
  let boxes: Array<{ cellIdx: number; col: number; row: number; colSpan: number }>;
  try {
    boxes = wasm.getTableCellBboxes(sec, parentPara, controlIdx);
  } catch {
    return; // 좌표 조회 실패 — 구조 편집은 이미 성공했으므로 채우기만 생략.
  }
  const line = boxes
    .filter((b) => (axis === 'row' ? b.row === index : b.col === index))
    .sort((a, b) => (axis === 'row' ? a.col - b.col : a.row - b.row));
  line.forEach((b, i) => {
    const text = texts[i];
    if (text) wasm.insertTextInCell(sec, parentPara, controlIdx, b.cellIdx, 0, 0, text);
  });
}

/** `sec[para]`(분할로 생긴 빈 문단)에 첨부 이미지를 그림으로 삽입한다. */
function insertImageAt(
  wasm: WasmEditing,
  sec: number,
  para: number,
  edit: Edit,
  images: ImageForInsert[],
): void {
  const idx = edit.payload.image_index ?? -1;
  const img = images[idx];
  if (!img) throw new Error(`첨부 이미지 #${idx}를 찾을 수 없습니다.`);
  if (!wasm.insertPicture) throw new Error('이미지 삽입을 지원하지 않는 환경입니다.');

  // 원본 픽셀 → HWPUNIT(96dpi 기준 1px = 75 HWPUNIT), 본문 폭(~148mm)으로 상한.
  const PX_TO_HU = 7200 / 96;
  const MAX_W = 42000; // ≈ A4 본문 가로폭
  const natW = Math.max(1, img.naturalWidthPx);
  const natH = Math.max(1, img.naturalHeightPx);
  let w = Math.round(natW * PX_TO_HU);
  let h = Math.round(natH * PX_TO_HU);
  if (w > MAX_W) {
    h = Math.round((h * MAX_W) / w);
    w = MAX_W;
  }
  wasm.insertPicture(sec, para, 0, img.bytes, w, h, natW, natH, img.extension, edit.payload.text ?? '');
}

/**
 * 병합 영역에 가려지는 셀(대표=좌상단 셀 제외)의 행 우선 인덱스 집합.
 * 표 생성 시 이 셀들엔 텍스트를 넣지 않아 병합 후 텍스트 중복을 막는다.
 */
function coveredCellIndices(
  merges: NonNullable<Edit['payload']['table_data']>['merges'],
  cols: number,
): Set<number> {
  const covered = new Set<number>();
  for (const m of merges ?? []) {
    for (let r = m.start_row; r <= m.end_row; r += 1) {
      for (let c = m.start_col; c <= m.end_col; c += 1) {
        if (r === m.start_row && c === m.start_col) continue; // 대표 셀은 채운다
        covered.add(r * cols + c);
      }
    }
  }
  return covered;
}

/**
 * 반복 양식 표를 그대로 복제하고 입력칸만 채운다(F-220afd, AC-1e8cbf/AC-2357c1).
 *
 * `sec[para]`는 호출 측이 분할로 만들어 둔 빈 본문 문단이다. 여기에 원본 양식 표를
 * copyControl→pasteControl로 in-model 복제하면 행·열·병합·테두리가 100% 동일하게
 * 붙는다(같은 문서라 doc-로컬 ID가 그대로 유효). 그 후 cell_fills의 (row,col)을 붙은
 * 표의 셀 인덱스로 매핑해 기존 셀 채우기 경로(다줄 포함, F-466f8e)로 입력칸만 채운다.
 *
 * 복제 대상이 표 컨트롤이 아니거나 인덱스가 범위를 벗어나면 throw 한다 — 호출 측이
 * skipped{reason}로 보고하고 문서를 변경하지 않는다(AC-f3d735).
 */
function cloneTableAt(wasm: WasmEditing, sec: number, para: number, edit: Edit): void {
  const spec = edit.payload.clone_table!;
  const src = spec.clone_from;
  if (!wasm.copyControl || !wasm.pasteControl) {
    throw new Error('표 복제(copyControl/pasteControl)를 지원하지 않는 환경입니다.');
  }

  // 1) 원본 양식 표를 내부 클립보드로 복제. 표 컨트롤이 아니거나 인덱스가 범위 밖이면
  //    rhwp가 오류로 거부하거나 ok=false를 반환한다 → throw(AC-f3d735).
  let copied: { ok?: boolean; error?: string };
  try {
    copied = JSON.parse(wasm.copyControl(src.section, src.paragraph, src.control_index)) as {
      ok?: boolean;
      error?: string;
    };
  } catch (e) {
    throw new Error(`복제 대상 표를 찾을 수 없습니다(sec ${src.section}, p ${src.paragraph}, tbl ${src.control_index}): ${String(e)}`);
  }
  if (copied.ok !== true) {
    throw new Error(`복제 대상이 표 컨트롤이 아닙니다(sec ${src.section}, p ${src.paragraph}, tbl ${src.control_index}).`);
  }
  // 복제된 것이 표인지 확인 — 클립보드에 컨트롤이 없으면(텍스트만 복사) 거부.
  if (wasm.clipboardHasControl && wasm.clipboardHasControl() !== true) {
    throw new Error('복제 대상이 표/그림/도형 컨트롤이 아닙니다.');
  }

  // 2) 빈 본문 문단에 붙여넣어 표를 복제한다. 붙은 표의 (paraIdx, controlIdx)를 받는다.
  let pasted: { ok?: boolean; paraIdx?: number; controlIdx?: number };
  try {
    pasted = JSON.parse(wasm.pasteControl(sec, para, 0)) as {
      ok?: boolean;
      paraIdx?: number;
      controlIdx?: number;
    };
  } catch (e) {
    throw new Error(`표 붙여넣기에 실패했습니다: ${String(e)}`);
  }
  if (pasted.ok !== true || typeof pasted.paraIdx !== 'number' || typeof pasted.controlIdx !== 'number') {
    throw new Error('표 붙여넣기에 실패했습니다(클립보드에 표가 없습니다).');
  }
  const destPara = pasted.paraIdx;
  const destCtrl = pasted.controlIdx;

  // 2.5) 목차 청크(F-toc-chunk): 복제본의 데이터 행을 toc_rows로 재구성한다 — 헤더(행 0)는
  //      보존하고 기존 데이터 행을 하향 제거한 뒤, 청크 항목마다 한 행을 추가·채운다. 한 표가
  //      페이지 경계를 자동으로 못 넘는 경우, 페이지 분량씩 복제해 헤더 반복하며 이어 보이게 한다.
  const tocRows = spec.toc_rows;
  if (tocRows && tocRows.length > 0) {
    if (!wasm.getTableCellBboxes) {
      throw new Error('복제된 표의 셀 좌표를 조회할 수 없어 목차 행을 채우지 못했습니다.');
    }
    const boxes0 = wasm.getTableCellBboxes(sec, destPara, destCtrl);
    const maxRow = boxes0.reduce((m, b) => Math.max(m, b.row), 0);
    for (let r = maxRow; r >= 1; r -= 1) wasm.deleteTableRow(sec, destPara, destCtrl, r);
    for (let i = 0; i < tocRows.length; i += 1) {
      wasm.insertTableRow(sec, destPara, destCtrl, i, true); // 행 i 아래 → 새 행 i+1
      const line = wasm
        .getTableCellBboxes(sec, destPara, destCtrl)
        .filter((b) => b.row === i + 1)
        .sort((a, b) => a.col - b.col);
      tocRows[i].forEach((text, ci) => {
        const cell = line[ci];
        if (text && cell) wasm.insertTextInCell(sec, destPara, destCtrl, cell.cellIdx, 0, 0, text);
      });
    }
    return; // 목차 청크는 cell_fills를 쓰지 않는다.
  }

  // 3) (row,col) → 붙은 표의 셀 인덱스 매핑. 복제된 표의 실제 셀 좌표를 한 번만 조회한다.
  const fills = spec.cell_fills ?? [];
  const bodyImages = spec.body_images ?? [];
  const bodyTables = spec.body_tables ?? [];
  if (fills.length === 0 && bodyImages.length === 0 && bodyTables.length === 0) return; // 복제만(빈 양식 추가).
  if (!wasm.getTableCellBboxes) {
    // 좌표 조회 불가 — 복제는 성공했으니 구조는 보존된다. 채우기만 생략하지 않고
    // 명시적으로 오류로 본다(입력칸을 못 채우면 빈 양식이 된다).
    throw new Error('복제된 표의 셀 좌표를 조회할 수 없어 입력칸을 채우지 못했습니다.');
  }
  let cells: Array<{ cellIdx: number; col: number; row: number; colSpan: number; w?: number }>;
  try {
    cells = wasm.getTableCellBboxes(sec, destPara, destCtrl);
  } catch (e) {
    throw new Error(`복제된 표의 셀 좌표 조회 실패: ${String(e)}`);
  }
  // (row,col) → cellIdx 룩업. 병합 셀은 대표(좌상단) 셀의 row/col로만 잡히므로,
  // 병합으로 가려진 좌표는 매칭되지 않는다(라벨/입력 모두 대표 좌표로 지정해야 한다).
  const cellAt = new Map<string, number>();
  for (const c of cells) cellAt.set(`${c.row},${c.col}`, c.cellIdx);

  for (const fill of fills) {
    const cellIdx = cellAt.get(`${fill.row},${fill.col}`);
    if (cellIdx === undefined) {
      // 범위 밖/병합에 가려진 좌표 — 그 한 칸만 건너뛴다(복제 구조는 이미 보존됨).
      continue;
    }
    // 기존 셀 채우기 경로(다줄 포함, F-466f8e) 재사용: 셀 첫 문단(cp=0)을 비우고 채운다.
    const target: CellTarget = {
      sec,
      parentPara: destPara,
      path: [{ controlIndex: destCtrl, cellIndex: cellIdx, cellParaIndex: 0 }],
    };
    const length = wasm.getCellParagraphLength(sec, destPara, destCtrl, cellIdx, 0);
    if (length > 0) wasm.deleteTextInCell(sec, destPara, destCtrl, cellIdx, 0, 0, length);
    fillCellLinesFlat(wasm, target, destCtrl, cellIdx, 0, splitLines(fill.text));
  }

  // 본문 통셀 인라인 이미지 삽입(F-5dc6297e/Phase B). 셀 문단 채움 뒤, 위치(after_para)에
  // 그림을 넣는다. 인덱스 밀림 방지를 위해 after_para 내림차순으로 삽입한다. 그림 폭은 HWP
  // 본문폭 상한으로 제한(과대 폭이면 비율 유지 축소). insertPictureInCell이 없으면 생략.
  if (bodyImages.length > 0 && wasm.insertPictureInCell) {
    const PX_TO_HU = 7200 / 96; // 96dpi에서 1px=75 HWPUNIT
    const sorted = [...bodyImages].sort((a, b) => b.after_para - a.after_para);
    for (const img of sorted) {
      const cellIdx = cellAt.get(`${img.row},${img.col}`);
      if (cellIdx === undefined) continue;
      let bytes: Uint8Array;
      try {
        bytes = bytesFromBase64(img.data_base64);
      } catch {
        continue;
      }
      if (bytes.length === 0) continue;
      // 본문 셀 폭(px)에 맞춰 그림을 키운다 — 셀 폭의 98%를 목표로(좌우 여백만 살짝).
      // 작은 그림은 키우고 큰 그림은 줄여 셀에 꽉 차게(비율 유지). 셀 폭을 못 구하면
      // A4 본문폭(560px) 폴백. 단, 원본의 4배를 넘는 과도한 확대는 화질 보호로 제한.
      const cellW = cells.find((c) => c.row === img.row && c.col === img.col)?.w;
      const targetWpx = Math.max(40, Math.floor((cellW ?? 560) * 0.98));
      const natW = Math.max(1, img.width_px);
      const natH = Math.max(1, img.height_px);
      const dispWpx = Math.min(targetWpx, natW * 4);
      const dispHpx = Math.max(1, Math.round((natH * dispWpx) / natW));
      const wHu = Math.round(dispWpx * PX_TO_HU);
      const hHu = Math.round(dispHpx * PX_TO_HU);
      try {
        wasm.insertPictureInCell(
          sec,
          destPara,
          destCtrl,
          cellIdx,
          img.after_para,
          bytes,
          wHu,
          hHu,
          natW,
          natH,
          img.ext || 'png',
          '',
        );
      } catch {
        /* 그림 삽입 실패는 무시(본문 텍스트는 정상) */
      }
    }
  }

  // 본문 통셀 데이터 표 삽입(중첩 표). 셀 문단 채움 뒤, 위치(after_para)에 표를 넣는다.
  // 인덱스 밀림 방지를 위해 after_para 내림차순으로 삽입. createTableInCell이 없으면 생략.
  if (bodyTables.length > 0 && wasm.createTableInCell) {
    const sorted = [...bodyTables].sort((a, b) => b.after_para - a.after_para);
    for (const tbl of sorted) {
      const cellIdx = cellAt.get(`${tbl.row},${tbl.col}`);
      if (cellIdx === undefined) continue;
      if (tbl.rows <= 0 || tbl.cols <= 0) continue;
      try {
        wasm.createTableInCell(
          sec,
          destPara,
          destCtrl,
          cellIdx,
          tbl.after_para,
          tbl.rows,
          tbl.cols,
          JSON.stringify(tbl.cells),
        );
      } catch {
        /* 표 삽입 실패는 무시(본문 텍스트는 정상) */
      }
    }
  }
}

/** base64 문자열을 바이트 배열로 디코드한다(atob 기반). */
function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

// ── 양식 이어쓰기: 라벨→값 매핑 + 결정적 복제 루프 (F-ae778890) ──────────────
//
// 핵심 원칙: AI는 표 구조를 절대 결정하지 않는다. AI는 항목 내용(라벨→값 리스트)만
// 반환하고, 앱이 항목마다 소스 양식 표를 cloneTableAt(F-220afd: copyControl→pasteControl)로
// 결정적 복제한다. 복제는 같은 문서 내라 doc-로컬 ID가 보존돼 행·열·병합·테두리가 100%
// 동일하다. 따라서 생성 항목은 ALWAYS 소스와 구조가 같다(6×3→6×2 compose 드리프트 해결).

/** serialize.rs FormTable 한 셀(라벨/입력칸 식별용). */
export interface FormSourceCell {
  row: number;
  col: number;
  role?: string;
  text?: string;
}

/** serialize.rs FormTable — 복제 소스가 될 최상위 양식 표. */
export interface FormSourceTable {
  section: number;
  paragraph: number;
  control_index: number;
  rows: number;
  cols: number;
  cells: FormSourceCell[];
}

/** AI가 반환하는 한 항목(라벨→값 쌍의 집합). 표 구조 정보는 없다. */
export interface FormFillEntry {
  fields: { label: string; value: string }[];
  /**
   * 라벨이 없는 '본문 통셀'에 채울 멀티단락 본문(선택). 소스 단락 1개 = 셀 문단 1개로
   * 보존되며 한 줄로 평탄화하지 않는다(F-4d5d3e00). 없으면 본문 채움을 시도하지 않는다.
   */
  body?: string[];
  /** 본문 통셀에 넣을 인라인 이미지(선택, F-5dc6297e/Phase B). after_body_index=단락 뒤 위치. */
  images?: {
    after_body_index: number;
    data_base64: string;
    ext: string;
    width_px: number;
    height_px: number;
  }[];
  /** 본문 통셀에 넣을 데이터 표(선택). after_body_index=단락 뒤 위치, cells=row-major. */
  tables?: {
    after_body_index: number;
    rows: number;
    cols: number;
    cells: string[];
  }[];
}

/** 라벨/값 비교용 정규화(공백 제거 + 소문자). '사 업 명' == '사업명' 같은 변형 흡수. */
function normalizeLabel(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

/**
 * 소스 양식 표에서 한 라벨 셀의 '값칸' 좌표를 찾는다(라벨↔인접 값칸 매핑 휴리스틱).
 *
 * 휴리스틱(이 순서로 시도):
 *  1) 같은 행, 다음 열(label 오른쪽 칸) — 가장 흔한 가로 폼.
 *  2) 다음 행, 같은 열(label 아래 칸) — 세로 폼.
 * 단, 후보 칸이 그 자체로 '알려진 라벨'(다른 항목의 라벨명과 일치하거나 role=label로
 * 텍스트가 있는 칸)이면 건너뛴다 — 라벨↔라벨이 붙은 표에서 라벨칸을 값칸으로 오인하지
 * 않기 위함. 해석 실패 시 null(호출 측이 그 한 라벨만 건너뛰고 사유를 기록한다).
 *
 * 같은 (row,col)이 셀 목록에 여러 번 있으면(병합 등) 첫 매칭을 쓴다. 병합으로 가려진
 * 좌표는 cellAt 매핑에서 빠지므로 cloneTableAt이 그 한 칸만 건너뛴다(구조는 이미 보존).
 */
export function resolveValueCell(
  table: FormSourceTable,
  labelCell: FormSourceCell,
  knownLabels: Set<string>,
): { row: number; col: number } | null {
  const at = (row: number, col: number): FormSourceCell | undefined =>
    table.cells.find((c) => c.row === row && c.col === col);
  // 후보 칸이 '라벨로 쓰이는 칸'이면 값칸이 아니다 — 건너뛴다. 판정 기준은 '텍스트 유무'가
  // 아니라 '라벨명(knownLabels) 일치'다(F-f6c643d1): 이미 채워진 템플릿을 복제하는 경우
  // 값칸에도 샘플 텍스트가 있는데(role=label), 텍스트가 있다고 거부하면 제목·기록자·일자
  // 값칸이 전부 거부돼 덮어쓰기가 안 된다. 샘플값은 라벨명이 아니므로 값칸으로 인정한다.
  const isLabelCell = (c: FormSourceCell | undefined): boolean => {
    if (!c) return false;
    const t = normalizeLabel((c.text ?? '').trim());
    return t.length > 0 && knownLabels.has(t);
  };
  const candidates = [
    { row: labelCell.row, col: labelCell.col + 1 }, // 1) 오른쪽
    { row: labelCell.row + 1, col: labelCell.col }, // 2) 아래
  ];
  for (const cand of candidates) {
    if (cand.col >= table.cols || cand.row >= table.rows) continue;
    const cell = at(cand.row, cand.col);
    // 후보 좌표에 실재 셀이 없으면(병합에 가려진 좌표) 값칸이 아니다 — 건너뛴다(F-addf13c1).
    // 특히 라벨 칸 자신이 가로로 병합(예: '기록자' 1×2)되면 바로 오른쪽 좌표는 그 라벨의
    // 병합 속에 가려져 실재 셀이 없다 → 여기서 거르지 않으면 가려진 좌표를 값칸으로 반환하고
    // cloneTableAt이 그 칸을 건너뛰어 채움이 조용히 누락된다(아래 칸으로 폴백해야 한다).
    // 빈 입력칸은 serialize가 role=input으로 cells에 포함하므로 실재 셀로 남아 영향이 없다.
    if (!cell) continue;
    if (isLabelCell(cell)) continue; // 라벨칸은 값칸이 아니다.
    return { row: cand.row, col: cand.col };
  }
  return null;
}

/**
 * 연구노트 양식의 메타 라벨 집합(정규화). 본문 통셀 식별 시 이 라벨이 든 전폭 셀은
 * 본문이 아니라 구역 헤더이므로 제외한다.
 */
const META_LABELS = new Set(
  ['제목', '기록자', '확인자', '기록 일자', '확인 일자'].map(normalizeLabel),
);

/**
 * 소스 양식 표에서 '본문 통셀' 좌표를 결정적으로 찾는다(F-4d5d3e00 AC: 라벨 없는 전폭 셀).
 *
 * serialize.rs FormCell은 span을 노출하지 않지만, 병합 셀은 대표(좌상단) 좌표 1개로만
 * cells에 들어온다(collect_form_tables). 따라서 '그 행에 셀이 하나뿐 + col===0'이면 전폭
 * 병합 행이고, 그 셀이 메타 라벨(제목/기록자/…)도 아니고 이미 쓰인 값칸도 아니면 본문 통셀이다.
 * 라벨/값 행(제목 2칸, 기록자 2칸 등)은 셀이 2개라 자연히 배제된다. 후보가 여럿이면 문서
 * 순서(최소 row)의 첫 셀을 본문으로 본다. 해석 실패 시 null(호출 측이 사유를 skipped로 기록).
 */
export function resolveBodyCell(
  table: FormSourceTable,
  usedValueCells: Set<string>,
): { row: number; col: number } | null {
  const byRow = new Map<number, FormSourceCell[]>();
  for (const c of table.cells) {
    const arr = byRow.get(c.row) ?? [];
    arr.push(c);
    byRow.set(c.row, arr);
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  for (const row of rows) {
    const cells = byRow.get(row)!;
    if (cells.length !== 1) continue; // 전폭 병합 행만(라벨/값 행은 셀≥2).
    const cell = cells[0];
    if (cell.col !== 0) continue;
    if (usedValueCells.has(`${cell.row},${cell.col}`)) continue; // 이미 값칸으로 쓰임.
    if (META_LABELS.has(normalizeLabel((cell.text ?? '').trim()))) continue; // 구역 헤더 제외.
    return { row: cell.row, col: cell.col };
  }
  return null;
}

/** 라벨→값 매핑 결과: 채울 cell_fills와 해석 못 한 라벨(사유) + 본문 셀 이미지. */
export interface FormFillMapping {
  cellFills: { row: number; col: number; text: string }[];
  skipped: { label: string; reason: string }[];
  /** 본문 통셀에 넣을 이미지(본문 셀 좌표 + 위치/바이트). 본문 셀이 없으면 비어 있다. */
  bodyImages: {
    row: number;
    col: number;
    after_para: number;
    data_base64: string;
    ext: string;
    width_px: number;
    height_px: number;
  }[];
  /** 본문 통셀에 넣을 데이터 표(본문 셀 좌표 + 위치 + 내용). 본문 셀이 없으면 비어 있다. */
  bodyTables: {
    row: number;
    col: number;
    after_para: number;
    rows: number;
    cols: number;
    cells: string[];
  }[];
}

/**
 * AI 항목(라벨→값)을 소스 양식 표의 '값칸 좌표 → text' cell_fills로 매핑한다(AC-86e329eb).
 * 라벨칸은 결과에 넣지 않으므로 복제 후 원본 라벨이 그대로 보존된다(값칸만 REPLACE).
 *
 * 라벨 매칭은 정규화(공백/대소문자 무시) 후 완전일치 우선, 없으면 부분포함으로 찾는다.
 */
export function buildFormFillMapping(table: FormSourceTable, entry: FormFillEntry): FormFillMapping {
  // 값칸 오인 방지용 '라벨명' 집합 — 메타 라벨(제목/기록자/…) + 이 항목이 채울 필드 라벨만
  // 담는다. 소스 표의 '샘플 값칸 텍스트'는 넣지 않는다(F-f6c643d1): 채워진 템플릿을 복제할
  // 때 값칸(샘플값)을 라벨로 오인해 거부하면 덮어쓰기가 안 되기 때문. 라벨↔라벨 인접 보호는
  // 라벨명 일치로 충분히 보장된다(인접 라벨은 필드/메타 라벨명과 일치하므로 여전히 걸러진다).
  const knownLabels = new Set<string>(META_LABELS);
  for (const f of entry.fields) knownLabels.add(normalizeLabel(f.label));

  const cellFills: { row: number; col: number; text: string }[] = [];
  const skipped: { label: string; reason: string }[] = [];
  const usedValueCells = new Set<string>();

  for (const field of entry.fields) {
    const wanted = normalizeLabel(field.label);
    // 소스에서 그 라벨 셀을 찾는다(완전일치 → 부분포함). 라벨 텍스트가 있는 칸만 후보.
    const labelCells = table.cells.filter((c) => {
      const t = normalizeLabel((c.text ?? '').trim());
      return t.length > 0 && t !== ''; // 빈 칸 제외(값칸일 수 있음)
    });
    const labelCell =
      labelCells.find((c) => normalizeLabel((c.text ?? '').trim()) === wanted) ??
      labelCells.find((c) => {
        const t = normalizeLabel((c.text ?? '').trim());
        return t.includes(wanted) || wanted.includes(t);
      });
    if (!labelCell) {
      skipped.push({ label: field.label, reason: '소스 양식에서 같은 이름의 라벨 칸을 찾지 못했습니다.' });
      continue;
    }
    const value = resolveValueCell(table, labelCell, knownLabels);
    if (!value) {
      skipped.push({ label: field.label, reason: '라벨에 인접한 값칸(오른쪽/아래)을 찾지 못했습니다.' });
      continue;
    }
    const key = `${value.row},${value.col}`;
    if (usedValueCells.has(key)) {
      skipped.push({ label: field.label, reason: `값칸(${key})이 이미 다른 라벨에 매핑되었습니다.` });
      continue;
    }
    usedValueCells.add(key);
    cellFills.push({ row: value.row, col: value.col, text: field.value });
  }

  // 본문 통셀 채움(F-4d5d3e00): 라벨이 없어 위 라벨→값칸 매핑으로는 닿지 않는 전폭 셀에
  // 멀티단락 본문을 결정적으로 주입한다. body가 없거나 공백뿐이면 아무 것도 하지 않는다
  // (회귀 없음 — AC: body 없는 항목은 기존 동작과 동일). cell_fills의 text에 담긴 '\n'은
  // cloneTableAt→splitLines→fillCellLinesFlat 경로에서 단락별 셀 문단으로 풀린다(F-466f8e).
  const bodyImages: FormFillMapping['bodyImages'] = [];
  const bodyTables: FormFillMapping['bodyTables'] = [];
  const bodyText = (entry.body ?? []).join('\n');
  if (bodyText.trim().length > 0) {
    const bodyCell = resolveBodyCell(table, usedValueCells);
    if (!bodyCell) {
      skipped.push({
        label: '(본문)',
        reason: '양식에서 본문 통셀(라벨 없는 전폭 셀)을 찾지 못해 본문을 채우지 못했습니다.',
      });
    } else {
      usedValueCells.add(`${bodyCell.row},${bodyCell.col}`);
      cellFills.push({ row: bodyCell.row, col: bodyCell.col, text: bodyText });
      // 본문 통셀 인라인 이미지(F-5dc6297e/Phase B): 본문 셀 좌표 + docx 위치·바이트.
      for (const img of entry.images ?? []) {
        bodyImages.push({
          row: bodyCell.row,
          col: bodyCell.col,
          after_para: img.after_body_index,
          data_base64: img.data_base64,
          ext: img.ext,
          width_px: img.width_px,
          height_px: img.height_px,
        });
      }
      // 본문 통셀 데이터 표(중첩 표): 본문 셀 좌표 + docx 위치·내용.
      for (const tbl of entry.tables ?? []) {
        bodyTables.push({
          row: bodyCell.row,
          col: bodyCell.col,
          after_para: tbl.after_body_index,
          rows: tbl.rows,
          cols: tbl.cols,
          cells: tbl.cells,
        });
      }
    }
  }

  return { cellFills, skipped, bodyImages, bodyTables };
}

// ── docx 일괄 변환: 파싱된 항목 → 양식 항목 매핑 + 엔트리 양식 선택 (F-beb35fbb) ──────
//
// LLM 왕복 없이 docx에서 직접 구동한다. parse_docx_structure(F-075bdb05)가 추출한 각
// EntryRecord를 양식 항목(FormFillEntry)으로 변환하면, 본문은 F-4d5d3e00 본문 통셀 채우기가,
// 라벨→값은 기존 매핑이 처리한다. 복제 소스는 '엔트리 양식 표'(제목+기록자+일자 라벨을 가진
// 반복 템플릿)를 선택한다 — 대외비/목차/개요 같은 다른 양식 표는 고르지 않는다.

/**
 * 사용자 지시문에서 '몇 번 항목만' 선택을 파싱한다(docx 일괄 변환의 부분 선택).
 * 1-기준 항목 번호 집합을 반환하며, 선택 표현이 없으면 null(=전체 변환).
 * 지원: "3번만"·"3,5,9번"·"3~7"·"3-7"·"3부터 7까지"·"3에서 7"·"처음 5개"·"앞 5개"·
 *       "마지막 3개"·"끝 3개"·"first 5"·"last 3". total로 범위를 클램프한다.
 */
export function parseEntrySelection(text: string, total: number): Set<number> | null {
  if (total <= 0) return null;
  const t = text.replace(/\s+/g, ' ');
  const clamp = (n: number) => Math.min(Math.max(n, 1), total);
  const sel = new Set<number>();

  // 처음/앞/first K개
  let m = t.match(/(?:처음|앞)\s*(\d+)\s*개|first\s+(\d+)/i);
  if (m) {
    const k = clamp(Number(m[1] ?? m[2]));
    for (let i = 1; i <= k; i += 1) sel.add(i);
    return sel.size ? sel : null;
  }
  // 마지막/끝/last K개
  m = t.match(/(?:마지막|끝)\s*(\d+)\s*개|last\s+(\d+)/i);
  if (m) {
    const k = clamp(Number(m[1] ?? m[2]));
    for (let i = total - k + 1; i <= total; i += 1) sel.add(clamp(i));
    return sel.size ? sel : null;
  }
  // 범위: N~M / N-M / N부터 M까지 / N번부터 M번까지 / N에서 M / N to M
  const ranges = t.matchAll(/(\d+)\s*번?\s*(?:~|-|–|부터|에서|to)\s*(\d+)\s*번?(?:\s*까지)?/gi);
  let any = false;
  for (const r of ranges) {
    any = true;
    let a = clamp(Number(r[1]));
    let b = clamp(Number(r[2]));
    if (a > b) [a, b] = [b, a];
    for (let i = a; i <= b; i += 1) sel.add(i);
  }
  if (any) return sel.size ? sel : null;

  // 개별/목록: "3, 5, 9번" / "3번" — '번' 앞의 (콤마 구분) 숫자 목록을 모두 선택('번'
  // 동반 시에만 — 일반 문장의 숫자 오탐 방지).
  if (/\d+\s*번/.test(t)) {
    for (const r of t.matchAll(/(\d+(?:\s*,\s*\d+)*)\s*번/g)) {
      for (const num of r[1].split(/\s*,\s*/)) sel.add(clamp(Number(num)));
    }
    if (sel.size) return sel;
  }
  return null;
}

/** 연구노트 항목(EntryRecord)을 양식 항목(FormFillEntry)으로 변환한다(F-beb35fbb AC). */
export function entryRecordToFormFillEntry(rec: ResearchNoteEntry): FormFillEntry {
  return {
    fields: [
      { label: '제목', value: rec.title },
      { label: '기록자', value: rec.recorders.join(', ') },
      { label: '확인자', value: rec.confirmer },
      { label: '기록 일자', value: rec.record_date },
      { label: '확인 일자', value: rec.confirm_date },
    ],
    body: rec.body_paragraphs,
    images: rec.images,
    tables: (rec.body_tables ?? []).map((t) => ({
      after_body_index: t.after_body_index,
      rows: t.rows,
      cols: t.cols,
      cells: t.cells,
    })),
  };
}

/**
 * form_tables 중 '엔트리 양식 표'(반복되는 연구노트 항목 템플릿 = 사용자가 말한 '4페이지
 * 양식')를 고른다. 판정: 셀에 '기록자' 라벨과 '기록 일자'(또는 '제목') 라벨을 함께 가진 표.
 * 대외비(2행 1열)·목차(일련번호)·개요(과제명/키워드) 표는 이 조건을 만족하지 않아 배제된다.
 * 없으면 null(→ 호출 측이 변환을 거부, 빈 결과 위장 금지).
 */
export function pickEntryFormTable(tables: FormSourceTable[]): FormSourceTable | null {
  const has = (t: FormSourceTable, label: string): boolean =>
    t.cells.some((c) => normalizeLabel((c.text ?? '').trim()) === normalizeLabel(label));
  return (
    tables.find((t) => has(t, '기록자') && (has(t, '기록 일자') || has(t, '제목'))) ?? null
  );
}

/**
 * form_tables 중 목차 표를 고른다(F-9a5045da) — 셀에 '일련'과 '비고' 텍스트를 함께 가진 표
 * (연구노트 목차 헤더: 일련(쪽)번호 / 제목(내용) / 비고). 대외비·기관명·엔트리 양식 표는
 * 이 조건을 만족하지 않는다. 없으면 null(→ 목차 재생성 생략).
 */
export function pickTocTable(tables: FormSourceTable[]): FormSourceTable | null {
  const hasText = (t: FormSourceTable, needle: string): boolean =>
    t.cells.some((c) => (c.text ?? '').includes(needle));
  return tables.find((t) => hasText(t, '일련') && hasText(t, '비고')) ?? null;
}

/**
 * 목차 표의 데이터 행을 파싱된 목차 항목으로 재구성하는 table_edit 편집 목록을 만든다
 * (F-9a5045da). 헤더 행(0)은 보존하고, 기존 데이터 행을 하향으로 모두 delete_row 한 뒤
 * 항목마다 insert_row(below)로 [no, title, ''(비고)] 행을 추가한다. applyActionScript가 같은
 * 표의 구조 편집을 입력 순서대로 적용하므로(delete 하향 → insert 상향) 시퀀스가 결정적이다.
 * tocTable이 null이거나 items가 비면 빈 배열(no-op) — 목차 미변경, 나머지 변환은 진행.
 */
/**
 * 목차 항목을 '페이지 분량'씩 청크로 나눈다(F-toc-chunk). 한 표가 페이지 경계를 자동으로
 * 넘지 못하므로(rhwp 직렬화 한계), 페이지마다 채울 만큼씩 나눠 표 여러 개로 만든다.
 * 정확한 렌더 높이는 못 믿으니 제목 길이로 줄 수를 추정한다(열 폭 charsPerLine 기준,
 * 길면 2줄+). 넘침=잘림이므로 용량(linesPerPage)은 보수적으로 잡는다(약간 덜 채움).
 */
export function chunkTocItems(
  items: { no: string; title: string }[],
  opts?: { charsPerLine?: number; linesPerPage?: number },
): { no: string; title: string }[][] {
  const charsPerLine = opts?.charsPerLine ?? 26;
  const linesPerPage = opts?.linesPerPage ?? 18;
  const chunks: { no: string; title: string }[][] = [];
  let cur: { no: string; title: string }[] = [];
  let curLines = 0;
  for (const it of items) {
    const lines = Math.max(1, Math.ceil((it.title?.length ?? 0) / charsPerLine));
    if (cur.length > 0 && curLines + lines > linesPerPage) {
      chunks.push(cur);
      cur = [];
      curLines = 0;
    }
    cur.push(it);
    curLines += lines;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

/**
 * 목차 청크 하나를 '목차 표 복제 + 행 재구성'하는 clone_table 편집으로 만든다(F-toc-chunk).
 * 원본 목차 표(tocTable)를 anchor 뒤/새 페이지에 복제하고, 복제본의 데이터 행을 이 청크로
 * 재구성(toc_rows)한다 → 페이지마다 헤더 반복하며 목차가 이어진다.
 */
export function buildTocChunkCloneEdit(
  tocTable: FormSourceTable,
  chunkItems: { no: string; title: string }[],
  anchorTargetId: string,
): Edit {
  return {
    command: 'INSERT_AFTER',
    target_id: anchorTargetId,
    payload: {
      type: 'clone_table',
      page_break: true,
      clone_table: {
        clone_from: {
          section: tocTable.section,
          paragraph: tocTable.paragraph,
          control_index: tocTable.control_index,
        },
        cell_fills: [],
        toc_rows: chunkItems.map((it) => [it.no, it.title, '']),
      },
    },
  };
}

export function buildTocRegenEdits(
  tocTable: FormSourceTable | null,
  items: { no: string; title: string }[],
): Edit[] {
  if (!tocTable || items.length === 0) return [];
  const targetId = `sec[${tocTable.section}].p[${tocTable.paragraph}].tbl[${tocTable.control_index}].cell[0].p[0]`;
  const edits: Edit[] = [];
  const pushEdit = (table_edit: NonNullable<Edit['payload']['table_edit']>): void => {
    edits.push({ command: 'REPLACE', target_id: targetId, payload: { type: 'table_edit', table_edit } });
  };
  // 새 행은 인접 행의 셀 스타일(테두리/배경/글꼴)을 상속한다(insert_row 템플릿). 헤더(행 0)는
  // 회색 배경·강조라, 데이터 행을 전부 지우고 헤더 아래로 삽입하면 모든 목차 행이 헤더(제목)
  // 스타일을 물려받아 "전부 제목줄"이 된다(흰 배경·기본 글꼴이 사라짐). 따라서 첫 데이터
  // 행(행 1, 흰 배경·기본)을 '도너'로 남기고 그 아래로 삽입한 뒤, 마지막에 도너를 제거한다.
  const hasDonor = tocTable.rows >= 2;
  if (hasDonor) {
    // 1) 도너(행 1)만 남기고 나머지 데이터 행을 하향 제거.
    for (let r = tocTable.rows - 1; r >= 2; r -= 1) {
      pushEdit({ op: 'delete_row', row: r });
    }
    // 2) 항목마다 도너(데이터 행) 아래로 삽입 — 데이터 스타일을 상속한다.
    //    i번째는 행 (1+i) 아래에 삽입돼 도너 뒤로 순서대로 쌓인다.
    items.forEach((item, i) => {
      pushEdit({ op: 'insert_row', row: 1 + i, below: true, texts: [item.no, item.title, ''] });
    });
    // 3) 도너(원본 샘플 데이터 행, 여전히 행 1)를 제거 — 새 행들이 이미 데이터 스타일을 가졌다.
    pushEdit({ op: 'delete_row', row: 1 });
  } else {
    // 폴백(데이터 행 없는 표): 헤더만 있으므로 헤더 아래로 삽입(구 동작).
    items.forEach((item, i) => {
      pushEdit({ op: 'insert_row', row: i, below: true, texts: [item.no, item.title, ''] });
    });
  }
  return edits;
}

/**
 * 표지(첫 페이지) 표를 고른다 — 정규화 라벨 '기관명'과 '연구과제명'을 함께 가진 표
 * (연구노트 표지: 기관명/부서명/연구과제명/연구 기간/연구책임자/기록자 명단). 없으면 null
 * (→ 표지 채움 생략, 항목/목차 변환은 그대로).
 */
export function pickCoverTable(tables: FormSourceTable[]): FormSourceTable | null {
  const hasLabel = (t: FormSourceTable, label: string): boolean =>
    t.cells.some((c) => normalizeLabel((c.text ?? '').trim()) === normalizeLabel(label));
  return tables.find((t) => hasLabel(t, '기관명') && hasLabel(t, '연구과제명')) ?? null;
}

/** 표지 상단 관리번호 표를 고른다 — '관리번호' 텍스트를 포함한 셀이 있는 표. */
export function pickCoverHeaderTable(tables: FormSourceTable[]): FormSourceTable | null {
  return tables.find((t) => t.cells.some((c) => (c.text ?? '').includes('관리번호'))) ?? null;
}

/** 표지 라벨 집합(정규화) — 값칸 해석 시 라벨칸을 값칸으로 오인하지 않기 위한 목록. */
const COVER_LABELS = new Set(
  ['기관명', '부서명', '연구과제명', '연구 기간', '연구책임자', '기록자'].map(normalizeLabel),
);

/**
 * docx 표지 메타를 HWP 표지 표에 직접 채운다(F-cover-fill). 편집 스크립트가 아니라
 * TOC 후처리(setTableProperties)처럼 wasm을 직접 호출한다 — 원본 표를 제자리에서 채우는
 * 경로는 clone_table(cell_fills)이 커버하지 않으므로, 같은 셀 채움 머신
 * (getTableCellBboxes → deleteTextInCell → fillCellLinesFlat)을 재사용한다.
 *
 * - 라벨 값(기관명/부서명/연구과제명/연구 기간/연구책임자): resolveValueCell로 인접 값칸을
 *   찾아 교체. docx에서 빈 값이면 그 필드는 건드리지 않는다(양식 값 보존).
 * - 기록자 명단: '기록자' 라벨 뒤의 모든 칸을 명단 슬롯으로 보고 순서대로 "N. 이름"을
 *   기입(슬롯 템플릿에 번호 접두사가 없으면 이름만). docx 명단보다 슬롯이 많으면 나머지를
 *   비운다(템플릿 샘플 이름 잔존 방지).
 * - 관리번호: 헤더 표의 '관리번호' 셀 첫 문단만 교체("(Serial No.)" 등 뒤 문단 보존).
 *
 * 반환: 채운 칸 수 + 건너뛴 필드(사유). 실패는 조용히 삼키지 않고 skipped로 보고한다.
 */
export function applyCoverFill(
  wasm: WasmEditing,
  coverTable: FormSourceTable | null,
  headerTable: FormSourceTable | null,
  cover: ResearchNoteCover | null | undefined,
): { filled: number; skipped: { label: string; reason: string }[] } {
  const skipped: { label: string; reason: string }[] = [];
  let filled = 0;
  if (!cover) return { filled, skipped };
  if (!wasm.getTableCellBboxes) {
    return { filled, skipped: [{ label: '표지', reason: '셀 좌표 조회 API 없음' }] };
  }

  // (row,col)→cellIdx 매핑을 표마다 한 번만 조회한다.
  const cellIdxMap = (t: FormSourceTable): Map<string, number> | null => {
    try {
      const boxes = wasm.getTableCellBboxes!(t.section, t.paragraph, t.control_index);
      const m = new Map<string, number>();
      for (const b of boxes) m.set(`${b.row},${b.col}`, b.cellIdx);
      return m;
    } catch {
      return null;
    }
  };
  const fillCell = (t: FormSourceTable, idxMap: Map<string, number>, row: number, col: number, text: string): boolean => {
    const cellIdx = idxMap.get(`${row},${col}`);
    if (cellIdx === undefined) return false;
    const target: CellTarget = {
      sec: t.section,
      parentPara: t.paragraph,
      path: [{ controlIndex: t.control_index, cellIndex: cellIdx, cellParaIndex: 0 }],
    };
    const length = wasm.getCellParagraphLength(t.section, t.paragraph, t.control_index, cellIdx, 0);
    if (length > 0) wasm.deleteTextInCell(t.section, t.paragraph, t.control_index, cellIdx, 0, 0, length);
    fillCellLinesFlat(wasm, target, t.control_index, cellIdx, 0, splitLines(text));
    return true;
  };

  if (coverTable) {
    const idxMap = cellIdxMap(coverTable);
    if (!idxMap) {
      skipped.push({ label: '표지', reason: '표지 표 셀 좌표 조회 실패' });
    } else {
      const findLabelCell = (label: string): FormSourceCell | undefined =>
        coverTable.cells.find(
          (c) => normalizeLabel((c.text ?? '').trim()) === normalizeLabel(label),
        );
      // 1) 라벨 → 인접 값칸 필드들. docx 빈 값은 건드리지 않는다.
      const fields: [string, string][] = [
        ['기관명', cover.org],
        ['부서명', cover.dept],
        ['연구과제명', cover.project],
        ['연구 기간', cover.period],
        ['연구책임자', cover.lead],
      ];
      for (const [label, value] of fields) {
        if (!value) continue;
        const labelCell = findLabelCell(label);
        if (!labelCell) {
          skipped.push({ label, reason: '표지 표에 라벨 없음' });
          continue;
        }
        const valueCell = resolveValueCell(coverTable, labelCell, COVER_LABELS);
        if (!valueCell) {
          skipped.push({ label, reason: '값칸 해석 실패' });
          continue;
        }
        if (fillCell(coverTable, idxMap, valueCell.row, valueCell.col, value)) filled += 1;
      }
      // 2) 기록자 명단 슬롯: '기록자' 라벨 뒤(row-major)의 모든 칸. 명단을 순서대로 넣고
      //    남는 슬롯은 비운다.
      const recLabel = findLabelCell('기록자');
      if (recLabel && cover.recorders.length > 0) {
        const slots = coverTable.cells
          .filter(
            (c) =>
              (c.row > recLabel.row || (c.row === recLabel.row && c.col > recLabel.col)) &&
              !COVER_LABELS.has(normalizeLabel((c.text ?? '').trim())),
          )
          .sort((a, b) => a.row - b.row || a.col - b.col);
        slots.forEach((slot, i) => {
          const name = cover.recorders[i];
          const numbered = /^\d+\s*\./.test((slot.text ?? '').trim());
          const text = name ? (numbered ? `${i + 1}. ${name}` : name) : '';
          // 빈 슬롯을 빈 값으로 다시 채우는 건 no-op이므로 건너뛴다.
          if (text === '' && (slot.text ?? '').trim() === '') return;
          if (fillCell(coverTable, idxMap, slot.row, slot.col, text)) filled += 1;
        });
      } else if (cover.recorders.length > 0) {
        skipped.push({ label: '기록자', reason: '표지 표에 기록자 라벨 없음' });
      }
    }
  } else if (cover.org || cover.recorders.length > 0) {
    skipped.push({ label: '표지', reason: '표지 표를 찾지 못함' });
  }

  // 3) 관리번호 — 헤더 표 '관리번호' 셀의 첫 문단만 교체(뒤 문단 "(Serial No.)" 보존).
  if (cover.manage_no) {
    if (!headerTable) {
      skipped.push({ label: '관리번호', reason: '관리번호 표를 찾지 못함' });
    } else {
      const cell = headerTable.cells.find((c) => (c.text ?? '').includes('관리번호'));
      const idxMap = cell ? cellIdxMap(headerTable) : null;
      if (!cell || !idxMap) {
        skipped.push({ label: '관리번호', reason: '관리번호 셀 좌표 해석 실패' });
      } else if (fillCell(headerTable, idxMap, cell.row, cell.col, cover.manage_no)) {
        filled += 1;
      } else {
        skipped.push({ label: '관리번호', reason: '관리번호 셀 채움 실패' });
      }
    }
  }
  return { filled, skipped };
}

/** 항목 하나의 clone_table 편집 + 그 항목의 라벨 해석 실패 목록. */
export interface FormFillEditPlan {
  edit: Edit;
  skipped: { label: string; reason: string }[];
}

/**
 * AI 항목 리스트를 '항목마다 소스 표를 결정적 복제하는' clone_table 편집 목록으로 만든다
 * (AC-6bdb1e17: clone-per-entry 루프). 표 구조는 AI가 결정하지 않는다 — clone_from은 항상
 * 소스 양식 표 좌표이고, cell_fills는 라벨→값칸 매핑(buildFormFillMapping)에서 나온다.
 *
 * 모든 항목을 같은 anchor 본문 문단 뒤(INSERT_AFTER)에 넣는다. applyActionScript은 문단
 * 인덱스 내림차순으로 적용하지만 같은 target_id의 INSERT_AFTER끼리는 입력 역순으로 적용돼
 * 입력 정순(항목1, 항목2, …)으로 문서에 남는다.
 *
 * pageBreak: 항목마다 새 페이지에서 시작할지(기본 true — AI form_fill 경로 보존). docx 일괄
 * 변환(F-form-fill-page-layout)은 false를 넘긴다 — insert_page_break_native가 표 앞에 고아
 * 빈 문단을 남겨 항목 사이에 빈 페이지가 생기므로, 강제 나눔 없이 표가 자연스럽게 흐르게 한다.
 */
export function buildFormFillEdits(
  table: FormSourceTable,
  entries: FormFillEntry[],
  anchorTargetId: string,
  pageBreak = true,
): FormFillEditPlan[] {
  return entries.map((entry) => {
    const { cellFills, skipped, bodyImages, bodyTables } = buildFormFillMapping(table, entry);
    const edit: Edit = {
      command: 'INSERT_AFTER',
      target_id: anchorTargetId,
      payload: {
        type: 'clone_table',
        page_break: pageBreak,
        clone_table: {
          clone_from: {
            section: table.section,
            paragraph: table.paragraph,
            control_index: table.control_index,
          },
          cell_fills: cellFills,
          body_images: bodyImages.length > 0 ? bodyImages : undefined,
          body_tables: bodyTables.length > 0 ? bodyTables : undefined,
        },
      },
    };
    return { edit, skipped };
  });
}

/** `sec[para]` 위치에 표를 만들고 matrix 텍스트로 셀을 채운다. */
function createTableAt(wasm: WasmEditing, sec: number, para: number, edit: Edit): void {
  const data = edit.payload.table_data!;
  const rows = data.rows;
  const cols = data.cols;
  const result = wasm.createTable(sec, para, 0, rows, cols);
  if (!result.ok) throw new Error('표 생성에 실패했습니다.');
  // 페이지보다 큰 셀/행이 다음 쪽으로 흘러가도록 '셀 단위 나눔'으로 둔다. 기본값(없음)이면
  // 페이지 경계에 걸친 긴 셀(예: 긴 비고)이 잘려 보인다.
  try {
    wasm.setTableProperties?.(sec, result.paraIdx, result.controlIdx, { pageBreak: 1 });
  } catch {
    /* 표 속성 설정 실패는 무시(표 내용은 정상) */
  }
  // 표가 든 문단에 위/아래 간격을 줘 표가 본문에 다닥다닥 붙지 않게 한다.
  try {
    wasm.applyParaFormat?.(
      sec,
      result.paraIdx,
      JSON.stringify({
        spacingBefore: activeTheme.tableParaSpacing,
        spacingAfter: activeTheme.tableParaSpacing,
      }),
    );
  } catch {
    /* 간격 적용 실패는 무시(표 내용은 정상) */
  }
  const matrix = data.matrix ?? [];
  // 병합에 가려지는 셀(대표=좌상단 셀 제외)은 채우지 않는다. rhwp의 merge_cells는
  // 가려진 셀의 비어있지 않은 문단을 대표 셀로 합치므로, 여기서 같은 텍스트를 넣으면
  // 병합 후 대표 셀에 같은 줄이 rowSpan/colSpan 배수로 중복된다.
  const covered = coveredCellIndices(data.merges ?? [], cols);
  for (let r = 0; r < rows; r += 1) {
    const rowCells = matrix[r] ?? [];
    for (let c = 0; c < cols; c += 1) {
      const value = rowCells[c] ?? '';
      if (!value) continue;
      if (covered.has(r * cols + c)) continue;
      // 최상위 표이므로 flat API로 채운다 → 셀 reflow(줄바꿈·높이 증가)가 일어난다.
      // 셀은 행 우선(row-major) 인덱스.
      wasm.insertTextInCell(sec, result.paraIdx, result.controlIdx, r * cols + c, 0, 0, value);
    }
  }
  // 셀 병합(헤더·세로 병합 등) — 채운 뒤 적용해 좌상단 셀 내용이 유지되게 한다.
  for (const m of data.merges ?? []) {
    try {
      wasm.mergeTableCells(
        sec,
        result.paraIdx,
        result.controlIdx,
        m.start_row,
        m.start_col,
        m.end_row,
        m.end_col,
      );
    } catch {
      /* 잘못된 병합 범위는 무시(표 자체는 유지) */
    }
  }
  // 정렬 보정 + 열 폭 가중치(병합 후). 셀 좌표를 한 번만 조회해 둘 다 처리한다.
  // col_weights를 AI가 주지 않으면 내용 길이로 자동 산정 → 긴 설명 열이 표 가로폭을
  // 채우도록 넓어지고 짧은 열(○/×)은 좁아진다(좁은 칸에 글자가 끼는 것 방지).
  const weights =
    data.col_weights && data.col_weights.length === cols
      ? data.col_weights
      : autoColWeights(matrix, cols);
  styleTableCells(wasm, sec, result.paraIdx, result.controlIdx, weights, cols, matrix);
}

/** 헤더 셀 배경색(연한 청회색) — 표를 깔끔하게 보이게 하는 기본 테마. */


/**
 * matrix 내용 길이로 열별 상대 폭을 자동 산정한다(AI가 col_weights를 안 줄 때).
 * 각 열의 (헤더 포함) 가장 긴 줄 길이를 2~24로 클램프 → 긴 텍스트 열은 넓게, ○/× 같은
 * 짧은 열은 좁게. 헤더가 긴 열(예 '증액가능여부')은 그만큼 최소 폭을 확보한다.
 */
function autoColWeights(matrix: string[][], cols: number): number[] {
  const weights: number[] = [];
  for (let c = 0; c < cols; c += 1) {
    let longest = 1;
    for (const row of matrix) {
      const text = row?.[c] ?? '';
      for (const line of text.split('\n')) longest = Math.max(longest, line.length);
    }
    weights.push(Math.max(2, Math.min(24, longest)));
  }
  return weights;
}

/**
 * 생성된 표의 셀 정렬을 바로잡고(헤더=가운데, 본문=왼쪽) col_weights가 있으면 열 폭을
 * 재분배한다.
 *
 * 정렬 보정 이유: 새 셀 문단은 표를 삽입한 본문 문단의 para_shape를 상속한다. 양식 문서는
 * 라벨을 '배분 정렬(distribute)'로 두는 경우가 많아, 상속하면 셀의 짧은 글자가 칸 너비만큼
 * 벌어져("세목별   사용   용도") 보인다. 표 셀은 명시적으로 왼쪽/가운데 정렬로 덮는다.
 */
function styleTableCells(
  wasm: WasmEditing,
  sec: number,
  para: number,
  ctrl: number,
  weights: number[] | undefined,
  cols: number,
  matrix?: string[][],
): void {
  if (!wasm.getTableCellBboxes) return;
  let cells: Array<{ cellIdx: number; col: number; row: number; colSpan: number }>;
  try {
    cells = wasm.getTableCellBboxes(sec, para, ctrl);
  } catch {
    return; // 좌표 조회 실패 — 내용·구조는 이미 정상이므로 무시.
  }

  // 1) 정렬: 헤더(0행) 가운데, 나머지 왼쪽. 상속된 배분/양쪽 정렬을 덮는다.
  if (wasm.applyParaFormatInCell) {
    for (const c of cells) {
      const alignment = c.row === 0 ? 'center' : 'left';
      try {
        wasm.applyParaFormatInCell(sec, para, ctrl, c.cellIdx, 0, JSON.stringify({ alignment }));
      } catch {
        /* 셀 정렬 실패는 무시 */
      }
    }
  }

  // 2) 헤더(0행) 테마: 연한 배경색 + 굵게 + 세로 가운데. 표를 깔끔하게 보이게 한다.
  for (const c of cells) {
    if (c.row !== 0) continue;
    try {
      wasm.setCellProperties?.(sec, para, ctrl, c.cellIdx, {
        fillType: 'solid',
        fillColor: activeTheme.headerFill,
        verticalAlign: 1, // center
      });
    } catch {
      /* 헤더 배경 실패는 무시 */
    }
    const headerText = matrix?.[0]?.[c.col] ?? '';
    const len = [...headerText].length;
    if (len > 0 && wasm.applyCharFormatInCell) {
      try {
        wasm.applyCharFormatInCell(sec, para, ctrl, c.cellIdx, 0, 0, len, JSON.stringify({ bold: true }));
      } catch {
        /* 헤더 굵게 실패는 무시 */
      }
    }
  }

  // 3) 열 폭 가중치 — 표 전체 폭을 유지한 채 가중치 비율로 재분배(병합 셀은 덮는 열 합).
  if (!weights || weights.length !== cols) return;
  const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0 || !wasm.getTableProperties || !wasm.setCellProperties) return;
  try {
    const tableWidth = wasm.getTableProperties(sec, para, ctrl).tableWidth ?? 0;
    if (tableWidth <= 0) return;
    for (const c of cells) {
      const span = Math.max(1, c.colSpan);
      let w = 0;
      for (let j = c.col; j < c.col + span && j < cols; j += 1) w += Math.max(0, weights[j]);
      if (w <= 0) continue;
      const width = Math.round((tableWidth * w) / total);
      if (width > 0) wasm.setCellProperties(sec, para, ctrl, c.cellIdx, { width });
    }
  } catch {
    /* 폭 조절 실패는 무시(표 내용·구조는 이미 정상) */
  }
}

/**
 * 최상위(flat) 셀 문단 `firstCp`부터 여러 줄을 각각 별도 문단으로 채운다. 첫 줄은
 * 비어 있는 `firstCp`에 넣고, 이후 줄마다 직전 셀 문단 끝에서 분할해 새 문단에 넣는다.
 * 셀 문단 서식은 splitParagraphInCell이 분할 시 원 문단 모양을 상속하므로 유지된다
 * (AC-cf5898). 표 구조(행/열/병합)는 건드리지 않고 셀 내부 문단만 늘린다(AC-f1c06b).
 */
function fillCellLinesFlat(
  wasm: WasmEditing,
  c: CellTarget,
  ci: number,
  ce: number,
  firstCp: number,
  lines: string[],
): void {
  for (let i = 0; i < lines.length; i += 1) {
    const cp = firstCp + i;
    if (i > 0) {
      const prevLen = wasm.getCellParagraphLength(c.sec, c.parentPara, ci, ce, cp - 1);
      wasm.splitParagraphInCell(c.sec, c.parentPara, ci, ce, cp - 1, prevLen);
    }
    if (lines[i]) wasm.insertTextInCell(c.sec, c.parentPara, ci, ce, cp, 0, lines[i]);
  }
}

/**
 * by-path 셀 문단 경로의 마지막 단계 인덱스 `firstCp`부터 여러 줄을 별도 문단으로
 * 채운다. 분할이 원 셀 문단 모양을 상속하므로 서식이 유지된다(AC-cf5898).
 */
function fillCellLinesByPath(
  wasm: WasmEditing,
  c: CellTarget,
  firstCp: number,
  lines: string[],
): void {
  const pathAt = (cellParaIndex: number): string => {
    const path = c.path.map((e) => ({ ...e }));
    path[path.length - 1].cellParaIndex = cellParaIndex;
    return JSON.stringify(path);
  };
  for (let i = 0; i < lines.length; i += 1) {
    const cp = firstCp + i;
    if (i > 0) {
      const prevLen = wasm.getCellParagraphLengthByPath(c.sec, c.parentPara, pathAt(cp - 1));
      wasm.splitParagraphInCellByPath(c.sec, c.parentPara, pathAt(cp - 1), prevLen);
    }
    if (lines[i]) wasm.insertTextInCellByPath(c.sec, c.parentPara, pathAt(cp), 0, lines[i]);
  }
}

function applyOneCell(wasm: WasmEditing, edit: Edit, c: CellTarget): void {
  const text = edit.payload.text ?? '';
  const lines = splitLines(text);

  // 최상위(경로 1단계) 셀·글상자 편집은 flat API로 처리한다 — by-path와 달리
  // reflow가 일어나 긴 텍스트가 줄바꿈되고 높이가 늘어나며, rhwp의 flat 경로는
  // Control::Shape(글상자)·캡션까지 처리하므로 글상자 텍스트 편집(F-21a81b)도 여기로 간다.
  if (c.path.length === 1) {
    const { controlIndex: ci, cellIndex: ce, cellParaIndex: cp } = c.path[0];
    switch (edit.command) {
      case 'REPLACE':
      case 'DELETE': {
        const length = wasm.getCellParagraphLength(c.sec, c.parentPara, ci, ce, cp);
        if (length > 0) wasm.deleteTextInCell(c.sec, c.parentPara, ci, ce, cp, 0, length);
        if (edit.command === 'REPLACE') {
          fillCellLinesFlat(wasm, c, ci, ce, cp, lines);
        }
        return;
      }
      case 'INSERT_AFTER': {
        // 현재 문단 끝에서 분할 → 새 문단(cp+1)에 텍스트(다줄이면 줄마다) 삽입.
        const length = wasm.getCellParagraphLength(c.sec, c.parentPara, ci, ce, cp);
        wasm.splitParagraphInCell(c.sec, c.parentPara, ci, ce, cp, length);
        fillCellLinesFlat(wasm, c, ci, ce, cp + 1, lines);
        return;
      }
      case 'INSERT_BEFORE': {
        // 오프셋 0에서 분할 → 빈 문단이 cp에 생기고 원문은 cp+1로 밀린다. cp에 삽입.
        wasm.splitParagraphInCell(c.sec, c.parentPara, ci, ce, cp, 0);
        fillCellLinesFlat(wasm, c, ci, ce, cp, lines);
        return;
      }
    }
  }

  const pathJson = JSON.stringify(c.path);
  const lastIdx = c.path[c.path.length - 1].cellParaIndex;

  switch (edit.command) {
    case 'INSERT_AFTER': {
      // 현재 셀 문단 끝에서 분할 → 새 문단(i+1)에 텍스트(다줄이면 줄마다) 삽입.
      const length = wasm.getCellParagraphLengthByPath(c.sec, c.parentPara, pathJson);
      wasm.splitParagraphInCellByPath(c.sec, c.parentPara, pathJson, length);
      fillCellLinesByPath(wasm, c, lastIdx + 1, lines);
      break;
    }
    case 'INSERT_BEFORE': {
      // 오프셋 0에서 분할 → 빈 문단이 i에 생기고 원문은 i+1로 밀린다. i에 삽입.
      wasm.splitParagraphInCellByPath(c.sec, c.parentPara, pathJson, 0);
      fillCellLinesByPath(wasm, c, lastIdx, lines);
      break;
    }
    case 'REPLACE': {
      const length = wasm.getCellParagraphLengthByPath(c.sec, c.parentPara, pathJson);
      if (length > 0) wasm.deleteTextInCellByPath(c.sec, c.parentPara, pathJson, 0, length);
      fillCellLinesByPath(wasm, c, lastIdx, lines);
      break;
    }
    case 'DELETE': {
      const length = wasm.getCellParagraphLengthByPath(c.sec, c.parentPara, pathJson);
      if (length > 0) wasm.deleteTextInCellByPath(c.sec, c.parentPara, pathJson, 0, length);
      break;
    }
  }
}
