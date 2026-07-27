import { describe, it, expect } from 'vitest';
import {
  chunkTocItems,
  buildTocChunkCloneEdit,
  applyActionScript,
  type FormSourceTable,
  type WasmEditing,
} from './ai-apply';
import type { ActionScript } from './ai-bridge';

// FakeWasm: a mock of WasmEditing, NOT the code under test.
class FakeWasm {
  calls: string[] = [];
  rowCount = 4; // header(0) + 3 data rows initially in the clone
  getParagraphLength() {
    return 0;
  }
  splitParagraph(s: number, p: number) {
    this.calls.push(`splitParagraph(${s},${p})`);
    return '{"ok":true}';
  }
  mergeParagraph() {
    return '{"ok":true}';
  }
  insertPageBreak(s: number, p: number) {
    this.calls.push(`insertPageBreak(${s},${p})`);
    return JSON.stringify({ ok: true, paraIdx: p + 1 });
  }
  insertText() {
    return '{"ok":true}';
  }
  deleteText() {
    return '{"ok":true}';
  }
  copyControl(s: number, p: number, c: number) {
    this.calls.push(`copyControl(${s},${p},${c})`);
    return '{"ok":true}';
  }
  clipboardHasControl() {
    return true;
  }
  pasteControl(s: number, p: number) {
    this.calls.push(`pasteControl(${s},${p})`);
    return JSON.stringify({ ok: true, paraIdx: p, controlIdx: 0 });
  }
  deleteTableRow(s: number, pp: number, ci: number, row: number) {
    this.calls.push(`deleteTableRow(${row})`);
    this.rowCount--;
    return '{"ok":true}';
  }
  insertTableRow(s: number, pp: number, ci: number, row: number, below: boolean) {
    this.calls.push(`insertTableRow(${row},${below})`);
    this.rowCount++;
    return '{"ok":true}';
  }
  // bboxes reflect current rowCount: one cell per (row, col) for cols 0..2
  getTableCellBboxes() {
    const out: Array<{ cellIdx: number; col: number; row: number; colSpan: number }> = [];
    let idx = 0;
    for (let r = 0; r < this.rowCount; r++) {
      for (let c = 0; c < 3; c++) {
        out.push({ cellIdx: idx++, col: c, row: r, colSpan: 1 });
      }
    }
    return out;
  }
  getCellParagraphLength() {
    return 0;
  }
  deleteTextInCell() {
    return '{"ok":true}';
  }
  splitParagraphInCell() {
    return '{"ok":true}';
  }
  insertTextInCell(
    s: number,
    pp: number,
    ci: number,
    cell: number,
    cp: number,
    off: number,
    text: string,
  ) {
    this.calls.push(`insertTextInCell(${cell},"${text}")`);
    return '{"ok":true}';
  }
  setTableProperties() {
    return { ok: true };
  }
}

describe('AC1 — chunkTocItems packs items into page-sized chunks by estimated height', () => {
  it('short titles: ~18 items per chunk, order/total preserved, >1 chunk', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      no: String(i + 1),
      title: '짧은제목', // short → 1 line each
    }));
    const chunks = chunkTocItems(items);

    const flat = chunks.flat();
    expect(flat.length).toBe(50);
    expect(flat[0].no).toBe('1');
    expect(flat[flat.length - 1].no).toBe('50');
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(18);
    }
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('long titles: 60-char title (3 lines each) → ≤6 items per chunk, all present', () => {
    const items = Array.from({ length: 30 }, (_, i) => ({
      no: String(i + 1),
      title: 'x'.repeat(60), // 60 / 26 = ceil → 3 lines
    }));
    const chunks = chunkTocItems(items);

    const flat = chunks.flat();
    expect(flat.length).toBe(30);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(6); // 6 * 3 = 18
    }
  });

  it('single huge item: 200-char title → exactly one chunk containing it', () => {
    const items = [{ no: '1', title: 'y'.repeat(200) }];
    const chunks = chunkTocItems(items);

    expect(chunks.length).toBe(1);
    expect(chunks[0].length).toBe(1);
    expect(chunks[0][0].no).toBe('1');
  });

  it('order/total invariant: flatten chunks deep-equals the input array', () => {
    const items = Array.from({ length: 37 }, (_, i) => ({
      no: String(i + 1),
      title: i % 3 === 0 ? 'z'.repeat(50) : '제목',
    }));
    const chunks = chunkTocItems(items);
    expect(chunks.flat()).toEqual(items);
  });

  it('never produces an empty chunk', () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      no: String(i + 1),
      title: 'q'.repeat((i % 5) * 20 + 5),
    }));
    const chunks = chunkTocItems(items);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });
});

describe('AC2 — buildTocChunkCloneEdit builds a clone_table edit', () => {
  it('produces the expected INSERT_AFTER clone_table edit', () => {
    const tocTable: FormSourceTable = {
      section: 0,
      paragraph: 26,
      control_index: 0,
      rows: 11,
      cols: 3,
      cells: [],
    };
    const chunk = [
      { no: '23', title: 'A' },
      { no: '24', title: 'B' },
    ];
    const edit = buildTocChunkCloneEdit(tocTable, chunk, 'sec[0].p[26]');

    expect(edit.command).toBe('INSERT_AFTER');
    expect(edit.target_id).toBe('sec[0].p[26]');
    expect(edit.payload.type).toBe('clone_table');
    expect(edit.payload.page_break).toBe(true);
    expect(edit.payload.clone_table?.clone_from).toEqual({
      section: 0,
      paragraph: 26,
      control_index: 0,
    });
    expect(edit.payload.clone_table?.toc_rows).toEqual([
      ['23', 'A', ''],
      ['24', 'B', ''],
    ]);
  });
});

describe('AC3 — applyActionScript on a clone_table edit with toc_rows regenerates rows', () => {
  it('keeps header row 0, deletes existing data rows, inserts one row per toc_rows entry', () => {
    const tocTable: FormSourceTable = {
      section: 0,
      paragraph: 26,
      control_index: 0,
      rows: 4,
      cols: 3,
      cells: [],
    };
    const edit = buildTocChunkCloneEdit(
      tocTable,
      [
        { no: '1', title: '가' },
        { no: '2', title: '나' },
      ],
      'sec[0].p[26]',
    );
    const wasm = new FakeWasm();
    applyActionScript(wasm as unknown as WasmEditing, { edits: [edit] } as ActionScript);

    // table cloned
    expect(wasm.calls.some((c) => c.startsWith('copyControl('))).toBe(true);
    expect(wasm.calls.some((c) => c.startsWith('pasteControl('))).toBe(true);

    // existing data rows deleted (3,2,1) but NOT header row 0
    expect(wasm.calls).toContain('deleteTableRow(3)');
    expect(wasm.calls).toContain('deleteTableRow(2)');
    expect(wasm.calls).toContain('deleteTableRow(1)');
    expect(wasm.calls).not.toContain('deleteTableRow(0)');

    // insertTableRow called twice (2 chunk items), with below=true
    const insertRowCalls = wasm.calls.filter((c) => c.startsWith('insertTableRow('));
    expect(insertRowCalls.length).toBe(2);
    for (const c of insertRowCalls) {
      expect(c).toContain('true');
    }

    // titles land in cells via insertTextInCell
    const insertTextCalls = wasm.calls.filter((c) => c.startsWith('insertTextInCell('));
    expect(insertTextCalls.some((c) => c.includes('"가"'))).toBe(true);
    expect(insertTextCalls.some((c) => c.includes('"나"'))).toBe(true);
  });
});
