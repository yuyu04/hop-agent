import { describe, it, expect } from 'vitest';
import {
  pickTocTable,
  buildTocRegenEdits,
  type FormSourceTable,
} from './ai-apply';
import type { Edit } from './ai-bridge';

// ── Fixtures ────────────────────────────────────────────────────────────────

// TOC table: section 1, paragraph 7, control_index 0, rows 4, cols 3.
// Header row 0 has "일련 (쪽)번호" / "제목(내용)" / "비고"; rows 1..3 are old data.
const tocTable: FormSourceTable = {
  section: 1,
  paragraph: 7,
  control_index: 0,
  rows: 4,
  cols: 3,
  cells: [
    { row: 0, col: 0, text: '일련 (쪽)번호' },
    { row: 0, col: 1, text: '제목(내용)' },
    { row: 0, col: 2, text: '비고' },
    { row: 1, col: 0, text: '구1' },
    { row: 1, col: 1, text: '옛 제목 1' },
    { row: 1, col: 2, text: '' },
    { row: 2, col: 0, text: '구2' },
    { row: 2, col: 1, text: '옛 제목 2' },
    { row: 2, col: 2, text: '' },
    { row: 3, col: 0, text: '구3' },
    { row: 3, col: 1, text: '옛 제목 3' },
    { row: 3, col: 2, text: '' },
  ],
};

// Entry-form table: has "제목" and "기록자" but no "일련" / "비고".
const entryForm: FormSourceTable = {
  section: 1,
  paragraph: 2,
  control_index: 0,
  rows: 2,
  cols: 2,
  cells: [
    { row: 0, col: 0, text: '제목' },
    { row: 0, col: 1, text: '' },
    { row: 1, col: 0, text: '기록자' },
    { row: 1, col: 1, text: '' },
  ],
};

// 대외비 table: 2 rows, "대외비(Confidential)".
const daeoebi: FormSourceTable = {
  section: 1,
  paragraph: 0,
  control_index: 0,
  rows: 2,
  cols: 1,
  cells: [
    { row: 0, col: 0, text: '대외비(Confidential)' },
    { row: 1, col: 0, text: '' },
  ],
};

const items = [
  { no: '1', title: '첫 항목' },
  { no: '2', title: '둘째' },
  { no: '3', title: '셋째' },
  { no: '4', title: '넷째' },
];

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AC: pickTocTable selects the table containing both 일련 and 비고', () => {
  it('returns the TOC table from a mixed list (entryForm, daeoebi, tocTable)', () => {
    expect(pickTocTable([entryForm, daeoebi, tocTable])).toBe(tocTable);
  });

  it('returns null when no table has both 일련 and 비고', () => {
    expect(pickTocTable([entryForm, daeoebi])).toBe(null);
  });
});

describe('AC: no-op guard — null table or empty items yields []', () => {
  it('returns [] when tocTable is null', () => {
    expect(buildTocRegenEdits(null, items)).toEqual([]);
  });

  it('returns [] when items is empty', () => {
    expect(buildTocRegenEdits(tocTable, [])).toEqual([]);
  });
});

describe('AC: regenerate rows — keep a data-row donor for styling, one insert per item', () => {
  it('preserves header row 0 and one data-row donor; one insert_row per item', () => {
    const edits = buildTocRegenEdits(tocTable, items);

    const deletes = edits.filter(
      (e) => e.payload?.table_edit?.op === 'delete_row',
    );
    const inserts = edits.filter(
      (e) => e.payload?.table_edit?.op === 'insert_row',
    );

    // rows=4 → data rows 1..3. Donor (row 1) is kept while inserting (so new rows
    // inherit the white/plain DATA style, not the gray/emphasized header style),
    // then removed last. Net: 2 down-deletes (3,2) + 1 donor-delete (1) = 3 deletes.
    expect(deletes.length).toBe(3);
    const deletedRows = deletes.map((e) => e.payload.table_edit?.row);
    expect(deletedRows).not.toContain(0); // header never deleted

    // One insert per item.
    expect(inserts.length).toBe(items.length);
  });
});

describe('AC: deterministic donor-preserving sequence', () => {
  const edits = buildTocRegenEdits(tocTable, items);

  it('deletes extra data rows top-down (3,2) keeping the donor, removing donor (1) last', () => {
    const deletes = edits.filter(
      (e) => e.payload?.table_edit?.op === 'delete_row',
    );
    expect(deletes.map((e) => e.payload.table_edit?.row)).toEqual([3, 2, 1]);
  });

  it('inserts each item below the donor chain (rows 1..N) with below=true and texts', () => {
    const inserts = edits.filter(
      (e) => e.payload?.table_edit?.op === 'insert_row',
    );
    // i-th item inserts below row (1+i): donor=1, then each prior inserted data row.
    expect(inserts.map((e) => e.payload.table_edit?.row)).toEqual([1, 2, 3, 4]);
    for (let i = 0; i < items.length; i++) {
      const ins = inserts[i];
      expect(ins.payload.table_edit?.row).toBe(1 + i);
      expect(ins.payload.table_edit?.below).toBe(true);
      expect(ins.payload.table_edit?.texts).toEqual([
        items[i].no,
        items[i].title,
        '',
      ]);
    }
  });

  it('removes the donor row (1) as the final edit, after all inserts', () => {
    const last = edits[edits.length - 1];
    expect(last.payload.table_edit?.op).toBe('delete_row');
    expect(last.payload.table_edit?.row).toBe(1);
    // every insert precedes the final donor deletion
    const lastInsertIdx = edits.reduce(
      (acc, e, idx) => (e.payload?.table_edit?.op === 'insert_row' ? idx : acc),
      -1,
    );
    expect(lastInsertIdx).toBeLessThan(edits.length - 1);
  });
});

describe('AC: Edit shape — command, target_id coords, and table_edit payload', () => {
  const edits = buildTocRegenEdits(tocTable, items);

  it('every edit is a REPLACE/table_edit referencing sec[1], p[7], tbl[0]', () => {
    for (const e of edits) {
      expect(e.command).toBe('REPLACE');
      expect(e.payload.type).toBe('table_edit');
      expect(e.target_id).toContain('sec[1]');
      expect(e.target_id).toContain('p[7]');
      expect(e.target_id).toContain('tbl[0]');
    }
  });

  it('delete edits carry op delete_row with a row index; insert edits carry insert_row with texts [no,title,""]', () => {
    const deletes = edits.filter(
      (e: Edit) => e.payload?.table_edit?.op === 'delete_row',
    );
    const inserts = edits.filter(
      (e: Edit) => e.payload?.table_edit?.op === 'insert_row',
    );

    for (const e of deletes) {
      expect(e.payload.table_edit?.op).toBe('delete_row');
      expect(typeof e.payload.table_edit?.row).toBe('number');
    }
    for (let i = 0; i < inserts.length; i++) {
      const e = inserts[i];
      expect(e.payload.table_edit?.op).toBe('insert_row');
      expect(e.payload.table_edit?.row).toBe(1 + i);
      expect(e.payload.table_edit?.below).toBe(true);
      expect(e.payload.table_edit?.texts).toEqual([
        items[i].no,
        items[i].title,
        '',
      ]);
    }
  });
});
