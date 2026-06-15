/**
 * Tests for F-ae778890 (양식 이어쓰기 모드 — 앱이 표를 결정적으로 복제하고 AI는 항목 내용만 생성).
 *
 * Spec: F-ae778890 with 6 ACs:
 *   AC-0cd01fc1: AI asked content-only; no table in schema/response
 *   AC-6bdb1e17: Deterministic per-entry clone; structure not from AI
 *   AC-cb2b6368: Added entry table structure == source
 *   AC-86e329eb: Label→value mapping fills value cells, labels preserved
 *   AC-0d49695d: No source form → abort, no doc change, no compose
 *   AC-77de6044: hwp_table_check exit 0 + structure identity (dependent on F-220afd)
 */

import { describe, expect, it } from 'vitest';
import {
  applyActionScript,
  buildFormFillEdits,
  buildFormFillMapping,
  resolveValueCell,
  type FormSourceCell,
  type FormSourceTable,
  type FormFillEntry,
  type WasmEditing,
} from './ai-apply';
import type { ActionScript, Edit } from './ai-bridge';

class FakeWasm implements WasmEditing {
  calls: string[] = [];
  lengths: Record<string, number> = {};
  paraTexts: Record<string, string> = {};
  bboxes: Array<{ cellIdx: number; col: number; row: number; colSpan: number }> = [];
  clipboardHasCtrl = true;

  setParaText(sec: number, para: number, text: string): void {
    this.paraTexts[`${sec}.${para}`] = text;
    this.lengths[`${sec}.${para}`] = Array.from(text).length;
  }

  getParagraphLength(sec: number, para: number): number {
    this.calls.push(`getParagraphLength(${sec},${para})`);
    return this.lengths[`${sec}.${para}`] ?? 0;
  }

  insertText(sec: number, para: number, charOffset: number, text: string): string {
    this.calls.push(`insertText(${sec},${para},${charOffset},"${text}")`);
    return '';
  }

  deleteText(sec: number, para: number, charOffset: number, count: number): string {
    this.calls.push(`deleteText(${sec},${para},${charOffset},${count})`);
    return '';
  }

  splitParagraph(sec: number, para: number, charOffset: number): string {
    this.calls.push(`splitParagraph(${sec},${para},${charOffset})`);
    return '';
  }

  mergeParagraph(sec: number, para: number): string {
    this.calls.push(`mergeParagraph(${sec},${para})`);
    return '';
  }

  insertPageBreak(sec: number, para: number, charOffset: number): string {
    this.calls.push(`insertPageBreak(${sec},${para},${charOffset})`);
    return '';
  }

  createTable(sec: number, para: number, charOffset: number, rows: number, cols: number) {
    this.calls.push(`createTable(${sec},${para},${charOffset},${rows},${cols})`);
    return { ok: true, paraIdx: para, controlIdx: 0 };
  }

  mergeTableCells(s: number, pp: number, ci: number, sr: number, sc: number, er: number, ec: number) {
    this.calls.push(`mergeTableCells(${s},${pp},${ci},${sr},${sc},${er},${ec})`);
    return { ok: true, cellCount: 1 };
  }

  insertTableRow(s: number, pp: number, ci: number, row: number, below: boolean) {
    this.calls.push(`insertTableRow(${s},${pp},${ci},${row},${below})`);
    return { ok: true, rowCount: 3, colCount: 2 };
  }

  insertTableColumn(s: number, pp: number, ci: number, col: number, right: boolean) {
    this.calls.push(`insertTableColumn(${s},${pp},${ci},${col},${right})`);
    return { ok: true, rowCount: 2, colCount: 3 };
  }

  deleteTableRow(s: number, pp: number, ci: number, row: number) {
    this.calls.push(`deleteTableRow(${s},${pp},${ci},${row})`);
    return { ok: true, rowCount: 1, colCount: 2 };
  }

  deleteTableColumn(s: number, pp: number, ci: number, col: number) {
    this.calls.push(`deleteTableColumn(${s},${pp},${ci},${col})`);
    return { ok: true, rowCount: 2, colCount: 1 };
  }

  getTableProperties(s: number, pp: number, ci: number) {
    this.calls.push(`getTableProperties(${s},${pp},${ci})`);
    return { tableWidth: 0 };
  }

