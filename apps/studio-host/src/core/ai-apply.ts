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

type LocatedEdit =
  | { kind: 'body'; edit: Edit; sec: number; para: number; order: number }
  | { kind: 'cell'; edit: Edit; cell: CellTarget; order: number };

function locatedSec(item: LocatedEdit): number {
  return item.kind === 'body' ? item.sec : item.cell.sec;
}
function locatedPara(item: LocatedEdit): number {
  return item.kind === 'body' ? item.para : item.cell.parentPara;
}

/**
 * Action Script의 각 편집을 WASM 편집 프리미티브로 변환·적용한다.
 *
 * 다중 편집은 문단 인덱스가 큰 것부터(내림차순) 적용해, 앞선 편집의 문단
 * 삽입/삭제가 뒤따르는 `target_id`의 인덱스를 어긋나게 만들지 않도록 한다.
 */
export function applyActionScript(wasm: WasmEditing, script: ActionScript): ApplyResult {
  const located: LocatedEdit[] = [];
  const skipped: ApplySkip[] = [];

  script.edits.forEach((edit, order) => {
    // INSERT/REPLACE는 새 텍스트가 반드시 있어야 한다. text가 비면 적용 시 원문이
    // 빈 문단으로 지워지므로(조용한 내용 손실), 적용하지 않고 건너뛴다.
    // 표 생성(payload.type="table")은 text가 없어도 되므로 예외다.
    const needsText = edit.command !== 'DELETE' && !isTableEdit(edit);
    if (needsText && (edit.payload.text ?? '') === '') {
      skipped.push({
        targetId: edit.target_id,
        reason: '새 텍스트(payload.text)가 비어 있어 건너뜀 — 모델이 본문을 채우지 못했습니다.',
      });
      return;
    }

    const cell = parseCellTarget(edit.target_id);
    if (cell) {
      // 표 셀 안에는 표를 만들 수 없다(셀은 페이지로 늘어나지 않음). 본문에 만들어야 한다.
      if (isTableEdit(edit)) {
        skipped.push({
          targetId: edit.target_id,
          reason: '표 셀 안에는 표를 만들 수 없습니다. 표 바깥 본문 문단에 INSERT 하세요.',
        });
        return;
      }
      located.push({ kind: 'cell', edit, cell, order });
      return;
    }

    const target = parseParagraphTarget(edit.target_id);
    if (!target) {
      skipped.push({
        targetId: edit.target_id,
        reason: '문단/표 셀 대상이 아닙니다(글상자 등은 아직 미지원).',
      });
      return;
    }
    located.push({ kind: 'body', edit, sec: target.sec, para: target.para, order });
  });

  // 문단 인덱스가 큰 것부터 적용해, 앞선 편집이 뒤 target의 인덱스를 어긋나게
  // 만들지 않도록 한다. 같은 문단에 여러 INSERT_AFTER가 있으면 입력 역순으로
  // 적용해야 문서에 입력 순서대로(정순) 남는다(split→insert가 매번 앞에 끼우므로).
  located.sort(
    (a, b) => locatedSec(b) - locatedSec(a) || locatedPara(b) - locatedPara(a) || b.order - a.order,
  );

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
        applyOneCell(wasm, item.edit, item.cell);
      } else {
        applyOne(wasm, item);
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

function applyOne(
  wasm: WasmEditing,
  { edit, sec, para }: { edit: Edit; sec: number; para: number },
): void {
  const text = edit.payload.text ?? '';
  const pageBreak = edit.payload.page_break === true;
  switch (edit.command) {
    case 'INSERT_AFTER': {
      const length = wasm.getParagraphLength(sec, para);
      wasm.splitParagraph(sec, para, length);
      if (isTableEdit(edit)) {
        createTableAt(wasm, sec, para + 1, edit);
      } else {
        wasm.insertText(sec, para + 1, 0, text);
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
      } else {
        wasm.insertText(sec, para, 0, text);
      }
      if (pageBreak) wasm.insertPageBreak(sec, para, 0);
      break;
    }
    case 'REPLACE': {
      const length = wasm.getParagraphLength(sec, para);
      if (length > 0) wasm.deleteText(sec, para, 0, length);
      wasm.insertText(sec, para, 0, text);
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
}

function applyOneCell(wasm: WasmEditing, edit: Edit, c: CellTarget): void {
  const text = edit.payload.text ?? '';

  // 최상위 표 셀(경로 1단계)의 값 변경/비우기는 flat API로 처리한다 — by-path와
  // 달리 셀 reflow가 일어나 긴 텍스트가 줄바꿈되고 셀 높이가 늘어난다.
  if (c.path.length === 1 && (edit.command === 'REPLACE' || edit.command === 'DELETE')) {
    const { controlIndex: ci, cellIndex: ce, cellParaIndex: cp } = c.path[0];
    const length = wasm.getCellParagraphLength(c.sec, c.parentPara, ci, ce, cp);
    if (length > 0) wasm.deleteTextInCell(c.sec, c.parentPara, ci, ce, cp, 0, length);
    if (edit.command === 'REPLACE') {
      wasm.insertTextInCell(c.sec, c.parentPara, ci, ce, cp, 0, text);
    }
    return;
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
