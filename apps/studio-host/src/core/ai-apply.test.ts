import { describe, expect, it } from 'vitest';
import { applyActionScript, type WasmEditing } from './ai-apply';
import type { ActionScript } from './ai-bridge';

class FakeWasm implements WasmEditing {
  calls: string[] = [];
  lengths: Record<string, number> = {};

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
}

function script(edits: ActionScript['edits']): ActionScript {
  return { edits };
}

describe('applyActionScript', () => {
  it('INSERT_AFTER splits then inserts into the new paragraph', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.1'] = 5;
    const result = applyActionScript(
      wasm,
      script([
        { command: 'INSERT_AFTER', target_id: 'sec[0].p[1]', payload: { type: 'paragraph', text: '새 문단' } },
      ]),
    );
    expect(result.applied).toBe(1);
    expect(wasm.calls).toEqual([
      'getParagraphLength(0,1)',
      'splitParagraph(0,1,5)',
      'insertText(0,2,0,"새 문단")',
    ]);
  });

  it('INSERT_BEFORE splits at offset 0 and fills the new paragraph', () => {
    const wasm = new FakeWasm();
    applyActionScript(
      wasm,
      script([{ command: 'INSERT_BEFORE', target_id: 'sec[0].p[0]', payload: { text: 'X' } }]),
    );
    expect(wasm.calls).toEqual(['splitParagraph(0,0,0)', 'insertText(0,0,0,"X")']);
  });

  it('REPLACE clears existing text then inserts', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.2'] = 4;
    applyActionScript(
      wasm,
      script([{ command: 'REPLACE', target_id: 'sec[0].p[2]', payload: { text: 'new' } }]),
    );
    expect(wasm.calls).toEqual([
      'getParagraphLength(0,2)',
      'deleteText(0,2,0,4)',
      'insertText(0,2,0,"new")',
    ]);
  });

  it('DELETE empties then merges with neighbor', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.3'] = 6;
    applyActionScript(
      wasm,
      script([{ command: 'DELETE', target_id: 'sec[0].p[3]', payload: {} }]),
    );
    expect(wasm.calls).toEqual(['getParagraphLength(0,3)', 'deleteText(0,3,0,6)', 'mergeParagraph(0,3)']);
  });

  it('applies multiple edits in descending paragraph order', () => {
    const wasm = new FakeWasm();
    const result = applyActionScript(
      wasm,
      script([
        { command: 'INSERT_AFTER', target_id: 'sec[0].p[0]', payload: { text: 'A' } },
        { command: 'INSERT_AFTER', target_id: 'sec[0].p[5]', payload: { text: 'B' } },
      ]),
    );
    expect(result.applied).toBe(2);
    // p[5] 먼저(insertText(0,6,...)), 그다음 p[0]
    expect(wasm.calls).toEqual([
      'getParagraphLength(0,5)',
      'splitParagraph(0,5,0)',
      'insertText(0,6,0,"B")',
      'getParagraphLength(0,0)',
      'splitParagraph(0,0,0)',
      'insertText(0,1,0,"A")',
    ]);
  });

  it('skips REPLACE/INSERT with empty or missing text instead of wiping the paragraph', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.0'] = 8;
    const result = applyActionScript(
      wasm,
      script([
        // 모델이 text를 채우지 않은 경우(REPLACE) — 원문이 지워지면 안 된다.
        { command: 'REPLACE', target_id: 'sec[0].p[0]', payload: { type: 'paragraph' } },
        { command: 'INSERT_AFTER', target_id: 'sec[0].p[1]', payload: { text: '' } },
      ]),
    );
    expect(result.applied).toBe(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped[0].reason).toContain('payload.text');
    // 어떤 편집 프리미티브도 호출되지 않아야 한다(내용 손실 없음).
    expect(wasm.calls).toEqual([]);
  });

  it('REPLACE on a table cell clears then inserts in the cell', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.2.0.5.0'] = 11; // sec0,p2,tbl0,cell5,p0 길이
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[2].tbl[0].cell[5].p[0]',
          payload: { type: 'paragraph', text: '총 사업비 10억' },
        },
      ]),
    );
    expect(result.applied).toBe(1);
    expect(wasm.calls).toEqual([
      'getCellParagraphLength(0,2,0,5,0)',
      'deleteTextInCell(0,2,0,5,0,0,11)',
      'insertTextInCell(0,2,0,5,0,0,"총 사업비 10억")',
    ]);
  });

  it('DELETE on a table cell empties the cell text (no paragraph removal)', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.2.0.5.0'] = 4;
    applyActionScript(
      wasm,
      script([{ command: 'DELETE', target_id: 'sec[0].p[2].tbl[0].cell[5].p[0]', payload: {} }]),
    );
    expect(wasm.calls).toEqual([
      'getCellParagraphLength(0,2,0,5,0)',
      'deleteTextInCell(0,2,0,5,0,0,4)',
    ]);
  });

  it('skips paragraph insertion into a table cell (structure change unsupported)', () => {
    const wasm = new FakeWasm();
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[2].tbl[0].cell[5].p[0]',
          payload: { text: 'x' },
        },
      ]),
    );
    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('표 셀');
    expect(wasm.calls).toEqual([]);
  });

  it('skips non-paragraph target ids', () => {
    const wasm = new FakeWasm();
    const result = applyActionScript(
      wasm,
      script([{ command: 'REPLACE', target_id: 'sec[0].tbl[0]', payload: { text: 'x' } }]),
    );
    expect(result.applied).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].targetId).toBe('sec[0].tbl[0]');
    expect(wasm.calls).toEqual([]);
  });
});
