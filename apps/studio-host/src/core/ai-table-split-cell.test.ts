/**
 * F-6daa56b3 AI 표 셀 분할 — table_edit.op="split_cell" 적합성 테스트.
 *
 * 병합(merge_cells)은 되는데 분할이 안 되던 비대칭을 없앤 기능. 검증 대상은
 * "AI가 낸 table_edit이 어떤 엔진 호출로 번역되는가 / 무엇이 거부되는가"다.
 */
import { describe, it, expect } from 'vitest';
import { applyActionScript, type WasmEditing } from './ai-apply';
import type { ActionScript, Edit } from './ai-bridge';

interface Call {
  fn: string;
  args: unknown[];
}

/** 그 표 안의 셀 ID — table_edit의 target_id는 항상 표 안의 셀이다. */
const CELL_ID = 'sec[0].p[2].tbl[1].cell[0].p[0]';

function makeWasm(opts: { omit?: string[] } = {}): { wasm: WasmEditing; calls: Call[] } {
  const calls: Call[] = [];
  const omit = new Set(opts.omit ?? []);
  const split = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return { ok: true, cellCount: 2 };
  };
  const wasm: Record<string, unknown> = {
    getParagraphLength: () => 0,
    insertText: () => '',
    deleteText: () => '',
    splitParagraph: () => '',
    mergeParagraph: () => '',
    insertPageBreak: () => '',
    mergeTableCells: (...args: unknown[]) => {
      calls.push({ fn: 'mergeTableCells', args });
      return { ok: true, cellCount: 1 };
    },
  };
  if (!omit.has('splitTableCell')) wasm.splitTableCell = split('splitTableCell');
  if (!omit.has('splitTableCellInto')) wasm.splitTableCellInto = split('splitTableCellInto');
  if (!omit.has('splitTableCellsInRange')) {
    wasm.splitTableCellsInRange = split('splitTableCellsInRange');
  }
  return { wasm: wasm as unknown as WasmEditing, calls };
}

const splitEdit = (table_edit: Record<string, unknown>): Edit =>
  ({
    command: 'REPLACE',
    target_id: CELL_ID,
    payload: { type: 'table_edit', table_edit: { op: 'split_cell', ...table_edit } },
  }) as unknown as Edit;

const script = (...edits: Edit[]): ActionScript => ({ edits });

describe('F-6daa56b3 AC-001 — 셀을 N줄 × M칸으로 분할', () => {
  it('into_cols:2 → splitTableCellInto(row,col,1,2,...)', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(wasm, script(splitEdit({ row: 1, col: 2, into_cols: 2 })));

    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([]);
    const call = calls.find((c) => c.fn === 'splitTableCellInto');
    // (sec, parentPara, controlIdx, row, col, nRows, mCols, equalRowHeight, mergeFirst)
    expect(call?.args).toEqual([0, 2, 1, 1, 2, 1, 2, true, false]);
  });

  it('into_rows:3 → 3줄로 분할', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(wasm, script(splitEdit({ row: 0, col: 0, into_rows: 3 })));
    expect(calls.find((c) => c.fn === 'splitTableCellInto')?.args.slice(5, 7)).toEqual([3, 1]);
  });

  it('equal_row_height 생략 시 true, 지정하면 그대로 전달된다', () => {
    const a = makeWasm();
    applyActionScript(a.wasm, script(splitEdit({ row: 0, col: 0, into_rows: 2 })));
    expect(a.calls.find((c) => c.fn === 'splitTableCellInto')?.args[7]).toBe(true);

    const b = makeWasm();
    applyActionScript(
      b.wasm,
      script(splitEdit({ row: 0, col: 0, into_rows: 2, equal_row_height: false })),
    );
    expect(b.calls.find((c) => c.fn === 'splitTableCellInto')?.args[7]).toBe(false);
  });
});

describe('F-6daa56b3 AC-002 — 분할 수 없이 쓰면 병합 해제', () => {
  it('into_rows/into_cols 생략 → splitTableCell(병합 해제)', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(wasm, script(splitEdit({ row: 2, col: 1 })));

    expect(result.applied).toBe(1);
    expect(calls.find((c) => c.fn === 'splitTableCell')?.args).toEqual([0, 2, 1, 2, 1]);
    expect(calls.some((c) => c.fn === 'splitTableCellInto')).toBe(false);
  });
});

describe('F-6daa56b3 AC-003 — range를 주면 범위 일괄 분할', () => {
  it('range + into_cols → splitTableCellsInRange', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(
      wasm,
      script(
        splitEdit({
          into_cols: 2,
          range: { start_row: 1, start_col: 0, end_row: 3, end_col: 0 },
        }),
      ),
    );

    expect(result.applied).toBe(1);
    // (sec, parentPara, ctrl, startRow, startCol, endRow, endCol, nRows, mCols, equalHeight)
    expect(calls.find((c) => c.fn === 'splitTableCellsInRange')?.args).toEqual([
      0, 2, 1, 1, 0, 3, 0, 1, 2, true,
    ]);
    // 범위 분할일 때는 단일 셀 API를 부르지 않는다.
    expect(calls.some((c) => c.fn === 'splitTableCellInto')).toBe(false);
  });

  it('range를 주면 row/col은 없어도 된다', () => {
    const { wasm } = makeWasm();
    const result = applyActionScript(
      wasm,
      script(
        splitEdit({ into_rows: 2, range: { start_row: 0, start_col: 0, end_row: 1, end_col: 1 } }),
      ),
    );
    expect(result.skipped).toEqual([]);
  });
});

describe('F-6daa56b3 AC-004 — 아무 일도 안 하는 분할·중첩 표는 거부', () => {
  it('range + 분할 수 1×1이면 표를 바꾸지 않고 사유를 보고한다', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(
      wasm,
      script(splitEdit({ range: { start_row: 0, start_col: 0, end_row: 1, end_col: 1 } })),
    );

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn.startsWith('split'))).toBe(false);
    expect(result.skipped[0].reason).toContain('2 이상');
  });

  it('into_rows가 0 이하이면 거부한다', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(wasm, script(splitEdit({ row: 0, col: 0, into_rows: 0 })));

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn.startsWith('split'))).toBe(false);
    expect(result.skipped[0].reason).toContain('1 이상');
  });

  it('row/col이 없으면 거부한다', () => {
    const { wasm } = makeWasm();

    const result = applyActionScript(wasm, script(splitEdit({ into_cols: 2 })));

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('table_edit.row');
  });

  it('중첩 표 셀은 거부한다(최상위 표만 지원)', () => {
    const { wasm, calls } = makeWasm();
    const nested = {
      command: 'REPLACE',
      target_id: 'sec[0].p[2].tbl[1].cell[0].p[4].tbl[0].cell[11].p[0]',
      payload: { type: 'table_edit', table_edit: { op: 'split_cell', row: 0, col: 0, into_cols: 2 } },
    } as unknown as Edit;

    const result = applyActionScript(wasm, script(nested));

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn.startsWith('split'))).toBe(false);
    expect(result.skipped[0].reason).toContain('중첩 표');
  });

  it('분할 API가 없는 환경이면 표를 바꾸지 않고 사유를 보고한다', () => {
    const { wasm } = makeWasm({ omit: ['splitTableCellInto'] });

    const result = applyActionScript(wasm, script(splitEdit({ row: 0, col: 0, into_cols: 2 })));

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('지원하지 않습니다');
  });
});
