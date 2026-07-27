import { describe, it, expect } from 'vitest';
import { buildFormFillEdits, applyActionScript, type FormSourceTable, type WasmEditing } from './ai-apply';
import type { ActionScript } from './ai-bridge';

const TABLE: FormSourceTable = {
  section: 0,
  paragraph: 0,
  control_index: 0,
  rows: 2,
  cols: 2,
  cells: [
    { row: 0, col: 0, role: 'label', text: '제목' },
    { row: 0, col: 1, role: 'input', text: '' },
  ],
};
const ENTRIES = [{ fields: [{ label: '제목', value: 'A' }] }];

describe('F-32a1a7d2 AC-cd7fd2d1: buildFormFillEdits page_break default true', () => {
  it('defaults to page_break=true when 4th arg omitted', () => {
    expect(buildFormFillEdits(TABLE, ENTRIES, 'sec[0].p[5]')[0].edit.payload.page_break).toBe(true);
  });
  it('page_break=true when called with true', () => {
    expect(buildFormFillEdits(TABLE, ENTRIES, 'sec[0].p[5]', true)[0].edit.payload.page_break).toBe(true);
  });
  it('page_break=false when called with false', () => {
    expect(buildFormFillEdits(TABLE, ENTRIES, 'sec[0].p[5]', false)[0].edit.payload.page_break).toBe(false);
  });
});

/** WasmEditing 계약의 목(테스트 대상 아님) — clone_table 적용 경로에 필요한 메서드만 구현. */
class FakeWasm {
  calls: string[] = [];
  getParagraphLength(): number {
    return 0;
  }
  splitParagraph(s: number, p: number): string {
    this.calls.push(`splitParagraph(${s},${p})`);
    return '{"ok":true}';
  }
  mergeParagraph(s: number, p: number): string {
    this.calls.push(`mergeParagraph(${s},${p})`);
    return '{"ok":true}';
  }
  insertPageBreak(s: number, p: number): string {
    this.calls.push(`insertPageBreak(${s},${p})`);
    // 모델: split_at(0)가 고아(p)를 남기고 표 문단(반환 paraIdx)은 p+1.
    return JSON.stringify({ ok: true, paraIdx: p + 1, charOffset: 0 });
  }
  insertText(): string {
    return '{"ok":true}';
  }
  deleteText(): string {
    return '{"ok":true}';
  }
  copyControl(s: number, p: number, c: number): string {
    this.calls.push(`copyControl(${s},${p},${c})`);
    return '{"ok":true}';
  }
  clipboardHasControl(): boolean {
    return true;
  }
  pasteControl(s: number, p: number): string {
    this.calls.push(`pasteControl(${s},${p})`);
    return JSON.stringify({ ok: true, paraIdx: p, controlIdx: 0 });
  }
  getTableCellBboxes(): Array<{ cellIdx: number; col: number; row: number; colSpan: number }> {
    return [];
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
  setTableProperties(): { ok: boolean } {
    return { ok: true };
  }
}

describe('F-32a1a7d2 AC-c7d465fa: clone_table page break goes on the anchor (before the table)', () => {
  it('inserts the page break at the anchor paragraph, not after the table', () => {
    // anchor para=5. 쪽나누기는 표 '앞' 앵커(para=5, length=0)에 넣어 표가 새 페이지 머리에서
    // 시작하게 한다 — 표 문단(6)에 넣으면 쪽나누기가 표 '뒤'로 가 빈 페이지가 생긴다.
    const plans = buildFormFillEdits(TABLE, ENTRIES, 'sec[0].p[5]'); // page_break 기본 true
    const script: ActionScript = { edits: plans.map((p) => p.edit) };
    const wasm = new FakeWasm();
    applyActionScript(wasm as unknown as WasmEditing, script);

    expect(wasm.calls, `calls=${JSON.stringify(wasm.calls)}`).toContain('insertPageBreak(0,5)');
    // 표 '뒤'(para 6)에 넣지 않는다 — 그게 빈 페이지의 원인이었다.
    expect(wasm.calls).not.toContain('insertPageBreak(0,6)');
    // 고아 병합으로 표를 건드리지 않는다.
    expect(wasm.calls.some((c) => c.startsWith('mergeParagraph'))).toBe(false);
  });

  it('does not page-break when page_break is false', () => {
    const plans = buildFormFillEdits(TABLE, ENTRIES, 'sec[0].p[5]', false);
    const script: ActionScript = { edits: plans.map((p) => p.edit) };
    const wasm = new FakeWasm();
    applyActionScript(wasm as unknown as WasmEditing, script);
    expect(wasm.calls.some((c) => c.startsWith('insertPageBreak'))).toBe(false);
  });
});
