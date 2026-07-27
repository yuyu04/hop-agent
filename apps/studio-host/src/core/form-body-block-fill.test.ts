import { describe, it, expect } from 'vitest';
import {
  buildFormFillMapping,
  resolveBodyCell,
  type FormSourceTable,
  type FormSourceCell,
  type FormFillEntry,
} from './ai-apply';

// ---------------------------------------------------------------------------
// Fixtures (built ONLY from the spec brief — implementation not consulted).
// ---------------------------------------------------------------------------

// Positive fixture: research-note entry form, 6 rows x 3 cols.
// Merged cells appear as ONE representative top-left cell.
//  (0,0) "제목"      ; (0,1) title value
//  (1,0) BODY cell   <- ONLY single-cell row (full-width span)
//  (2,0) "기록자"    ; (2,2) "확인자"
//  (3,0) recorder    ; (3,2) confirmer
//  (4,0) "기록 일자" ; (4,2) "확인 일자"
//  (5,0) record-date ; (5,2) confirm-date
function makePositiveTable(bodyCellText = ''): FormSourceTable {
  const cells: FormSourceCell[] = [
    { row: 0, col: 0, role: 'label', text: '제목' },
    { row: 0, col: 1, role: 'input', text: '' },
    { row: 1, col: 0, role: 'input', text: bodyCellText },
    { row: 2, col: 0, role: 'label', text: '기록자' },
    { row: 2, col: 2, role: 'label', text: '확인자' },
    { row: 3, col: 0, role: 'input', text: '' },
    { row: 3, col: 2, role: 'input', text: '' },
    { row: 4, col: 0, role: 'label', text: '기록 일자' },
    { row: 4, col: 2, role: 'label', text: '확인 일자' },
    { row: 5, col: 0, role: 'input', text: '' },
    { row: 5, col: 2, role: 'input', text: '' },
  ];
  return {
    section: 0,
    paragraph: 0,
    control_index: 0,
    rows: 6,
    cols: 3,
    cells,
  };
}

// Negative fixture (AC-fee48dae): every row has >=2 cells, no full-width
// single-col-0 row. Pure label|value grid.
function makeNoBodyCellTable(): FormSourceTable {
  const cells: FormSourceCell[] = [
    { row: 0, col: 0, role: 'label', text: '기록자' },
    { row: 0, col: 1, role: 'input', text: '' },
    { row: 1, col: 0, role: 'label', text: '확인자' },
    { row: 1, col: 1, role: 'input', text: '' },
  ];
  return {
    section: 0,
    paragraph: 0,
    control_index: 0,
    rows: 2,
    cols: 2,
    cells,
  };
}

// A table whose only full-width single cell IS a meta label -> not a body cell.
function makeSingleMetaLabelTable(): FormSourceTable {
  const cells: FormSourceCell[] = [
    { row: 0, col: 0, role: 'label', text: '기록자' },
  ];
  return {
    section: 0,
    paragraph: 0,
    control_index: 0,
    rows: 1,
    cols: 1,
    cells,
  };
}

