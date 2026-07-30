/**
 * F-403700d8 양식 없는 문서에서도 연구노트 생성 — createEntryFormTable 적합성 테스트.
 *
 * 핵심은 "생성한 표가 기존 채움 파이프라인의 세 판정을 모두 통과하는가"다:
 *   pickEntryFormTable(소스로 선택됨) · resolveValueCell(라벨→값칸) ·
 *   resolveBodyCell(본문 전폭 셀). 하나라도 어긋나면 항목이 비거나 본문이 누락된다.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFormFillMapping,
  createEntryFormTable,
  entryRecordToFormFillEntry,
  pickEntryFormTable,
  resolveBodyCell,
  type WasmEditing,
} from './ai-apply';
import type { ResearchNoteEntry } from './ai-bridge';

interface Call {
  fn: string;
  args: unknown[];
}

/**
 * 표 생성/병합/셀 기입을 기록하는 목. getTableCellBboxes는 rows×cols 격자를 돌려주되
 * 병합된 행은 앵커 칸만 남겨 rhwp 동작을 흉내 낸다.
 */
function makeWasm(
  opts: { createOk?: boolean; mergeOk?: boolean; omitBboxes?: boolean } = {},
): { wasm: WasmEditing; calls: Call[] } {
  const calls: Call[] = [];
  let merged: { row: number; startCol: number; endCol: number } | null = null;
  const ROWS = 6;
  const COLS = 2;

  const wasm: Record<string, unknown> = {
    getParagraphLength: () => 0,
    insertText: () => '',
    deleteText: () => '',
    splitParagraph: () => '',
    mergeParagraph: () => '',
    insertPageBreak: () => '',
    getCellParagraphLength: () => 0,
    deleteTextInCell: () => '',
    splitParagraphInCell: () => '',
    createTable: (...args: unknown[]) => {
      calls.push({ fn: 'createTable', args });
      return { ok: opts.createOk ?? true, paraIdx: 4, controlIdx: 0 };
    },
    mergeTableCells: (...args: unknown[]) => {
      calls.push({ fn: 'mergeTableCells', args });
      const [, , , sr, sc, , ec] = args as number[];
      if ((opts.mergeOk ?? true) && sr !== undefined) {
        merged = { row: sr, startCol: sc, endCol: ec };
      }
      return { ok: opts.mergeOk ?? true, cellCount: 1 };
    },
    insertTextInCell: (...args: unknown[]) => {
      calls.push({ fn: 'insertTextInCell', args });
      return '';
    },
  };
  if (!opts.omitBboxes) {
    wasm.getTableCellBboxes = () => {
      const out: { row: number; col: number; cellIdx: number; colSpan: number }[] = [];
      let idx = 0;
      for (let r = 0; r < ROWS; r += 1) {
        for (let c = 0; c < COLS; c += 1) {
          // 병합된 행은 앵커(startCol)만 실재 칸으로 남는다.
          if (merged && r === merged.row && c !== merged.startCol) continue;
          const span = merged && r === merged.row ? merged.endCol - merged.startCol + 1 : 1;
          out.push({ row: r, col: c, cellIdx: idx, colSpan: span });
          idx += 1;
        }
      }
      return out;
    };
  }
  return { wasm: wasm as unknown as WasmEditing, calls };
}

const ENTRY: ResearchNoteEntry = {
  title: '1월 1주차 착수 검토',
  body_paragraphs: ['첫째 줄 내용', '둘째 줄 내용'],
  recorders: ['홍길동', '임꺽정'],
  confirmer: '성춘향',
  record_date: '2026.01.05',
  confirm_date: '2026.01.06',
  images: [],
};