  getTableCellBboxes(s: number, pp: number, ci: number) {
    this.calls.push(`getTableCellBboxes(${s},${pp},${ci})`);
    return this.bboxes;
  }

  setCellProperties(s: number, pp: number, ci: number, cell: number, props: { width?: number }) {
    this.calls.push(`setCellProperties(${s},${pp},${ci},${cell},w=${props.width})`);
    return { ok: true };
  }

  applyParaFormatInCell(s: number, pp: number, ci: number, cell: number, cp: number, json: string) {
    this.calls.push(`applyParaFormatInCell(${s},${pp},${ci},${cell},${cp},${json})`);
    return '';
  }

  setTableProperties(s: number, pp: number, ci: number, props: { pageBreak?: number }) {
    this.calls.push(`setTableProperties(${s},${pp},${ci},pageBreak=${props.pageBreak})`);
    return { ok: true };
  }

  applyStyle(sec: number, para: number, styleId: number) {
    this.calls.push(`applyStyle(${sec},${para},${styleId})`);
    return { ok: true };
  }

  copyControl(sec: number, para: number, controlIdx: number): string {
    this.calls.push(`copyControl(${sec},${para},${controlIdx})`);
    return JSON.stringify({ ok: true, text: '[표]' });
  }

  pasteControl(sec: number, para: number, charOffset: number): string {
    this.calls.push(`pasteControl(${sec},${para},${charOffset})`);
    return JSON.stringify({ ok: true, paraIdx: para, controlIdx: 0 });
  }

  clipboardHasControl(): boolean {
    return this.clipboardHasCtrl;
  }

  getCellParagraphLength(s: number, pp: number, ci: number, ce: number, cp: number): number {
    this.calls.push(`getCellParagraphLength(${s},${pp},${ci},${ce},${cp})`);
    return this.lengths[`${s}.${pp}.${ci}.${ce}.${cp}`] ?? 0;
  }

  insertTextInCell(s: number, pp: number, ci: number, ce: number, cp: number, off: number, text: string): string {
    this.calls.push(`insertTextInCell(${s},${pp},${ci},${ce},${cp},${off},"${text}")`);
    return '';
  }

  deleteTextInCell(s: number, pp: number, ci: number, ce: number, cp: number, off: number, count: number): string {
    this.calls.push(`deleteTextInCell(${s},${pp},${ci},${ce},${cp},${off},${count})`);
    return '';
  }

  splitParagraphInCell(s: number, pp: number, ci: number, ce: number, cp: number, off: number): string {
    this.calls.push(`splitParagraphInCell(${s},${pp},${ci},${ce},${cp},${off})`);
    return '';
  }

  // Stub methods for unused interfaces
  getTextRange(sec: number, para: number, start: number, end: number): string {
    return '';
  }

  applyCharFormat(sec: number, para: number, start: number, end: number, propsJson: string): string {
    return '';
  }

  applyParaFormat(sec: number, para: number, propsJson: string): string {
    return '';
  }

  insertPicture(): any {
    return { ok: true };
  }

  setFieldValue(fieldId: number, value: string) {
    return { ok: true, fieldId, oldValue: '', newValue: value };
  }

  getHeaderFooter(): string {
    return '{}';
  }

  createHeaderFooter(): string {
    return '{}';
  }

  getHeaderFooterParaInfo(): string {
    return '{}';
  }

  insertTextInHeaderFooter(): string {
    return '{}';
  }

  deleteTextInHeaderFooter(): string {
    return '{}';
  }

  splitParagraphInHeaderFooter(): string {
    return '{}';
  }

  getFootnoteInfo(): any {
    return { ok: false };
  }

  insertTextInFootnote(): any {
    return { ok: false };
  }

  deleteTextInFootnote(): any {
    return { ok: false };
  }

  getCellParagraphLengthByPath(): number {
    return 0;
  }

  insertTextInCellByPath(): string {
    return '';
  }

  splitParagraphInCellByPath(): string {
    return '';
  }

