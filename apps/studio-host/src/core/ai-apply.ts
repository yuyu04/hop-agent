/**
 * Action Script를 라이브 WASM 문서 엔진에 적용한다(스펙 4장 — 승인 시점).
 *
 * 화면 문서는 WASM rhwp 엔진이 그리므로, 승인된 편집은 이 엔진에 적용한 뒤
 * `eventBus.emit('document-changed')`로 재렌더한다(적용은 호출 측에서 트리거).
 * 여기서는 순수하게 편집 변환만 수행해 테스트 가능하게 한다.
 */

import type { ActionScript, Edit } from './ai-bridge';

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
  ): Array<{ cellIdx: number; col: number; row: number; colSpan: number }>;
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
  /** 표 속성(쪽 나눔 등). pageBreak: 0=없음, 1=셀 단위, 2=행 단위. */
  setTableProperties?(
    sec: number,
    parentPara: number,
    controlIdx: number,
    props: { pageBreak?: number },
  ): { ok: boolean };
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

type LocatedEdit =
  | { kind: 'body'; edit: Edit; sec: number; para: number; order: number }
  | { kind: 'cell'; edit: Edit; cell: CellTarget; order: number }
  | { kind: 'hf'; edit: Edit; hf: HeaderFooterTarget; order: number }
  | { kind: 'fn'; edit: Edit; fn: FootnoteTarget; order: number };