// ---------------------------------------------------------------------------
// AC-b8ccc308 [event] — multi-paragraph body fills body cell, one source
// paragraph = one cell paragraph (newline-joined text, not flattened).
// ---------------------------------------------------------------------------
describe('AC-b8ccc308: multi-paragraph body fills the body cell preserving paragraphs', () => {
  it('AC-b8ccc308 emits a single cellFill whose text joins body paragraphs with "\\n"', () => {
    const table = makePositiveTable();
    const body = ['첫 번째 단락입니다.', '두 번째 단락입니다.', '세 번째 단락입니다.'];
    const entry: FormFillEntry = {
      fields: [
        { label: '제목', value: '연구노트 제목' },
        { label: '기록자', value: '홍길동' },
      ],
      body,
    };

    const mapping = buildFormFillMapping(table, entry);

    // The body cell is at (1,0) per the deterministic resolution.
    const bodyFill = mapping.cellFills.find((f) => f.row === 1 && f.col === 0);
    expect(bodyFill).toBeDefined();
    expect(bodyFill!.text).toBe(body.join('\n'));

    // Must NOT flatten: with >1 paragraph, the joined text contains newlines.
    expect(bodyFill!.text).toContain('\n');
    expect(bodyFill!.text.split('\n')).toHaveLength(body.length);
  });

  it('AC-b8ccc308 a single-paragraph body still fills the body cell with that paragraph', () => {
    const table = makePositiveTable();
    const body = ['하나의 단락만 있습니다.'];
    const entry: FormFillEntry = {
      fields: [],
      body,
    };

    const mapping = buildFormFillMapping(table, entry);

    const bodyFill = mapping.cellFills.find((f) => f.row === 1 && f.col === 0);
    expect(bodyFill).toBeDefined();
    expect(bodyFill!.text).toBe(body.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// AC-51906c63 [ubiquitous] — deterministic body-cell identification.
// ---------------------------------------------------------------------------
describe('AC-51906c63: body cell identified deterministically (single col-0 cell, not a meta label)', () => {
  it('AC-51906c63 resolveBodyCell returns {row:1,col:0} on the positive fixture', () => {
    const table = makePositiveTable();
    const resolved = resolveBodyCell(table, new Set<string>());
    expect(resolved).toEqual({ row: 1, col: 0 });
  });

  it('AC-51906c63 resolveBodyCell returns null when the only single cell IS a meta label', () => {
    const table = makeSingleMetaLabelTable();
    const resolved = resolveBodyCell(table, new Set<string>());
    expect(resolved).toBeNull();
  });

  it('AC-51906c63 buildFormFillMapping fills the deterministically chosen body cell (row 1, col 0)', () => {
    const table = makePositiveTable();
    const body = ['본문 텍스트'];
    const entry: FormFillEntry = { fields: [], body };

    const mapping = buildFormFillMapping(table, entry);
    const bodyFill = mapping.cellFills.find((f) => f.text === body.join('\n'));
    expect(bodyFill).toBeDefined();
    expect(bodyFill!.row).toBe(1);
    expect(bodyFill!.col).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-fee48dae [unwanted] — body present but no body cell -> recorded in
// skipped (not silently dropped), and not present in cellFills.
// ---------------------------------------------------------------------------
describe('AC-fee48dae: body with no identifiable body cell is recorded in skipped, not dropped', () => {
  it('AC-fee48dae skipped gains an entry mentioning the body / 본문, and body text is not in cellFills', () => {
    const table = makeNoBodyCellTable();
    const body = ['이 본문은 채울 셀이 없습니다.', '두 번째 단락.'];
    const entry: FormFillEntry = {
      fields: [
        { label: '기록자', value: '홍길동' },
        { label: '확인자', value: '김철수' },
      ],
      body,
    };

    const mapping = buildFormFillMapping(table, entry);

    // Body text must NOT appear in any cellFill.
    const joined = body.join('\n');
    const leaked = mapping.cellFills.some(
      (f) => f.text === joined || body.some((p) => f.text.includes(p)),
    );
    expect(leaked).toBe(false);

    // There must be a skipped entry whose reason mentions body / 본문.
    const bodySkip = mapping.skipped.find((s) =>
      /body|본문/i.test(s.reason),
    );
    expect(bodySkip).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// AC-ad756684 [ubiquitous] — entry with NO body (undefined / empty /
// whitespace-only) produces no extra body cellFill and no extra skip.
// ---------------------------------------------------------------------------
describe('AC-ad756684: entry with no body is unchanged (no extra body cellFill, no extra skip)', () => {
  it('AC-ad756684 undefined body: no body cellFill at (1,0) and no body-related skip', () => {
    const table = makePositiveTable();
    const entry: FormFillEntry = {
      fields: [{ label: '제목', value: '연구노트 제목' }],
      // body undefined
    };

    const mapping = buildFormFillMapping(table, entry);

    const bodyFill = mapping.cellFills.find((f) => f.row === 1 && f.col === 0);
    expect(bodyFill).toBeUndefined();

    const bodySkip = mapping.skipped.find((s) => /본문/i.test(s.reason));
    expect(bodySkip).toBeUndefined();
  });

  it('AC-ad756684 empty body array: no body cellFill and no body-related skip', () => {
    const table = makePositiveTable();
    const entry: FormFillEntry = {
      fields: [{ label: '제목', value: '연구노트 제목' }],
      body: [],
    };

    const mapping = buildFormFillMapping(table, entry);

    const bodyFill = mapping.cellFills.find((f) => f.row === 1 && f.col === 0);
    expect(bodyFill).toBeUndefined();

    const bodySkip = mapping.skipped.find((s) => /본문/i.test(s.reason));
    expect(bodySkip).toBeUndefined();
  });

  it('AC-ad756684 whitespace-only body: no body cellFill and no body-related skip', () => {
    const table = makePositiveTable();
    const entry: FormFillEntry = {
      fields: [{ label: '제목', value: '연구노트 제목' }],
      body: ['   ', '\t', ''],
    };

    const mapping = buildFormFillMapping(table, entry);

    const bodyFill = mapping.cellFills.find((f) => f.row === 1 && f.col === 0);
    expect(bodyFill).toBeUndefined();

    const bodySkip = mapping.skipped.find((s) => /본문/i.test(s.reason));
    expect(bodySkip).toBeUndefined();
  });
});
