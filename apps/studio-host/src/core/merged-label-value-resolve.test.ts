import { describe, it, expect } from 'vitest';
import {
  resolveValueCell,
  type FormSourceTable,
  type FormSourceCell,
} from './ai-apply';

/**
 * Fixture: research-note entry form, 6 rows x 3 cols.
 * Merged cells appear ONLY as their single representative (top-left) coord;
 * positions hidden under a merge are ABSENT from `cells`.
 *
 * Layout (per spec):
 *  (0,0) "제목"        | (0,1) title value | (0,2) ...
 *  (2,0) "기록자" 1x2 merge -> (2,1) ABSENT | (2,2) "확인자"
 *  (3,0) recorder value      | (3,2) confirmer value
 *  (4,0) "기록 일자" 1x2 merge -> (4,1) ABSENT
 *  (5,0) date value
 */
function buildTable(): FormSourceTable {
  const cells: FormSourceCell[] = [
    // row 0: plain 1-col label + value
    { row: 0, col: 0, role: 'label', text: '제목' },
    { row: 0, col: 1, role: 'value', text: '' },
    { row: 0, col: 2, role: 'value', text: '' },
    // row 2: (2,0) is a 1x2 horizontal merge => (2,1) is ABSENT
    { row: 2, col: 0, role: 'label', text: '기록자' },
    { row: 2, col: 2, role: 'label', text: '확인자' },
    // row 3: value cells under the row-2 labels
    { row: 3, col: 0, role: 'value', text: '' },
    { row: 3, col: 2, role: 'value', text: '' },
    // row 4: (4,0) is a 1x2 horizontal merge => (4,1) is ABSENT
    { row: 4, col: 0, role: 'label', text: '기록 일자' },
    // row 5: date value cell under the row-4 label
    { row: 5, col: 0, role: 'value', text: '' },
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

function cellAt(table: FormSourceTable, row: number, col: number): FormSourceCell {
  const found = table.cells.find((c) => c.row === row && c.col === col);
  if (!found) {
    throw new Error(`fixture error: no cell at (${row},${col})`);
  }
  return found;
}

function isRealCell(table: FormSourceTable, coord: { row: number; col: number }): boolean {
  return table.cells.some((c) => c.row === coord.row && c.col === coord.col);
}

describe('F-addf13c1 resolveValueCell', () => {
  describe('AC: merged label resolves to the cell BELOW (right coord is hidden under its own merge)', () => {
    it('on (2,0) "기록자" 1x2 merge returns {3,0}, NOT the merged-away {2,1}', () => {
      const table = buildTable();
      const result = resolveValueCell(table, cellAt(table, 2, 0), new Set());
      expect(result).toEqual({ row: 3, col: 0 });
      expect(result).not.toEqual({ row: 2, col: 1 });
    });

    it('on (4,0) "기록 일자" 1x2 merge returns {5,0}', () => {
      const table = buildTable();
      const result = resolveValueCell(table, cellAt(table, 4, 0), new Set());
      expect(result).toEqual({ row: 5, col: 0 });
    });
  });

  describe('AC: only returns a coordinate that is a REAL cell present in table.cells', () => {
    it('result for merged label (2,0) corresponds to a real cell', () => {
      const table = buildTable();
      const result = resolveValueCell(table, cellAt(table, 2, 0), new Set());
      expect(result).not.toBeNull();
      expect(isRealCell(table, result!)).toBe(true);
      // the merged-away coordinate is never returned
      expect(isRealCell(table, { row: 2, col: 1 })).toBe(false);
    });

    it('result for merged label (4,0) corresponds to a real cell', () => {
      const table = buildTable();
      const result = resolveValueCell(table, cellAt(table, 4, 0), new Set());
      expect(result).not.toBeNull();
      expect(isRealCell(table, result!)).toBe(true);
      expect(isRealCell(table, { row: 4, col: 1 })).toBe(false);
    });
  });

  describe('AC: no regression for non-merged labels', () => {
    it('on plain label (0,0) returns the right neighbor {0,1}', () => {
      const table = buildTable();
      const result = resolveValueCell(table, cellAt(table, 0, 0), new Set());
      expect(result).toEqual({ row: 0, col: 1 });
      expect(isRealCell(table, result!)).toBe(true);
    });

    it('on col-2 label (2,2) "확인자" (right out of bounds) returns the cell below {3,2}', () => {
      const table = buildTable();
      const result = resolveValueCell(table, cellAt(table, 2, 2), new Set());
      expect(result).toEqual({ row: 3, col: 2 });
      expect(isRealCell(table, result!)).toBe(true);
    });
  });
});