function locatedSec(item: LocatedEdit): number {
  if (item.kind === 'body') return item.sec;
  if (item.kind === 'cell') return item.cell.sec;
  if (item.kind === 'hf') return item.hf.sec;
  return item.fn.sec;
}
function locatedPara(item: LocatedEdit): number {
  if (item.kind === 'body') return item.para;
  if (item.kind === 'cell') return item.cell.parentPara;
  // 머리말/꼬리말은 본문 인덱스와 무관 — 항상 마지막에 적용되도록 -1.
  if (item.kind === 'hf') return -1;
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
): ApplyResult {
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
      // 표 셀 안에는 표/이미지를 넣지 않는다(셀은 페이지로 늘어나지 않음). 본문에 넣는다.
      if (isTableEdit(edit) || isImageEdit(edit)) {
        skipped.push({
          targetId: edit.target_id,
          reason: '표 셀 안에는 표·이미지를 넣을 수 없습니다. 표 바깥 본문 문단에 INSERT 하세요.',
        });
        return;
      }
      located.push({ kind: 'cell', edit, cell, order });
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
    return b.order - a.order;
  });

  // 본문 INSERT/REPLACE의 최종 위치를 추적한다. 적용 순서(내림차순)에서 낮은
  // 문단에 삽입이 일어나면 이미 기록된(더 높은) 위치를 +1 밀어 정합을 유지한다.
  const changed: ChangedPara[] = [];
  const shiftFrom = (sec: number, fromPara: number) => {
    for (const c of changed) if (c.sec === sec && c.para >= fromPara) c.para += 1;
  };

  let applied = 0;
  for (const item of located) {
    try {
      if (item.kind === 'cell') {
        if (isTableStructEdit(item.edit)) applyTableEdit(wasm, item.edit, item.cell);
        else applyOneCell(wasm, item.edit, item.cell);
      } else if (item.kind === 'hf') {
        applyOneHeaderFooter(wasm, item.edit, item.hf);
      } else if (item.kind === 'fn') {
        applyOneFootnote(wasm, item.edit, item.fn);
      } else if (isFormatEdit(item.edit)) {
        // 부분 서식 — 텍스트는 그대로, 지정 범위 런에만 글자 서식을 입힌다.
        applyFormatEdit(wasm, item.edit, item.sec, item.para);
        changed.push({ sec: item.sec, para: item.para });
      } else {
        applyOne(wasm, item, images);
        const { sec, para, edit } = item;
        if (edit.command === 'INSERT_AFTER') {
          shiftFrom(sec, para + 1);
          changed.push({ sec, para: para + 1 });
        } else if (edit.command === 'INSERT_BEFORE') {
          shiftFrom(sec, para);
          changed.push({ sec, para });
        } else if (edit.command === 'REPLACE') {
          changed.push({ sec, para });
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
// 주의: spacingBefore/After·marginLeft는 rhwp ParaShape에 그대로 쓰이는 HWPUNIT이다
// (1pt = 100). pt 감각으로 작은 숫자를 넣으면 사실상 0이 되어 문단이 다닥다닥 붙는다.
const PARA_STYLES: Record<string, { char?: Record<string, unknown>; para?: Record<string, unknown> }> = {
  title: {
    char: { bold: true, fontSize: 1800, textColor: '#1A1A1A' },
    para: { alignment: 'center', spacingBefore: 400, spacingAfter: 1000 }, // 4pt / 10pt
  },
  heading: {
    char: { bold: true, fontSize: 1400, textColor: '#1F3864' },
    para: { spacingBefore: 1200, spacingAfter: 400 }, // 12pt / 4pt
  },
  subheading: {
    char: { bold: true, fontSize: 1200, textColor: '#2F2F2F' },
    para: { spacingBefore: 800, spacingAfter: 200 }, // 8pt / 2pt
  },
  body: {
    char: { fontSize: 1000 },
    // 줄간격 넉넉히 + 문단 아래 6pt → 빽빽하지 않고 자연스러운 흐름.
    para: { alignment: 'justify', lineSpacingType: 'Percent', lineSpacing: 180, spacingAfter: 600 },
  },
  caption: {
    char: { fontSize: 900, textColor: '#666666' },
    para: { alignment: 'center', spacingBefore: 200, spacingAfter: 800 }, // 2pt / 8pt
  },
  quote: {
    char: { italic: true, textColor: '#444444' },
    para: { marginLeft: 2000, lineSpacingType: 'Percent', lineSpacing: 160 }, // 들여쓰기 20pt
  },
  emphasis: { char: { bold: true } },
};

/** 삽입된 본문 문단(sec,para)의 [0,len)에 semantic 스타일을 적용한다. 미지정·미지원이면 무시. */
function applyParaStyle(wasm: WasmEditing, sec: number, para: number, text: string, style?: string): void {
  if (!style) return;
  const spec = PARA_STYLES[style];
  if (!spec) return;
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

function applyOne(
  wasm: WasmEditing,
  { edit, sec, para }: { edit: Edit; sec: number; para: number },
  images: ImageForInsert[],
): void {
  const text = edit.payload.text ?? '';
  const pageBreak = edit.payload.page_break === true;
  switch (edit.command) {
    case 'INSERT_AFTER': {
      const length = wasm.getParagraphLength(sec, para);
      wasm.splitParagraph(sec, para, length);
      if (isTableEdit(edit)) {
        createTableAt(wasm, sec, para + 1, edit);
      } else if (isImageEdit(edit)) {
        insertImageAt(wasm, sec, para + 1, edit, images);
      } else {
        wasm.insertText(sec, para + 1, 0, text);
        // 새 문단은 style 미지정 시 body 기본 — 미적용 시 문단 간격 0으로 빽빽해진다.
        applyParaStyle(wasm, sec, para + 1, text, edit.payload.style ?? 'body');
      }
      // 새 문단을 새 페이지에서 시작(긴 새 내용/새 절 추가용).
      if (pageBreak) wasm.insertPageBreak(sec, para + 1, 0);
      break;
    }
    case 'INSERT_BEFORE': {
      // 오프셋 0에서 분할하면 빈 문단이 para 위치에 생기고 원문은 para+1로 밀린다.
      wasm.splitParagraph(sec, para, 0);
      if (isTableEdit(edit)) {
        createTableAt(wasm, sec, para, edit);
      } else if (isImageEdit(edit)) {
        insertImageAt(wasm, sec, para, edit, images);
      } else {
        wasm.insertText(sec, para, 0, text);
        applyParaStyle(wasm, sec, para, text, edit.payload.style ?? 'body');
      }
      if (pageBreak) wasm.insertPageBreak(sec, para, 0);
      break;
    }
    case 'REPLACE': {
      const length = wasm.getParagraphLength(sec, para);
      if (length > 0) wasm.deleteText(sec, para, 0, length);
      wasm.insertText(sec, para, 0, text);
      applyParaStyle(wasm, sec, para, text, edit.payload.style);
      break;
    }
    case 'DELETE': {
      const length = wasm.getParagraphLength(sec, para);
      if (length > 0) wasm.deleteText(sec, para, 0, length);
      // 문단 경계를 이웃과 병합해 빈 문단을 제거한다.
      wasm.mergeParagraph(sec, para > 0 ? para : 1);
      break;
    }
  }
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
const HEADER_FILL = '#E8EEF6';

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
        fillColor: HEADER_FILL,
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

function applyOneCell(wasm: WasmEditing, edit: Edit, c: CellTarget): void {
  const text = edit.payload.text ?? '';

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
          wasm.insertTextInCell(c.sec, c.parentPara, ci, ce, cp, 0, text);
        }
        return;
      }
      case 'INSERT_AFTER': {
        // 현재 문단 끝에서 분할 → 새 문단(cp+1)에 텍스트 삽입.
        const length = wasm.getCellParagraphLength(c.sec, c.parentPara, ci, ce, cp);
        wasm.splitParagraphInCell(c.sec, c.parentPara, ci, ce, cp, length);
        wasm.insertTextInCell(c.sec, c.parentPara, ci, ce, cp + 1, 0, text);
        return;
      }
      case 'INSERT_BEFORE': {
        // 오프셋 0에서 분할 → 빈 문단이 cp에 생기고 원문은 cp+1로 밀린다. cp에 삽입.
        wasm.splitParagraphInCell(c.sec, c.parentPara, ci, ce, cp, 0);
        wasm.insertTextInCell(c.sec, c.parentPara, ci, ce, cp, 0, text);
        return;
      }
    }
  }

  const pathJson = JSON.stringify(c.path);

  // 경로 마지막 단계의 cellParaIndex만 바꿔 같은 셀의 다른 문단을 가리킨다.
  const pathAt = (cellParaIndex: number): string => {
    const path = c.path.map((e) => ({ ...e }));
    path[path.length - 1].cellParaIndex = cellParaIndex;
    return JSON.stringify(path);
  };
  const lastIdx = c.path[c.path.length - 1].cellParaIndex;

  switch (edit.command) {
    case 'INSERT_AFTER': {
      // 현재 셀 문단 끝에서 분할 → 새 문단(i+1)에 텍스트 삽입.
      const length = wasm.getCellParagraphLengthByPath(c.sec, c.parentPara, pathJson);
      wasm.splitParagraphInCellByPath(c.sec, c.parentPara, pathJson, length);
      wasm.insertTextInCellByPath(c.sec, c.parentPara, pathAt(lastIdx + 1), 0, text);
      break;
    }
    case 'INSERT_BEFORE': {
      // 오프셋 0에서 분할 → 빈 문단이 i에 생기고 원문은 i+1로 밀린다. i에 삽입.
      wasm.splitParagraphInCellByPath(c.sec, c.parentPara, pathJson, 0);
      wasm.insertTextInCellByPath(c.sec, c.parentPara, pathJson, 0, text);
      break;
    }
    case 'REPLACE': {
      const length = wasm.getCellParagraphLengthByPath(c.sec, c.parentPara, pathJson);
      if (length > 0) wasm.deleteTextInCellByPath(c.sec, c.parentPara, pathJson, 0, length);
      wasm.insertTextInCellByPath(c.sec, c.parentPara, pathJson, 0, text);
      break;
    }
    case 'DELETE': {
      const length = wasm.getCellParagraphLengthByPath(c.sec, c.parentPara, pathJson);
      if (length > 0) wasm.deleteTextInCellByPath(c.sec, c.parentPara, pathJson, 0, length);
      break;
    }
  }
}
