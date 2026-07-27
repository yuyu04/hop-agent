/**
 * F-8eb1f86f AI 표 수식 — payload.type="table_formula" 적합성 테스트.
 *
 * 핵심은 "AI가 암산한 숫자를 글자로 넣지 않는다"는 것. 검증 대상은 계산식이 엔진
 * 호출로 번역되는지, 잘못된 입력이 셀을 더럽히지 않고 사유로 보고되는지, 그리고
 * 같은 표의 다른 편집보다 나중에 적용되는지다.
 */
import { describe, it, expect } from 'vitest';
import { applyActionScript, type WasmEditing } from './ai-apply';
import type { ActionScript, Edit } from './ai-bridge';

interface Call {
  fn: string;
  args: unknown[];
}

const CELL_ID = 'sec[0].p[3].tbl[0].cell[0].p[0]';

function makeWasm(
  opts: { omitFormula?: boolean; returns?: string; throws?: boolean } = {},
): { wasm: WasmEditing; calls: Call[] } {
  const calls: Call[] = [];
  const wasm: Record<string, unknown> = {
    getParagraphLength: () => 0,
    insertText: () => '',
    deleteText: () => '',
    splitParagraph: () => '',
    mergeParagraph: () => '',
    insertPageBreak: () => '',
    getCellParagraphLength: () => 0,
    insertTextInCell: (...args: unknown[]) => {
      calls.push({ fn: 'insertTextInCell', args });
      return '';
    },
    deleteTextInCell: (...args: unknown[]) => {
      calls.push({ fn: 'deleteTextInCell', args });
      return '';
    },
    splitParagraphInCell: () => '',
    insertTableRow: (...args: unknown[]) => {
      calls.push({ fn: 'insertTableRow', args });
      return { ok: true, rowCount: 6, colCount: 3 };
    },
    mergeTableCells: () => ({ ok: true, cellCount: 1 }),
  };
  if (!opts.omitFormula) {
    wasm.evaluateTableFormula = (...args: unknown[]) => {
      calls.push({ fn: 'evaluateTableFormula', args });
      if (opts.throws) throw new Error('수식 범위가 표를 벗어났습니다');
      return opts.returns ?? '{"ok":true,"result":150,"formula":"=SUM(B2:B5)"}';
    };
  }
  return { wasm: wasm as unknown as WasmEditing, calls };
}

const formulaEdit = (
  table_formula: Record<string, unknown>,
  targetId: string = CELL_ID,
): Edit =>
  ({
    command: 'REPLACE',
    target_id: targetId,
    payload: { type: 'table_formula', table_formula },
  }) as unknown as Edit;

const script = (...edits: Edit[]): ActionScript => ({ edits });

describe('F-8eb1f86f AC-001 — 엔진이 계산해 셀에 기입', () => {
  it('table_formula 편집이 evaluateTableFormula(write=true) 호출이 된다', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(
      wasm,
      script(formulaEdit({ row: 5, col: 1, formula: '=SUM(B2:B5)' })),
    );

    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([]);
    const call = calls.find((c) => c.fn === 'evaluateTableFormula');
    // (sec, parentPara, controlIdx, targetRow, targetCol, formula, writeResult)
    expect(call?.args).toEqual([0, 3, 0, 5, 1, '=SUM(B2:B5)', true]);
  });

  it('AI가 계산한 숫자를 텍스트로 넣지 않는다(셀 텍스트 API를 부르지 않음)', () => {
    const { wasm, calls } = makeWasm();

    applyActionScript(wasm, script(formulaEdit({ row: 5, col: 1, formula: '=SUM(B2:B5)' })));

    expect(calls.some((c) => c.fn === 'insertTextInCell')).toBe(false);
    expect(calls.some((c) => c.fn === 'deleteTextInCell')).toBe(false);
  });

  it('수식 앞뒤 공백은 다듬어 전달한다', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(wasm, script(formulaEdit({ row: 0, col: 0, formula: '  =A1+B2  ' })));
    expect(calls.find((c) => c.fn === 'evaluateTableFormula')?.args[5]).toBe('=A1+B2');
  });
});

