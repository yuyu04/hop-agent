import { describe, it, expect } from 'vitest';
import {
  buildFormFillMapping,
  buildFormFillEdits,
  applyActionScript,
  type FormSourceTable,
  type FormFillEntry,
  type WasmEditing,
} from './ai-apply';
import type { ActionScript } from './ai-bridge';

// 연구노트 엔트리 양식(6×3). (1,0)=본문 통셀(라벨 없는 단일 col-0 행).
const TABLE: FormSourceTable = {
  section: 0,
  paragraph: 0,
  control_index: 0,
  rows: 6,
  cols: 3,
  cells: [
    { row: 0, col: 0, role: 'label', text: '제목' },
    { row: 0, col: 1, role: 'label', text: '샘플제목' },
    { row: 1, col: 0, role: 'label', text: '샘플본문' },
    { row: 2, col: 0, role: 'label', text: '기록자' },
    { row: 2, col: 2, role: 'label', text: '확인자' },
    { row: 3, col: 0, role: 'label', text: '홍길동' },
    { row: 3, col: 2, role: 'label', text: '홍길동' },
    { row: 4, col: 0, role: 'label', text: '기록 일자' },
    { row: 4, col: 2, role: 'label', text: '확인 일자' },
    { row: 5, col: 0, role: 'label', text: '2025.12.01' },
    { row: 5, col: 2, role: 'label', text: '2025.12.30' },
  ],
};

const B64 = 'aGVsbG8='; // "hello" — 유효 base64

function entryWithImage(): FormFillEntry {
  return {
    fields: [{ label: '제목', value: 'T' }],
    body: ['b0', 'b1', 'b2'],
    images: [
      { after_body_index: 1, data_base64: B64, ext: 'png', width_px: 100, height_px: 50 },
    ],
  };
}

describe('F-46554fae AC1: buildFormFillMapping maps body images to the body cell', () => {
  it('attaches image to body cell (1,0) with after_para + bytes', () => {
    const m = buildFormFillMapping(TABLE, entryWithImage());
    expect(m.bodyImages).toEqual([
      { row: 1, col: 0, after_para: 1, data_base64: B64, ext: 'png', width_px: 100, height_px: 50 },
    ]);
  });

  it('buildFormFillEdits puts body_images on the clone_table payload', () => {
    const plans = buildFormFillEdits(TABLE, [entryWithImage()], 'sec[0].p[9]');
    const bi = plans[0].edit.payload.clone_table?.body_images;
    expect(bi).toBeDefined();
    expect(bi).toHaveLength(1);
    expect(bi?.[0]).toMatchObject({ row: 1, col: 0, after_para: 1, ext: 'png' });
  });
});

/** WasmEditing 목 — clone_table 적용 경로 + insertPictureInCell 기록. */
class FakeWasm {
  calls: string[] = [];
  getParagraphLength(): number {
    return 0;
  }
  splitParagraph(): string {
    return '{"ok":true}';
  }
  mergeParagraph(): string {
    return '{"ok":true}';
  }
  insertPageBreak(s: number, p: number): string {
    return JSON.stringify({ ok: true, paraIdx: p + 1 });
  }
  insertText(): string {
    return '{"ok":true}';
  }
  deleteText(): string {
    return '{"ok":true}';
  }
  copyControl(): string {
    return '{"ok":true}';
  }
  clipboardHasControl(): boolean {
    return true;
  }
  pasteControl(s: number, p: number): string {
    return JSON.stringify({ ok: true, paraIdx: p, controlIdx: 0 });
  }
  getTableCellBboxes(): Array<{ cellIdx: number; col: number; row: number; colSpan: number }> {
    // 본문 통셀 (1,0) = cellIdx 2 (대표 좌표만).
    return [
      { cellIdx: 0, col: 0, row: 0, colSpan: 1 },
      { cellIdx: 1, col: 1, row: 0, colSpan: 2 },
      { cellIdx: 2, col: 0, row: 1, colSpan: 3 },
      { cellIdx: 3, col: 0, row: 2, colSpan: 2 },
      { cellIdx: 4, col: 2, row: 2, colSpan: 1 },
      { cellIdx: 5, col: 0, row: 3, colSpan: 2 },
      { cellIdx: 6, col: 2, row: 3, colSpan: 1 },
      { cellIdx: 7, col: 0, row: 4, colSpan: 2 },
      { cellIdx: 8, col: 2, row: 4, colSpan: 1 },
      { cellIdx: 9, col: 0, row: 5, colSpan: 2 },
      { cellIdx: 10, col: 2, row: 5, colSpan: 1 },
    ];
  }
  getCellParagraphLength(): number {
    return 0;
  }
  deleteTextInCell(): string {
    return '{"ok":true}';
  }
  splitParagraphInCell(): string {
    return '{"ok":true}';
  }
  insertTextInCell(): string {
    return '{"ok":true}';
  }
  insertPictureInCell(
    s: number,
    pp: number,
    ci: number,
    cell: number,
    cellPara: number,
  ): { ok: boolean } {
    this.calls.push(`insertPictureInCell(cell=${cell},after=${cellPara})`);
    return { ok: true };
  }
}

describe('F-46554fae AC2: cloneTableAt inserts body images into the body cell', () => {
  it('calls insertPictureInCell on the body cell at after_para', () => {
    const plans = buildFormFillEdits(TABLE, [entryWithImage()], 'sec[0].p[9]');
    const script: ActionScript = { edits: plans.map((p) => p.edit) };
    const wasm = new FakeWasm();
    applyActionScript(wasm as unknown as WasmEditing, script);
    // 본문 셀 cellIdx=2, after_para=1.
    expect(wasm.calls, JSON.stringify(wasm.calls)).toContain('insertPictureInCell(cell=2,after=1)');
  });
});

describe('F-46554fae AC3: no images → no body_images, no regression', () => {
  it('entry without images yields empty bodyImages and no insertPictureInCell', () => {
    const noImg: FormFillEntry = { fields: [{ label: '제목', value: 'T' }], body: ['b0'] };
    const m = buildFormFillMapping(TABLE, noImg);
    expect(m.bodyImages).toEqual([]);

    const plans = buildFormFillEdits(TABLE, [noImg], 'sec[0].p[9]');
    expect(plans[0].edit.payload.clone_table?.body_images).toBeUndefined();

    const wasm = new FakeWasm();
    applyActionScript(wasm as unknown as WasmEditing, { edits: plans.map((p) => p.edit) });
    expect(wasm.calls.some((c) => c.startsWith('insertPictureInCell'))).toBe(false);
  });
});
