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
  getCellParagraphLengthByPath(s: number, pp: number, pathJson: string): number {
    this.calls.push(`getCellParagraphLengthByPath(${s},${pp},${pathJson})`);
    return this.lengths[`${s}.${pp}.${pathJson}`] ?? 0;
  }
  insertTextInCellByPath(s: number, pp: number, pathJson: string, off: number, text: string): string {
    this.calls.push(`insertTextInCellByPath(${s},${pp},${pathJson},${off},"${text}")`);
    return '';
  }
  deleteTextInCellByPath(s: number, pp: number, pathJson: string, off: number, count: number): string {
    this.calls.push(`deleteTextInCellByPath(${s},${pp},${pathJson},${off},${count})`);
    return '';
  }
  splitParagraphInCellByPath(s: number, pp: number, pathJson: string, off: number): string {
    this.calls.push(`splitParagraphInCellByPath(${s},${pp},${pathJson},${off})`);
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

  it('REPLACE on a top-level table cell clears then inserts via by-path', () => {
    const wasm = new FakeWasm();
    const path = '[{"controlIndex":0,"cellIndex":5,"cellParaIndex":0}]';
    wasm.lengths[`0.2.${path}`] = 11;
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
      `getCellParagraphLengthByPath(0,2,${path})`,
      `deleteTextInCellByPath(0,2,${path},0,11)`,
      `insertTextInCellByPath(0,2,${path},0,"총 사업비 10억")`,
    ]);
  });

  it('REPLACE on a NESTED table cell uses the full path', () => {
    const wasm = new FakeWasm();
    const path =
      '[{"controlIndex":2,"cellIndex":0,"cellParaIndex":4},{"controlIndex":0,"cellIndex":11,"cellParaIndex":0}]';
    wasm.lengths[`0.0.${path}`] = 11;
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[0].tbl[2].cell[0].p[4].tbl[0].cell[11].p[0]',
          payload: { text: '1,000,000,000' },
        },
      ]),
    );
    expect(result.applied).toBe(1);
    expect(wasm.calls).toEqual([
      `getCellParagraphLengthByPath(0,0,${path})`,
      `deleteTextInCellByPath(0,0,${path},0,11)`,
      `insertTextInCellByPath(0,0,${path},0,"1,000,000,000")`,
    ]);
  });

  it('DELETE on a table cell empties the cell text (no paragraph removal)', () => {
    const wasm = new FakeWasm();
    const path = '[{"controlIndex":0,"cellIndex":5,"cellParaIndex":0}]';
    wasm.lengths[`0.2.${path}`] = 4;
    applyActionScript(
      wasm,
      script([{ command: 'DELETE', target_id: 'sec[0].p[2].tbl[0].cell[5].p[0]', payload: {} }]),
    );
    expect(wasm.calls).toEqual([
      `getCellParagraphLengthByPath(0,2,${path})`,
      `deleteTextInCellByPath(0,2,${path},0,4)`,
    ]);
  });

  it('INSERT_AFTER into a table cell splits then inserts a new cell paragraph', () => {
    const wasm = new FakeWasm();
    const path = '[{"controlIndex":0,"cellIndex":5,"cellParaIndex":0}]';
    const pathNext = '[{"controlIndex":0,"cellIndex":5,"cellParaIndex":1}]';
    wasm.lengths[`0.2.${path}`] = 3;
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[2].tbl[0].cell[5].p[0]',
          payload: { text: '추가 문단' },
        },
      ]),
    );
    expect(result.applied).toBe(1);
    expect(wasm.calls).toEqual([
      `getCellParagraphLengthByPath(0,2,${path})`,
      `splitParagraphInCellByPath(0,2,${path},3)`,
      `insertTextInCellByPath(0,2,${pathNext},0,"추가 문단")`,
    ]);
  });

  it('INSERT_BEFORE into a NESTED table cell uses the full path', () => {
    const wasm = new FakeWasm();
    const path =
      '[{"controlIndex":2,"cellIndex":0,"cellParaIndex":4},{"controlIndex":0,"cellIndex":11,"cellParaIndex":0}]';
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_BEFORE',
          target_id: 'sec[0].p[0].tbl[2].cell[0].p[4].tbl[0].cell[11].p[0]',
          payload: { text: '앞에 추가' },
        },
      ]),
    );
    expect(result.applied).toBe(1);
    expect(wasm.calls).toEqual([
      `splitParagraphInCellByPath(0,0,${path},0)`,
      `insertTextInCellByPath(0,0,${path},0,"앞에 추가")`,
    ]);
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