describe('F-8eb1f86f AC-002 — 잘못된 입력은 셀을 더럽히지 않는다', () => {
  it('formula가 비면 엔진을 부르지 않고 사유를 보고한다', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(wasm, script(formulaEdit({ row: 1, col: 1, formula: '   ' })));

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn === 'evaluateTableFormula')).toBe(false);
    expect(result.skipped[0].reason).toContain('비어 있습니다');
  });

  it('row/col이 없으면 거부한다', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(wasm, script(formulaEdit({ formula: '=SUM(A1:A3)' })));

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn === 'evaluateTableFormula')).toBe(false);
    expect(result.skipped[0].reason).toContain('row/col');
  });

  it('엔진이 수식을 거부하면(throw) 사유로 보고된다', () => {
    const { wasm } = makeWasm({ throws: true });

    const result = applyActionScript(
      wasm,
      script(formulaEdit({ row: 5, col: 1, formula: '=SUM(Z9:Z99)' })),
    );

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('표를 벗어났습니다');
  });

  it('엔진이 ok=false를 돌려줘도 조용히 성공 처리하지 않는다', () => {
    const { wasm } = makeWasm({ returns: '{"ok":false}' });

    const result = applyActionScript(
      wasm,
      script(formulaEdit({ row: 5, col: 1, formula: '=BOGUS()' })),
    );

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('계산하지 못했습니다');
  });

  it('중첩 표는 거부한다(최상위 표만 지원)', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(
      wasm,
      script(
        formulaEdit(
          { row: 1, col: 1, formula: '=SUM(A1:A2)' },
          'sec[0].p[0].tbl[2].cell[0].p[4].tbl[0].cell[11].p[0]',
        ),
      ),
    );

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn === 'evaluateTableFormula')).toBe(false);
    expect(result.skipped[0].reason).toContain('중첩 표');
  });

  it('본문 문단을 target으로 쓰면 거부한다(표 셀 ID여야 함)', () => {
    const { wasm } = makeWasm();

    const result = applyActionScript(
      wasm,
      script(formulaEdit({ row: 0, col: 0, formula: '=SUM(A1:A2)' }, 'sec[0].p[1]')),
    );

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('셀 ID');
  });

  it('계산식 API가 없는 환경이면 사유를 보고한다', () => {
    const { wasm } = makeWasm({ omitFormula: true });

    const result = applyActionScript(
      wasm,
      script(formulaEdit({ row: 1, col: 1, formula: '=SUM(A1:A2)' })),
    );

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('지원하지 않습니다');
  });
});

describe('F-8eb1f86f AC-3f7ca215 — 계산식은 같은 표의 다른 편집 뒤에 적용', () => {
  it('행 추가 편집이 먼저, 계산식이 나중에 적용된다', () => {
    const { wasm, calls } = makeWasm();
    const addRow = {
      command: 'REPLACE',
      target_id: CELL_ID,
      payload: {
        type: 'table_edit',
        table_edit: { op: 'insert_row', row: 4, below: true, texts: ['합계', ''] },
      },
    } as unknown as Edit;

    // 계산식을 먼저 낸 스크립트라도 적용은 행 추가 뒤여야 한다.
    applyActionScript(
      wasm,
      script(formulaEdit({ row: 5, col: 1, formula: '=SUM(B2:B5)' }), addRow),
    );

    const rowAt = calls.findIndex((c) => c.fn === 'insertTableRow');
    const formulaAt = calls.findIndex((c) => c.fn === 'evaluateTableFormula');
    expect(rowAt).toBeGreaterThan(-1);
    expect(formulaAt).toBeGreaterThan(rowAt);
  });

  it('계산식이 여러 개면 입력 정순으로 적용된다(누적 계산)', () => {
    const { wasm, calls } = makeWasm();

    applyActionScript(
      wasm,
      script(
        formulaEdit({ row: 5, col: 1, formula: '=SUM(B2:B5)' }),
        formulaEdit({ row: 5, col: 2, formula: '=SUM(C2:C5)' }),
        formulaEdit({ row: 6, col: 1, formula: '=B6+C6' }),
      ),
    );

    const formulas = calls
      .filter((c) => c.fn === 'evaluateTableFormula')
      .map((c) => c.args[5]);
    expect(formulas).toEqual(['=SUM(B2:B5)', '=SUM(C2:C5)', '=B6+C6']);
  });
});