describe('F-403700d8 AC-001 — 앱이 엔트리 양식 표를 결정적으로 만든다', () => {
  it('6행×2열 표를 만들고 본문 행을 전폭 병합한다', () => {
    const { wasm, calls } = makeWasm();

    const made = createEntryFormTable(wasm, 0, 3);

    // (sec, para, charOffset, rows, cols)
    expect(calls.find((c) => c.fn === 'createTable')?.args).toEqual([0, 3, 0, 6, 2]);
    // 본문 행(인덱스 1)을 0열~1열로 병합.
    expect(calls.find((c) => c.fn === 'mergeTableCells')?.args).toEqual([0, 4, 0, 1, 0, 1, 1]);
    expect(made.table.rows).toBe(6);
    expect(made.table.cols).toBe(2);
    expect({ s: made.section, p: made.paragraph, c: made.controlIndex }).toEqual({
      s: 0,
      p: 4,
      c: 0,
    });
  });

  it('라벨 5개를 순서대로 기입한다(제목·기록자·기록 일자·확인자·확인 일자)', () => {
    const { wasm, calls } = makeWasm();
    createEntryFormTable(wasm, 0, 3);

    const written = calls.filter((c) => c.fn === 'insertTextInCell').map((c) => c.args[6]);
    expect(written).toEqual(['제목', '기록자', '기록 일자', '확인자', '확인 일자']);
  });

  it('생성한 표가 pickEntryFormTable에 소스로 선택된다', () => {
    const { wasm } = makeWasm();
    const made = createEntryFormTable(wasm, 0, 3);

    expect(pickEntryFormTable([made.table])).toEqual(made.table);
  });

  it('생성한 표에서 본문 전폭 셀이 해석된다', () => {
    const { wasm } = makeWasm();
    const made = createEntryFormTable(wasm, 0, 3);

    // 본문 행은 그 행에 셀이 1개 + col 0 + 라벨 아님 → resolveBodyCell이 집는다.
    expect(resolveBodyCell(made.table, new Set())).toEqual({ row: 1, col: 0 });
  });

  it('연구노트 항목이 라벨·본문 전부에 매핑된다(누락 0)', () => {
    const { wasm } = makeWasm();
    const made = createEntryFormTable(wasm, 0, 3);

    const mapping = buildFormFillMapping(made.table, entryRecordToFormFillEntry(ENTRY));

    expect(mapping.skipped).toEqual([]);
    const byCell = new Map(mapping.cellFills.map((f) => [`${f.row},${f.col}`, f.text]));
    // 라벨 오른쪽 칸(col 1)에 값이 들어간다.
    expect(byCell.get('0,1')).toBe(ENTRY.title);
    expect(byCell.get('2,1')).toBe('홍길동, 임꺽정');
    expect(byCell.get('3,1')).toBe(ENTRY.record_date);
    expect(byCell.get('4,1')).toBe(ENTRY.confirmer);
    expect(byCell.get('5,1')).toBe(ENTRY.confirm_date);
    // 본문은 전폭 셀(1,0)에 줄바꿈으로 합쳐 들어간다.
    expect(byCell.get('1,0')).toBe('첫째 줄 내용\n둘째 줄 내용');
  });
});

describe('F-403700d8 AC-003 — 엔진이 거부하면 문서를 반쯤 바꿔놓지 않는다', () => {
  it('표 생성이 거부되면 병합·기입을 시도하지 않고 오류를 던진다', () => {
    const { wasm, calls } = makeWasm({ createOk: false });

    expect(() => createEntryFormTable(wasm, 0, 3)).toThrow(/만들지 못했습니다/);
    expect(calls.some((c) => c.fn === 'mergeTableCells')).toBe(false);
    expect(calls.some((c) => c.fn === 'insertTextInCell')).toBe(false);
  });

  it('본문 행 병합이 거부되면 라벨을 기입하지 않고 오류를 던진다', () => {
    const { wasm, calls } = makeWasm({ mergeOk: false });

    expect(() => createEntryFormTable(wasm, 0, 3)).toThrow(/병합하지 못했습니다/);
    expect(calls.some((c) => c.fn === 'insertTextInCell')).toBe(false);
  });

  it('셀 좌표 조회 API가 없는 환경이면 사유를 던진다', () => {
    const { wasm } = makeWasm({ omitBboxes: true });

    expect(() => createEntryFormTable(wasm, 0, 3)).toThrow(/지원하지 않습니다/);
  });
});
