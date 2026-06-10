import { describe, expect, it } from 'vitest';
import { applyActionScript, type WasmEditing } from './ai-apply';
import type { ActionScript } from './ai-bridge';

class FakeWasm implements WasmEditing {
  calls: string[] = [];
  lengths: Record<string, number> = {};
  /** 본문 문단 텍스트(getTextRange용). 키: `${sec}.${para}`. 설정 시 lengths도 채워진다. */
  paraTexts: Record<string, string> = {};

  setParaText(sec: number, para: number, text: string): void {
    this.paraTexts[`${sec}.${para}`] = text;
    this.lengths[`${sec}.${para}`] = Array.from(text).length;
  }

  getParagraphLength(sec: number, para: number): number {
    this.calls.push(`getParagraphLength(${sec},${para})`);
    return this.lengths[`${sec}.${para}`] ?? 0;
  }
  getTextRange(sec: number, para: number, start: number, end: number): string {
    this.calls.push(`getTextRange(${sec},${para},${start},${end})`);
    return Array.from(this.paraTexts[`${sec}.${para}`] ?? '').slice(start, end).join('');
  }
  applyCharFormat(sec: number, para: number, start: number, end: number, propsJson: string): string {
    this.calls.push(`applyCharFormat(${sec},${para},${start},${end},${propsJson})`);
    return '';
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
  insertPageBreak(sec: number, para: number, charOffset: number): string {
    this.calls.push(`insertPageBreak(${sec},${para},${charOffset})`);
    return '';
  }
  createTable(sec: number, para: number, charOffset: number, rows: number, cols: number) {
    this.calls.push(`createTable(${sec},${para},${charOffset},${rows},${cols})`);
    return { ok: true, paraIdx: para, controlIdx: 0 };
  }
  mergeFails = false;
  mergeTableCells(s: number, pp: number, ci: number, sr: number, sc: number, er: number, ec: number) {
    this.calls.push(`mergeTableCells(${s},${pp},${ci},${sr},${sc},${er},${ec})`);
    if (this.mergeFails) throw new Error('셀 (0,0) span (2,1)이 병합 범위를 벗어납니다');
    return { ok: true, cellCount: 1 };
  }
  insertTableRow(s: number, pp: number, ci: number, row: number, below: boolean) {
    this.calls.push(`insertTableRow(${s},${pp},${ci},${row},${below})`);
    return { ok: true, rowCount: 3, colCount: 2 };
  }
  insertTableColumn(s: number, pp: number, ci: number, col: number, right: boolean) {
    this.calls.push(`insertTableColumn(${s},${pp},${ci},${col},${right})`);
    return { ok: true, rowCount: 2, colCount: 3 };
  }
  deleteTableRow(s: number, pp: number, ci: number, row: number) {
    this.calls.push(`deleteTableRow(${s},${pp},${ci},${row})`);
    return { ok: true, rowCount: 1, colCount: 2 };
  }
  deleteTableColumn(s: number, pp: number, ci: number, col: number) {
    this.calls.push(`deleteTableColumn(${s},${pp},${ci},${col})`);
    return { ok: true, rowCount: 2, colCount: 1 };
  }
  tableWidth = 0;
  bboxes: Array<{ cellIdx: number; col: number; row: number; colSpan: number }> = [];
  getTableProperties(s: number, pp: number, ci: number) {
    this.calls.push(`getTableProperties(${s},${pp},${ci})`);
    return { tableWidth: this.tableWidth };
  }
  getTableCellBboxes(s: number, pp: number, ci: number) {
    this.calls.push(`getTableCellBboxes(${s},${pp},${ci})`);
    return this.bboxes;
  }
  setCellProperties(s: number, pp: number, ci: number, cell: number, props: { width?: number }) {
    this.calls.push(`setCellProperties(${s},${pp},${ci},${cell},w=${props.width})`);
    return { ok: true };
  }
  applyParaFormatInCell(s: number, pp: number, ci: number, cell: number, cp: number, json: string) {
    this.calls.push(`applyParaFormatInCell(${s},${pp},${ci},${cell},${cp},${json})`);
    return '';
  }
  setTableProperties(s: number, pp: number, ci: number, props: { pageBreak?: number }) {
    this.calls.push(`setTableProperties(${s},${pp},${ci},pageBreak=${props.pageBreak})`);
    return { ok: true };
  }
  insertPicture(
    s: number,
    pp: number,
    co: number,
    data: Uint8Array,
    w: number,
    h: number,
    nw: number,
    nh: number,
    ext: string,
    desc?: string,
  ) {
    this.calls.push(
      `insertPicture(${s},${pp},${co},len=${data.length},${w}x${h},nat=${nw}x${nh},${ext},"${desc ?? ''}")`,
    );
    return { ok: true, paraIdx: pp, controlIdx: 0 };
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
  splitParagraphInCell(s: number, pp: number, ci: number, ce: number, cp: number, off: number): string {
    this.calls.push(`splitParagraphInCell(${s},${pp},${ci},${ce},${cp},${off})`);
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

  it('INSERT_AFTER with page_break starts the new paragraph on a new page', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.4'] = 7;
    applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[4]',
          payload: { text: '새 절', page_break: true },
        },
      ]),
    );
    expect(wasm.calls).toEqual([
      'getParagraphLength(0,4)',
      'splitParagraph(0,4,7)',
      'insertText(0,5,0,"새 절")',
      'insertPageBreak(0,5,0)',
    ]);
  });

  it('INSERT_AFTER with a table payload creates and fills a table', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.4'] = 2;
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[4]',
          payload: {
            type: 'table',
            table_data: { rows: 2, cols: 2, matrix: [['구분', '금액'], ['총액', '10억']] },
          },
        },
      ]),
    );
    expect(result.applied).toBe(1);
    // 셀은 flat API로 채워 reflow(줄바꿈·높이 증가)가 일어난다.
    expect(wasm.calls).toEqual([
      'getParagraphLength(0,4)',
      'splitParagraph(0,4,2)',
      'createTable(0,5,0,2,2)',
      'setTableProperties(0,5,0,pageBreak=1)',
      'insertTextInCell(0,5,0,0,0,0,"구분")',
      'insertTextInCell(0,5,0,1,0,0,"금액")',
      'insertTextInCell(0,5,0,2,0,0,"총액")',
      'insertTextInCell(0,5,0,3,0,0,"10억")',
      // 생성 후 셀 정렬/폭 보정을 위해 셀 좌표·표 폭을 조회한다(빈 목록이면 추가 호출 없음).
      'getTableCellBboxes(0,5,0)',
      'getTableProperties(0,5,0)',
    ]);
  });

  it('skips creating a table inside a table cell (cells cannot paginate)', () => {
    const wasm = new FakeWasm();
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[0].tbl[2].cell[0].p[20]',
          payload: { type: 'table', table_data: { rows: 2, cols: 2, matrix: [] } },
        },
      ]),
    );
    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('표 셀 안에는 표');
    expect(wasm.calls).toEqual([]);
  });

  it('applies col_weights as proportional cell widths after creating a table', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.4'] = 0;
    wasm.tableWidth = 10000;
    wasm.bboxes = [
      { cellIdx: 0, col: 0, row: 0, colSpan: 1 },
      { cellIdx: 1, col: 1, row: 0, colSpan: 1 },
      { cellIdx: 2, col: 0, row: 1, colSpan: 1 },
      { cellIdx: 3, col: 1, row: 1, colSpan: 1 },
    ];
    applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[4]',
          payload: {
            type: 'table',
            table_data: {
              rows: 2,
              cols: 2,
              matrix: [
                ['a', 'b'],
                ['c', 'd'],
              ],
              col_weights: [1, 4], // 폭 합 5 → 좁은 열 2000, 넓은 열 8000.
            },
          },
        },
      ]),
    );
    // 표는 split 후 para 5에 생성된다(result.paraIdx=5).
    expect(wasm.calls).toContain('setCellProperties(0,5,0,0,w=2000)');
    expect(wasm.calls).toContain('setCellProperties(0,5,0,1,w=8000)');
    expect(wasm.calls).toContain('setCellProperties(0,5,0,2,w=2000)');
    expect(wasm.calls).toContain('setCellProperties(0,5,0,3,w=8000)');
  });

  it('auto-sizes columns by content when col_weights is absent (long column widest)', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.4'] = 0;
    wasm.tableWidth = 14000;
    wasm.bboxes = [
      { cellIdx: 0, col: 0, row: 0, colSpan: 1 },
      { cellIdx: 1, col: 1, row: 0, colSpan: 1 },
      { cellIdx: 2, col: 0, row: 1, colSpan: 1 },
      { cellIdx: 3, col: 1, row: 1, colSpan: 1 },
    ];
    applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[4]',
          payload: {
            type: 'table',
            table_data: {
              rows: 2,
              cols: 2,
              // col_weights 없음 → 내용 길이로 자동: c0 max("구분"=2)→2, c1 max(12자)→12. 합 14.
              matrix: [
                ['구분', '아주아주아주긴설명텍스트'],
                ['a', 'b'],
              ],
            },
          },
        },
      ]),
    );
    // tableWidth 14000 × (2/14)=2000, (12/14)=12000.
    expect(wasm.calls).toContain('setCellProperties(0,5,0,0,w=2000)');
    expect(wasm.calls).toContain('setCellProperties(0,5,0,1,w=12000)');
  });

  it('aligns header cells center and body cells left (overrides inherited distribute)', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.4'] = 0;
    wasm.bboxes = [
      { cellIdx: 0, col: 0, row: 0, colSpan: 1 }, // 헤더
      { cellIdx: 1, col: 1, row: 0, colSpan: 1 }, // 헤더
      { cellIdx: 2, col: 0, row: 1, colSpan: 1 }, // 본문
      { cellIdx: 3, col: 1, row: 1, colSpan: 1 }, // 본문
    ];
    applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[4]',
          payload: {
            type: 'table',
            table_data: {
              rows: 2,
              cols: 2,
              matrix: [
                ['머리글', '세목별 사용 용도'],
                ['a', 'b'],
              ],
            },
          },
        },
      ]),
    );
    expect(wasm.calls).toContain('applyParaFormatInCell(0,5,0,0,0,{"alignment":"center"})');
    expect(wasm.calls).toContain('applyParaFormatInCell(0,5,0,1,0,{"alignment":"center"})');
    expect(wasm.calls).toContain('applyParaFormatInCell(0,5,0,2,0,{"alignment":"left"})');
    expect(wasm.calls).toContain('applyParaFormatInCell(0,5,0,3,0,{"alignment":"left"})');
  });

  it('INSERT_AFTER with an image payload splits then inserts the attached image (scaled to width)', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.4'] = 2;
    const images = [
      { bytes: new Uint8Array([1, 2, 3]), extension: 'png', naturalWidthPx: 600, naturalHeightPx: 400 },
    ];
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[4]',
          payload: { type: 'image', image_index: 0, text: '그래프' },
        },
      ]),
      images,
    );
    expect(result.applied).toBe(1);
    // 600px*75=45000 > 42000(상한) → 42000x28000으로 축소. 원본 픽셀은 보존.
    expect(wasm.calls).toEqual([
      'getParagraphLength(0,4)',
      'splitParagraph(0,4,2)',
      'insertPicture(0,5,0,len=3,42000x28000,nat=600x400,png,"그래프")',
    ]);
  });

  it('skips an image edit whose image_index has no attached image', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.4'] = 0;
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[4]',
          payload: { type: 'image', image_index: 2 },
        },
      ]),
      [], // 첨부 이미지 없음
    );
    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('첨부 이미지');
  });

  it('merges cells after filling when table_data.merges is given', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.4'] = 0;
    applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[4]',
          payload: {
            type: 'table',
            table_data: {
              rows: 2,
              cols: 2,
              matrix: [['머리글', ''], ['a', 'b']],
              merges: [{ start_row: 0, start_col: 0, end_row: 0, end_col: 1 }],
            },
          },
        },
      ]),
    );
    // 채운 뒤 병합이 호출된다.
    expect(wasm.calls).toContain('mergeTableCells(0,5,0,0,0,0,1)');
    const fillIdx = wasm.calls.findIndex((c) => c.startsWith('insertTextInCell('));
    const mergeIdx = wasm.calls.findIndex((c) => c.startsWith('mergeTableCells'));
    expect(fillIdx).toBeLessThan(mergeIdx);
  });

  it('does not fill cells covered by a merge (avoids duplicated text after merge)', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.4'] = 0;
    // 세로 2칸 병합(0,0)~(1,0)에 같은 텍스트가 matrix에 들어와도 대표 셀만 채워야 한다.
    applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[4]',
          payload: {
            type: 'table',
            table_data: {
              rows: 2,
              cols: 2,
              matrix: [
                ['인건비', 'x'],
                ['인건비', 'y'],
              ],
              merges: [{ start_row: 0, start_col: 0, end_row: 1, end_col: 0 }],
            },
          },
        },
      ]),
    );
    const fills = wasm.calls.filter((c) => c.startsWith('insertTextInCell('));
    // 대표 셀(0,0)=인덱스0 만 '인건비'. 가려진 셀(1,0)=인덱스2 는 채우지 않는다.
    expect(fills).toContain('insertTextInCell(0,5,0,0,0,0,"인건비")');
    expect(fills.filter((c) => c.includes('"인건비"'))).toHaveLength(1);
    expect(fills.some((c) => c.startsWith('insertTextInCell(0,5,0,2,'))).toBe(false);
    // 가려지지 않은 셀(0,1)=1, (1,1)=3 은 정상 채움.
    expect(fills).toContain('insertTextInCell(0,5,0,1,0,0,"x")');
    expect(fills).toContain('insertTextInCell(0,5,0,3,0,0,"y")');
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

  it('REPLACE on a top-level table cell clears then inserts via flat reflowing API', () => {
    const wasm = new FakeWasm();
    // 최상위 셀(path 길이 1)은 reflow가 일어나는 flat API를 쓴다.
    wasm.lengths['0.2.0.5.0'] = 11;
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

  it('DELETE on a top-level table cell empties the cell text via flat reflowing API', () => {
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

  it('INSERT_AFTER into a top-level table cell splits then inserts via flat reflowing API', () => {
    const wasm = new FakeWasm();
    // 최상위 셀(path 길이 1)의 INSERT도 flat API — reflow가 일어나고 글상자(Shape)도 처리된다.
    wasm.lengths['0.2.0.5.0'] = 3;
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
      'getCellParagraphLength(0,2,0,5,0)',
      'splitParagraphInCell(0,2,0,5,0,3)',
      'insertTextInCell(0,2,0,5,1,0,"추가 문단")',
    ]);
  });

  it('REPLACE on a textbox paragraph edits via the same flat cell path (F-21a81b)', () => {
    const wasm = new FakeWasm();
    // 글상자 문단은 cell[0] 고정의 셀 형식 ID로 직렬화된다(레이아웃 런의 CellContext).
    // flat API는 rhwp에서 Control::Shape(글상자)로 라우팅되어 reflow까지 수행한다.
    wasm.lengths['0.0.2.0.0'] = 6;
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[0].tbl[2].cell[0].p[0]',
          payload: { type: 'paragraph', text: '새 글상자 문구' },
        },
      ]),
    );
    expect(result.applied).toBe(1);
    expect(wasm.calls).toEqual([
      'getCellParagraphLength(0,0,2,0,0)',
      'deleteTextInCell(0,0,2,0,0,0,6)',
      'insertTextInCell(0,0,2,0,0,0,"새 글상자 문구")',
    ]);
  });

  it('INSERT_BEFORE into a top-level cell/textbox splits at offset 0 via flat API', () => {
    const wasm = new FakeWasm();
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_BEFORE',
          target_id: 'sec[0].p[0].tbl[2].cell[0].p[0]',
          payload: { text: '앞 문구' },
        },
      ]),
    );
    expect(result.applied).toBe(1);
    expect(wasm.calls).toEqual([
      'splitParagraphInCell(0,0,2,0,0,0)',
      'insertTextInCell(0,0,2,0,0,0,"앞 문구")',
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

  // ── 표 구조 편집 (F-7a3dbe) ─────────────────────────────────

  it('table_edit insert_row inserts below and fills the new row cells via bboxes', () => {
    const wasm = new FakeWasm();
    // 2×2 표에 행 추가 후의 셀 좌표(새 행 row=1, 셀 인덱스는 row-major가 아닐 수 있어 bbox로 찾는다).
    wasm.bboxes = [
      { cellIdx: 0, col: 0, row: 0, colSpan: 1 },
      { cellIdx: 1, col: 1, row: 0, colSpan: 1 },
      { cellIdx: 4, col: 0, row: 1, colSpan: 1 },
      { cellIdx: 5, col: 1, row: 1, colSpan: 1 },
    ];
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[2].tbl[0].cell[0].p[0]',
          payload: {
            type: 'table_edit',
            table_edit: { op: 'insert_row', row: 0, below: true, texts: ['새 항목', '새 값'] },
          },
        },
      ]),
    );
    expect(result.applied).toBe(1);
    expect(wasm.calls).toEqual([
      'insertTableRow(0,2,0,0,true)',
      'getTableCellBboxes(0,2,0)',
      'insertTextInCell(0,2,0,4,0,0,"새 항목")',
      'insertTextInCell(0,2,0,5,0,0,"새 값")',
    ]);
  });

  it('table_edit delete_col and merge_cells call the structure primitives', () => {
    const wasm = new FakeWasm();
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[2].tbl[0].cell[0].p[0]',
          payload: { type: 'table_edit', table_edit: { op: 'delete_col', col: 2 } },
        },
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[2].tbl[0].cell[0].p[0]',
          payload: {
            type: 'table_edit',
            table_edit: {
              op: 'merge_cells',
              merge: { start_row: 0, start_col: 0, end_row: 1, end_col: 0 },
            },
          },
        },
      ]),
    );
    expect(result.applied).toBe(2);
    // 표 구조 편집끼리는 입력 정순으로 적용된다(인덱스가 앞 편집 결과 기준).
    expect(wasm.calls).toEqual([
      'deleteTableColumn(0,2,0,2)',
      'mergeTableCells(0,2,0,0,0,1,0)',
    ]);
  });

  it('table_edit merge conflicting with an existing merge is skipped and reported (AC4)', () => {
    const wasm = new FakeWasm();
    wasm.mergeFails = true; // rhwp가 부분 겹침을 거부하는 상황.
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[2].tbl[0].cell[0].p[0]',
          payload: {
            type: 'table_edit',
            table_edit: {
              op: 'merge_cells',
              merge: { start_row: 1, start_col: 0, end_row: 1, end_col: 1 },
            },
          },
        },
      ]),
    );
    expect(result.applied).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('병합 범위');
    // 구조 호출 외 다른 편집 프리미티브는 호출되지 않는다(문서 무변경).
    expect(wasm.calls).toEqual(['mergeTableCells(0,2,0,1,0,1,1)']);
  });

  it('table_edit on a body paragraph target is rejected with guidance', () => {
    const wasm = new FakeWasm();
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[2]',
          payload: { type: 'table_edit', table_edit: { op: 'delete_row', row: 0 } },
        },
      ]),
    );
    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('셀 ID');
    expect(wasm.calls).toEqual([]);
  });

  // ── 런 단위 부분 서식 (F-04a91c) ────────────────────────────

  it('format edit applies char format to the unique target range without touching text', () => {
    const wasm = new FakeWasm();
    wasm.setParaText(0, 1, '올해의 핵심 성과는 매출 증가다.');
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[1]',
          payload: {
            type: 'format',
            format_target: '핵심 성과',
            char_format: { bold: true, text_color: '#C00000' },
          },
        },
      ]),
    );
    expect(result.applied).toBe(1);
    // "올해의 " = 4자 → [4, 9). 텍스트 변경 프리미티브는 호출되지 않는다.
    expect(wasm.calls).toEqual([
      'getParagraphLength(0,1)',
      'getTextRange(0,1,0,18)',
      'applyCharFormat(0,1,4,9,{"bold":true,"textColor":"#C00000"})',
    ]);
    expect(result.changed).toEqual([{ sec: 0, para: 1 }]);
  });

  it('format edit without format_target styles the whole paragraph (font size pt→HWPUNIT)', () => {
    const wasm = new FakeWasm();
    wasm.setParaText(0, 0, '제목 문단');
    applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[0]',
          payload: { type: 'format', char_format: { font_size_pt: 14, underline: true } },
        },
      ]),
    );
    expect(wasm.calls).toEqual([
      'getParagraphLength(0,0)',
      'applyCharFormat(0,0,0,5,{"underline":true,"fontSize":1400})',
    ]);
  });

  it('format edit is skipped when the target is missing or ambiguous (AC4)', () => {
    const wasm = new FakeWasm();
    wasm.setParaText(0, 0, '성과와 성과가 반복된다');
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[0]',
          payload: { type: 'format', format_target: '성과', char_format: { bold: true } },
        },
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[0]',
          payload: { type: 'format', format_target: '없는 문구', char_format: { bold: true } },
        },
      ]),
    );
    expect(result.applied).toBe(0);
    expect(result.skipped).toHaveLength(2);
    const reasons = result.skipped.map((s) => s.reason).join(' / ');
    expect(reasons).toContain('여러 번');
    expect(reasons).toContain('찾지 못했습니다');
    expect(wasm.calls.filter((c) => c.startsWith('applyCharFormat'))).toEqual([]);
  });

  it('format edit on a table cell target is rejected (body paragraphs only)', () => {
    const wasm = new FakeWasm();
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[2].tbl[0].cell[1].p[0]',
          payload: { type: 'format', format_target: '값', char_format: { bold: true } },
        },
      ]),
    );
    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('본문 문단만');
    expect(wasm.calls).toEqual([]);
  });

  it('applies multiple INSERT_AFTER on the same paragraph in reverse so doc order matches input', () => {
    const wasm = new FakeWasm();
    // 입력 순서 A, B, C 를 같은 p[0]에 INSERT_AFTER. split→insert가 매번 p[1]에
    // 끼우므로, 문서 정순(A,B,C)을 위해 역순(C,B,A)으로 적용해야 한다.
    applyActionScript(
      wasm,
      script([
        { command: 'INSERT_AFTER', target_id: 'sec[0].p[0]', payload: { text: 'A' } },
        { command: 'INSERT_AFTER', target_id: 'sec[0].p[0]', payload: { text: 'B' } },
        { command: 'INSERT_AFTER', target_id: 'sec[0].p[0]', payload: { text: 'C' } },
      ]),
    );
    const inserts = wasm.calls.filter((c) => c.startsWith('insertText('));
    expect(inserts).toEqual([
      'insertText(0,1,0,"C")',
      'insertText(0,1,0,"B")',
      'insertText(0,1,0,"A")',
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