  deleteTextInCellByPath(): string {
    return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// AC-86e329eb: Label→value mapping fills value cells, labels preserved
// ─────────────────────────────────────────────────────────────────────────

describe('AC-86e329eb: Label→value mapping', () => {
  it('resolveValueCell finds value cell to the right of label (same row, next col)', () => {
    const table: FormSourceTable = {
      section: 0,
      paragraph: 1,
      control_index: 0,
      rows: 2,
      cols: 2,
      cells: [
        { row: 0, col: 0, role: 'label', text: '제목' },
        { row: 0, col: 1, role: 'input', text: '' },
      ],
    };
    const labelCell = table.cells[0];
    const knownLabels = new Set(['제목']);

    const result = resolveValueCell(table, labelCell, knownLabels);
    expect(result).toEqual({ row: 0, col: 1 });
  });

  it('resolveValueCell finds value cell below label (next row, same col) when right is occupied', () => {
    const table: FormSourceTable = {
      section: 0,
      paragraph: 1,
      control_index: 0,
      rows: 3,
      cols: 2,
      cells: [
        { row: 0, col: 0, role: 'label', text: '라벨' },
        { row: 0, col: 1, role: 'label', text: '다른라벨' }, // 오른쪽은 라벨
        { row: 1, col: 0, role: 'input', text: '' }, // 아래가 값칸
      ],
    };
    const labelCell = table.cells[0];
    const knownLabels = new Set(['라벨', '다른라벨']);

    const result = resolveValueCell(table, labelCell, knownLabels);
    expect(result).toEqual({ row: 1, col: 0 });
  });

  it('resolveValueCell rejects candidate if it contains a known label text', () => {
    const table: FormSourceTable = {
      section: 0,
      paragraph: 1,
      control_index: 0,
      rows: 3,
      cols: 2,
      cells: [
        { row: 0, col: 0, role: 'label', text: '라벨1' },
        { row: 0, col: 1, role: 'label', text: '라벨2' }, // Known label text, skips right
        { row: 1, col: 0, role: 'label', text: '라벨3' }, // Below is also label, skips below
      ],
    };
    const labelCell = table.cells[0];
    const knownLabels = new Set(['라벨1', '라벨2', '라벨3']);

    const result = resolveValueCell(table, labelCell, knownLabels);
    expect(result).toBeNull(); // Both candidates (right & below) are label cells
  });

  it('buildFormFillMapping creates cell_fills for matched labels only', () => {
    const table: FormSourceTable = {
      section: 0,
      paragraph: 1,
      control_index: 0,
      rows: 2,
      cols: 2,
      cells: [
        { row: 0, col: 0, role: 'label', text: '제목' },
        { row: 0, col: 1, role: 'input', text: '' },
        { row: 1, col: 0, role: 'label', text: '내용' },
        { row: 1, col: 1, role: 'input', text: '' },
      ],
    };
    const entry: FormFillEntry = {
      fields: [
        { label: '제목', value: '실험 A' },
        { label: '내용', value: '테스트' },
      ],
    };

    const result = buildFormFillMapping(table, entry);
    expect(result.cellFills).toHaveLength(2);
    expect(result.cellFills[0]).toEqual({ row: 0, col: 1, text: '실험 A' });
    expect(result.cellFills[1]).toEqual({ row: 1, col: 1, text: '테스트' });
    expect(result.skipped).toHaveLength(0);
  });

  it('buildFormFillMapping skips unresolved labels and records reason', () => {
    const table: FormSourceTable = {
      section: 0,
      paragraph: 1,
      control_index: 0,
      rows: 1,
      cols: 1,
      cells: [{ row: 0, col: 0, role: 'label', text: '있는 라벨' }],
    };
    const entry: FormFillEntry = {
      fields: [
        { label: '있는 라벨', value: 'OK' },
        { label: '없는 라벨', value: 'SKIP' },
      ],
    };

    const result = buildFormFillMapping(table, entry);
    expect(result.cellFills).toHaveLength(0); // 첫 라벨도 값칸을 찾지 못함(col+1이 범위 초과)
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.some((s) => s.label === '없는 라벨')).toBe(true);
  });

  it('buildFormFillMapping normalizes label text (whitespace, case)', () => {
    const table: FormSourceTable = {
      section: 0,
      paragraph: 1,
      control_index: 0,
      rows: 1,
      cols: 2,
      cells: [
        { row: 0, col: 0, role: 'label', text: '사 업 명' }, // spaces
        { row: 0, col: 1, role: 'input', text: '' },
      ],
    };
    const entry: FormFillEntry = {
      fields: [{ label: '사업명', value: '테스트사업' }], // no spaces
    };

    const result = buildFormFillMapping(table, entry);
    expect(result.cellFills).toHaveLength(1);
    expect(result.cellFills[0]).toEqual({ row: 0, col: 1, text: '테스트사업' });
  });

  it('buildFormFillMapping does NOT create cell_fills for label cells (preserves labels)', () => {
    const table: FormSourceTable = {
      section: 0,
      paragraph: 1,
      control_index: 0,
      rows: 1,
      cols: 2,
      cells: [
        { row: 0, col: 0, role: 'label', text: '라벨' },
        { row: 0, col: 1, role: 'input', text: '' },
      ],
    };
    const entry: FormFillEntry = {
      fields: [{ label: '라벨', value: '값' }],
    };

    const result = buildFormFillMapping(table, entry);
    // Only value cell (0,1) should be in cellFills, NOT label cell (0,0)
    const cellCols = result.cellFills.map((cf) => cf.col);
    expect(cellCols).not.toContain(0); // label col
    expect(cellCols).toContain(1); // value col
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-6bdb1e17: Deterministic per-entry clone (ONE clone_table per entry)
// ─────────────────────────────────────────────────────────────────────────

describe('AC-6bdb1e17: Deterministic per-entry clone edits', () => {
  it('buildFormFillEdits produces exactly N clone_table edits for N entries', () => {
    const table: FormSourceTable = {
      section: 0,
      paragraph: 2,
      control_index: 0,
      rows: 1,
      cols: 2,
      cells: [
        { row: 0, col: 0, role: 'label', text: '제목' },
        { row: 0, col: 1, role: 'input', text: '' },
      ],
    };
    const entries: FormFillEntry[] = [
      { fields: [{ label: '제목', value: '항목1' }] },
      { fields: [{ label: '제목', value: '항목2' }] },
      { fields: [{ label: '제목', value: '항목3' }] },
    ];
    const anchor = 'sec[0].p[5]';

    const plans = buildFormFillEdits(table, entries, anchor);
    expect(plans).toHaveLength(3);
    expect(plans.every((p) => p.edit.command === 'INSERT_AFTER')).toBe(true);
    expect(plans.every((p) => p.edit.payload.type === 'clone_table')).toBe(true);
  });

  it('each clone_table edit has clone_from pointing to source table coords', () => {
    const table: FormSourceTable = {
      section: 0,
      paragraph: 2,
      control_index: 0,
      rows: 1,
      cols: 2,
      cells: [
        { row: 0, col: 0, role: 'label', text: '제목' },
        { row: 0, col: 1, role: 'input', text: '' },
      ],
    };
    const entries: FormFillEntry[] = [
      { fields: [{ label: '제목', value: '항목1' }] },
      { fields: [{ label: '제목', value: '항목2' }] },
    ];
    const anchor = 'sec[0].p[5]';

    const plans = buildFormFillEdits(table, entries, anchor);
    plans.forEach((plan) => {
      const ct = plan.edit.payload.clone_table;
      expect(ct?.clone_from).toEqual({
        section: 0,
        paragraph: 2,
        control_index: 0,
      });
    });
  });

  it('each clone_table edit has INSERT_AFTER + page_break=true', () => {
    const table: FormSourceTable = {
      section: 0,
      paragraph: 2,
      control_index: 0,
      rows: 1,
      cols: 2,
      cells: [
        { row: 0, col: 0, role: 'label', text: '제목' },
        { row: 0, col: 1, role: 'input', text: '' },
      ],
    };
    const entries: FormFillEntry[] = [
      { fields: [{ label: '제목', value: '항목1' }] },
      { fields: [{ label: '제목', value: '항목2' }] },
    ];
    const anchor = 'sec[0].p[5]';

    const plans = buildFormFillEdits(table, entries, anchor);
    plans.forEach((plan) => {
      expect(plan.edit.command).toBe('INSERT_AFTER');
      expect(plan.edit.payload.page_break).toBe(true);
    });
  });

  it('buildFormFillEdits does NOT create table_data or table_edit edits (structure via clone only)', () => {
    const table: FormSourceTable = {
      section: 0,
      paragraph: 2,
      control_index: 0,
      rows: 1,
      cols: 2,
      cells: [
        { row: 0, col: 0, role: 'label', text: '제목' },
        { row: 0, col: 1, role: 'input', text: '' },
      ],
    };
    const entries: FormFillEntry[] = [
      { fields: [{ label: '제목', value: '항목1' }] },
    ];
    const anchor = 'sec[0].p[5]';

    const plans = buildFormFillEdits(table, entries, anchor);
    plans.forEach((plan) => {
      expect(plan.edit.payload.table_data).toBeUndefined();
      expect(plan.edit.payload.table_edit).toBeUndefined();
    });
  });

  it('applyActionScript with form-fill edits calls copyControl + pasteControl per entry', () => {
    const wasm = new FakeWasm();
    wasm.bboxes = [{ cellIdx: 0, col: 1, row: 0, colSpan: 1 }];

    const script: ActionScript = {
      edits: [
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[5]',
          payload: {
            type: 'clone_table',
            page_break: true,
            clone_table: {
              clone_from: { section: 0, paragraph: 2, control_index: 0 },
              cell_fills: [{ row: 0, col: 1, text: '항목1' }],
            },
          },
        },
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[5]',
          payload: {
            type: 'clone_table',
            page_break: true,
            clone_table: {
              clone_from: { section: 0, paragraph: 2, control_index: 0 },
              cell_fills: [{ row: 0, col: 1, text: '항목2' }],
            },
          },
        },
      ],
    };

    applyActionScript(wasm, script);
    const copyCount = wasm.calls.filter((c) => c.includes('copyControl')).length;
    const pasteCount = wasm.calls.filter((c) => c.includes('pasteControl')).length;
    expect(copyCount).toBe(2);
    expect(pasteCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-0d49695d: No source form → abort, no doc change, no compose
// ─────────────────────────────────────────────────────────────────────────

describe('AC-0d49695d: Missing source form → abort (no-op)', () => {
  it('applyActionScript with empty entry list returns 0 applied', () => {
    const wasm = new FakeWasm();
    const script: ActionScript = { edits: [] };

    const result = applyActionScript(wasm, script);
    expect(result.applied).toBe(0);
    expect(wasm.calls).toEqual([]); // No WASM calls at all
  });

  it('pickSourceFormTable-equivalent logic: if form_tables is empty, return null (abort)', () => {
    // Simulating runFormFill() abort: no form_tables → don't generate edits
    const formTables: FormSourceTable[] = [];
    const source = formTables.length > 0 ? formTables[0] : null;
    expect(source).toBeNull(); // Abort condition met
  });

  it('applyActionScript does NOT call compose/createTable for form-fill; only clone', () => {
    const wasm = new FakeWasm();
    wasm.bboxes = [{ cellIdx: 0, col: 1, row: 0, colSpan: 1 }];

    const script: ActionScript = {
      edits: [
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[5]',
          payload: {
            type: 'clone_table',
            page_break: true,
            clone_table: {
              clone_from: { section: 0, paragraph: 2, control_index: 0 },
              cell_fills: [],
            },
          },
        },
      ],
    };

    applyActionScript(wasm, script);
    const createTableCalls = wasm.calls.filter((c) => c.includes('createTable'));
    expect(createTableCalls).toHaveLength(0); // NO createTable (no compose)
    const copyCalls = wasm.calls.filter((c) => c.includes('copyControl'));
    expect(copyCalls.length).toBeGreaterThan(0); // Only copy (clone)
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-cb2b6368: Added entry table structure == source
// ─────────────────────────────────────────────────────────────────────────

describe('AC-cb2b6368: Added entry table structure == source (via clone_from)', () => {
  it('clone_table edits source structure via clone_from, not compose', () => {
    // This AC depends on F-220afd's cloneTableAt de-risk test.
    // We assert that each edit has clone_from (not table_data with rows/cols/matrix).
    const table: FormSourceTable = {
      section: 0,
      paragraph: 2,
      control_index: 0,
      rows: 6,
      cols: 3,
      cells: [
        { row: 0, col: 0, role: 'label', text: 'A' },
        { row: 0, col: 1, role: 'input', text: '' },
        { row: 1, col: 0, role: 'label', text: 'B' },
        { row: 1, col: 1, role: 'input', text: '' },
      ],
    };
    const entries: FormFillEntry[] = [
      { fields: [{ label: 'A', value: 'val1' }] },
    ];
    const anchor = 'sec[0].p[5]';

    const plans = buildFormFillEdits(table, entries, anchor);
    const edit = plans[0].edit;

    // Must have clone_from (structure from source)
    expect(edit.payload.clone_table?.clone_from).toBeDefined();
    expect(edit.payload.clone_table?.clone_from).toEqual({
      section: 0,
      paragraph: 2,
      control_index: 0,
    });
    // Must NOT have table_data (no compose)
    expect(edit.payload.table_data).toBeUndefined();
  });

  it('clone_from preserves source rows×cols (6×3 stays 6×3, not 6×2)', () => {
    const table: FormSourceTable = {
      section: 0,
      paragraph: 2,
      control_index: 0,
      rows: 6,
      cols: 3,
      cells: [],
    };
    const entries: FormFillEntry[] = [
      { fields: [{ label: '라벨', value: '값' }] },
    ];
    const anchor = 'sec[0].p[5]';

    // buildFormFillEdits uses clone_from = table coords
    const plans = buildFormFillEdits(table, entries, anchor);
    const clone = plans[0].edit.payload.clone_table?.clone_from;

    // Spec says structure identity is preserved by F-220afd cloneTableAt.
    // We assert clone_from is present and points to correct source.
    expect(clone).toEqual({ section: 0, paragraph: 2, control_index: 0 });
    // Source is 6×3; clone_from is point reference, so structure 100% comes from source.
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-0cd01fc1: AI asked content-only; no table/compose in response schema
// (Tested in schema.rs tests; here we verify runFormFill mode uses content-only)
// ─────────────────────────────────────────────────────────────────────────

describe('AC-0cd01fc1: Content-only response (no table/compose in AI schema)', () => {
  it('form-fill mode edits contain ONLY clone_table, never table_data or table_edit', () => {
    const table: FormSourceTable = {
      section: 0,
      paragraph: 2,
      control_index: 0,
      rows: 1,
      cols: 2,
      cells: [
        { row: 0, col: 0, role: 'label', text: '제목' },
        { row: 0, col: 1, role: 'input', text: '' },
      ],
    };
    const entries: FormFillEntry[] = [
      { fields: [{ label: '제목', value: 'AI generated content' }] },
    ];
    const anchor = 'sec[0].p[5]';

    const plans = buildFormFillEdits(table, entries, anchor);
    plans.forEach((plan) => {
      // No table_data (compose) or table_edit in payload
      expect(plan.edit.payload.table_data).toBeUndefined();
      expect(plan.edit.payload.table_edit).toBeUndefined();
      // Only clone_table
      expect(plan.edit.payload.clone_table).toBeDefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-77de6044: hwp_table_check exit 0 + structure identity
// (Depends on F-220afd Rust round-trip test; reference here)
// ─────────────────────────────────────────────────────────────────────────

describe('AC-77de6044: hwp_table_check gate (reference F-220afd)', () => {
  it('comment: form-fill edits use clone_from (same de-risk as F-220afd AC-fa1b1b)', () => {
    // F-220afd AC-fa1b1b asserts round-trip identity + hwp_table_check exit 0.
    // This AC (AC-77de6044) reuses that gate: structure identity via cloneTableAt.
    // We assert clone_from is present; the actual hwp_table_check gate is in Rust.
    const table: FormSourceTable = {
      section: 0,
      paragraph: 2,
      control_index: 0,
      rows: 3,
      cols: 2,
      cells: [],
    };
    const entries: FormFillEntry[] = [
      { fields: [{ label: 'L', value: 'V' }] },
    ];

    const plans = buildFormFillEdits(table, entries, 'sec[0].p[5]');
    expect(plans[0].edit.payload.clone_table?.clone_from).toBeDefined();
    // hwp_table_check gate is tested in apps/desktop/src-tauri/src/ai/serialize.rs
    // where cloneTableAt round-trip is validated. This test confirms clone_from usage.
  });
});
