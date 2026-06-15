import { describe, expect, it } from 'vitest';
import { applyActionScript, type WasmEditing } from './ai-apply';
import type { ActionScript } from './ai-bridge';
import { compileTheme } from './doc-theme';

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
  applyParaFormat(sec: number, para: number, propsJson: string): string {
    this.calls.push(`applyParaFormat(${sec},${para},${propsJson})`);
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
  /** 문서 스타일 목록(테스트 설정용). */
  docStyles: Array<{ id: number; name: string; englishName: string }> = [];
  getStyleList() {
    return this.docStyles;
  }
  applyStyle(sec: number, para: number, styleId: number) {
    this.calls.push(`applyStyle(${sec},${para},${styleId})`);
    return { ok: true };
  }
  setFieldValue(fieldId: number, value: string) {
    this.calls.push(`setFieldValue(${fieldId},"${value}")`);
    return { ok: true, fieldId, oldValue: '', newValue: value };
  }
  /** 머리말/꼬리말 상태. 키: `${sec}.${isHeader}.${applyTo}` → 문단 텍스트 배열. */
  hf: Record<string, string[]> = {};
  getHeaderFooter(s: number, h: boolean, a: number): string {
    this.calls.push(`getHeaderFooter(${s},${h},${a})`);
    const paras = this.hf[`${s}.${h}.${a}`];
    return JSON.stringify(paras ? { ok: true, exists: true } : { ok: true, exists: false });
  }
  createHeaderFooter(s: number, h: boolean, a: number): string {
    this.calls.push(`createHeaderFooter(${s},${h},${a})`);
    this.hf[`${s}.${h}.${a}`] = [''];
    return JSON.stringify({ ok: true });
  }
  getHeaderFooterParaInfo(s: number, h: boolean, a: number, i: number): string {
    const paras = this.hf[`${s}.${h}.${a}`] ?? [];
    return JSON.stringify({
      ok: true,
      paraCount: paras.length,
      charCount: Array.from(paras[i] ?? '').length,
    });
  }
  insertTextInHeaderFooter(s: number, h: boolean, a: number, i: number, off: number, text: string): string {
    this.calls.push(`insertTextInHeaderFooter(${s},${h},${a},${i},${off},"${text}")`);
    return JSON.stringify({ ok: true });
  }
  deleteTextInHeaderFooter(s: number, h: boolean, a: number, i: number, off: number, count: number): string {
    this.calls.push(`deleteTextInHeaderFooter(${s},${h},${a},${i},${off},${count})`);
    return JSON.stringify({ ok: true });
  }
  splitParagraphInHeaderFooter(s: number, h: boolean, a: number, i: number, off: number): string {
    this.calls.push(`splitParagraphInHeaderFooter(${s},${h},${a},${i},${off})`);
    return JSON.stringify({ ok: true });
  }
  /** 각주 상태. 키: `${sec}.${para}.${ctrl}` → 문단 텍스트 배열. */
  fns: Record<string, string[]> = {};
  getFootnoteInfo(s: number, p: number, c: number) {
    const texts = this.fns[`${s}.${p}.${c}`] ?? [];
    return { ok: texts.length > 0, paraCount: texts.length, totalTextLen: 0, number: 1, texts };
  }
  insertTextInFootnote(s: number, p: number, c: number, i: number, off: number, text: string) {
    this.calls.push(`insertTextInFootnote(${s},${p},${c},${i},${off},"${text}")`);
    return { ok: true, charOffset: off + text.length };
  }
  deleteTextInFootnote(s: number, p: number, c: number, i: number, off: number, count: number) {
    this.calls.push(`deleteTextInFootnote(${s},${p},${c},${i},${off},${count})`);
    return { ok: true, charOffset: off };
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
    // style 미지정 → body 기본: 줄간격 180% + 문단 아래 6pt(600 HWPUNIT)로 빽빽함 방지.
    expect(wasm.calls).toEqual([
      'getParagraphLength(0,1)',
      'splitParagraph(0,1,5)',
      'insertText(0,2,0,"새 문단")',
      'applyCharFormat(0,2,0,4,{"fontSize":1000})',
      'applyParaFormat(0,2,{"alignment":"justify","lineSpacingType":"Percent","lineSpacing":180,"spacingAfter":600})',
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
      'applyCharFormat(0,5,0,3,{"fontSize":1000})',
      'applyParaFormat(0,5,{"alignment":"justify","lineSpacingType":"Percent","lineSpacing":180,"spacingAfter":600})',
      'insertPageBreak(0,5,0)',
    ]);
  });

  it('applies the caller-provided theme instead of hardcoded spacing', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.1'] = 5;
    const theme = compileTheme({
      id: 'wide',
      styles: { body: { fontPt: 11, lineSpacingPercent: 200, afterPt: 10 } },
    });
    applyActionScript(
      wasm,
      script([{ command: 'INSERT_AFTER', target_id: 'sec[0].p[1]', payload: { text: '새 문단' } }]),
      [],
      theme,
    );
    // 테마의 body 수치(11pt 글자, 줄간격 200%, 아래 10pt=2000)가 그대로 적용된다.
    expect(wasm.calls).toContain('applyCharFormat(0,2,0,4,{"fontSize":1100})');
    expect(
      wasm.calls.some((c) => c.includes('"lineSpacing":200') && c.includes('"spacingAfter":2000')),
    ).toBe(true);
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
      'applyParaFormat(0,5,{"spacingBefore":1600,"spacingAfter":1600})',
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
    expect(wasm.calls).toEqual([
      'splitParagraph(0,0,0)',
      'insertText(0,0,0,"X")',
      'applyCharFormat(0,0,0,1,{"fontSize":1000})',
      'applyParaFormat(0,0,{"alignment":"justify","lineSpacingType":"Percent","lineSpacing":180,"spacingAfter":600})',
    ]);
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
      'applyCharFormat(0,6,0,1,{"fontSize":1000})',
      'applyParaFormat(0,6,{"alignment":"justify","lineSpacingType":"Percent","lineSpacing":180,"spacingAfter":600})',
      'getParagraphLength(0,0)',
      'splitParagraph(0,0,0)',
      'insertText(0,1,0,"A")',
      'applyCharFormat(0,1,0,1,{"fontSize":1000})',
      'applyParaFormat(0,1,{"alignment":"justify","lineSpacingType":"Percent","lineSpacing":180,"spacingAfter":600})',
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

  // ── 머리말/꼬리말/각주 (F-191fd6) ───────────────────────────

  it('REPLACE on an existing header paragraph clears then inserts (applies to all pages)', () => {
    const wasm = new FakeWasm();
    wasm.hf['0.true.0'] = ['옛 머리말'];
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].header[0].p[0]',
          payload: { type: 'paragraph', text: '대외비 — 2026 사업계획' },
        },
      ]),
    );
    expect(result.applied).toBe(1);
    expect(wasm.calls).toEqual([
      'getHeaderFooter(0,true,0)',
      'deleteTextInHeaderFooter(0,true,0,0,0,5)',
      'insertTextInHeaderFooter(0,true,0,0,0,"대외비 — 2026 사업계획")',
    ]);
  });

  it('REPLACE on a missing footer placeholder creates it first (AC3)', () => {
    const wasm = new FakeWasm();
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].footer[0].p[0]',
          payload: { type: 'paragraph', text: '- 1 -' },
        },
      ]),
    );
    expect(result.applied).toBe(1);
    expect(wasm.calls).toEqual([
      'getHeaderFooter(0,false,0)',
      'createHeaderFooter(0,false,0)',
      'insertTextInHeaderFooter(0,false,0,0,0,"- 1 -")',
    ]);
  });

  it('footnote REPLACE rewrites content but preserves trailing marker spaces', () => {
    const wasm = new FakeWasm();
    wasm.fns['0.3.2'] = ['옛 출처  ']; // 끝 공백 2개 = 자동번호 표시 문자.
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[3].fn[2].p[0]',
          payload: { type: 'paragraph', text: '출처: 통계청(2026)' },
        },
      ]),
    );
    expect(result.applied).toBe(1);
    // 끝 공백 2자는 지우지 않는다(4자 중 2자만 삭제).
    expect(wasm.calls).toEqual([
      'deleteTextInFootnote(0,3,2,0,0,4)',
      'insertTextInFootnote(0,3,2,0,0,"출처: 통계청(2026)")',
    ]);
  });

  it('footnote INSERT is rejected with guidance (REPLACE/DELETE only)', () => {
    const wasm = new FakeWasm();
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[3].fn[2].p[0]',
          payload: { text: '추가' },
        },
      ]),
    );
    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('REPLACE');
    expect(wasm.calls).toEqual([]);
  });

  it('match-document theme leaves inserted body paragraphs untouched (inherits surroundings)', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.1'] = 5;
    const theme = compileTheme({
      id: 'match',
      noDefaults: true,
      styles: { heading: { bold: true, beforePt: 16, afterPt: 6 }, body: {} },
    });
    applyActionScript(
      wasm,
      script([
        // style 미지정 → body 기본 → 빈 사양 → 서식 호출 0건(분할 상속 유지).
        { command: 'INSERT_AFTER', target_id: 'sec[0].p[1]', payload: { text: '이어지는 본문' } },
      ]),
      [],
      theme,
    );
    expect(wasm.calls).toEqual([
      'getParagraphLength(0,1)',
      'splitParagraph(0,1,5)',
      'insertText(0,2,0,"이어지는 본문")',
    ]);
  });

  it('match-document theme applies only bold+spacing to headings (size/font inherited)', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.1'] = 5;
    const theme = compileTheme({
      id: 'match',
      noDefaults: true,
      styles: { heading: { bold: true, beforePt: 16, afterPt: 6 }, body: {} },
    });
    applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[1]',
          payload: { text: '다음 장', style: 'heading' },
        },
      ]),
      [],
      theme,
    );
    expect(wasm.calls).toContain('applyCharFormat(0,2,0,4,{"bold":true})');
    expect(
      wasm.calls.some((c) => c.includes('"spacingBefore":3200') && c.includes('"spacingAfter":1200')),
    ).toBe(true);
    // 글꼴 크기·줄간격은 건드리지 않는다.
    expect(wasm.calls.some((c) => c.includes('fontSize') || c.includes('lineSpacing'))).toBe(false);
  });

  it('uses the named document style when the theme maps a role to one', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.1'] = 5;
    wasm.docStyles = [
      { id: 0, name: '바탕글', englishName: 'Normal' },
      { id: 2, name: '개요 1', englishName: 'Outline 1' },
    ];
    const theme = compileTheme({ id: 'doc', styles: { heading: { styleName: '개요 1' } } });
    applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[1]',
          payload: { text: '사업 개요', style: 'heading' },
        },
      ]),
      [],
      theme,
    );
    // 문서 스타일을 통째로 적용 — 수치 서식(applyCharFormat/applyParaFormat)은 건너뛴다.
    expect(wasm.calls).toContain('applyStyle(0,2,2)');
    expect(wasm.calls.some((c) => c.startsWith('applyCharFormat'))).toBe(false);
  });

  it('falls back to numeric formatting when the named style is missing', () => {
    const wasm = new FakeWasm();
    wasm.lengths['0.1'] = 5;
    wasm.docStyles = [{ id: 0, name: '바탕글', englishName: 'Normal' }];
    const theme = compileTheme({ id: 'doc', styles: { heading: { styleName: '개요 1' } } });
    applyActionScript(
      wasm,
      script([
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[1]',
          payload: { text: '사업 개요', style: 'heading' },
        },
      ]),
      [],
      theme,
    );
    // '개요 1'이 문서에 없음 → 기본 수치 서식으로 폴백.
    expect(wasm.calls.some((c) => c.startsWith('applyStyle'))).toBe(false);
    expect(wasm.calls.some((c) => c.startsWith('applyCharFormat'))).toBe(true);
  });

  // ── 누름틀 템플릿 채우기 (F-10a6a5) ─────────────────────────

  it('REPLACE on a field target sets the field value only (template preserved)', () => {
    const wasm = new FakeWasm();
    const result = applyActionScript(
      wasm,
      script([
        {
          command: 'REPLACE',
          target_id: 'field[3:사업명]',
          payload: { type: 'paragraph', text: '실시간 도장면 검사 시스템 개발' },
        },
        { command: 'DELETE', target_id: 'field[7:비고]', payload: {} },
      ]),
    );
    expect(result.applied).toBe(2);
    // 값 교체만 — 문단/서식 프리미티브는 전혀 호출되지 않는다.
    expect(wasm.calls).toEqual([
      'setFieldValue(3,"실시간 도장면 검사 시스템 개발")',
      'setFieldValue(7,"")',
    ]);
  });

  it('INSERT into a field target is rejected with guidance', () => {
    const wasm = new FakeWasm();
    const result = applyActionScript(
      wasm,
      script([
        { command: 'INSERT_AFTER', target_id: 'field[3:사업명]', payload: { text: '추가' } },
      ]),
    );
    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('REPLACE');
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

  // ── F-466f8e: 다줄 텍스트 채우기 (줄바꿈 → 문단 분할) ─────────

  describe('AC-dcebbb (body multi-line split)', () => {
    it('INSERT_AFTER with newlines splits into multiple paragraphs (no \\n in results)', () => {
      const wasm = new FakeWasm();
      wasm.lengths['0.1'] = 5;
      const result = applyActionScript(
        wasm,
        script([
          {
            command: 'INSERT_AFTER',
            target_id: 'sec[0].p[1]',
            payload: { text: '첫 줄\n두 번째\n세 번째', style: 'body' },
          },
        ]),
      );
      expect(result.applied).toBe(1);
      const inserts = wasm.calls.filter((c) => c.startsWith('insertText('));
      // 3줄 → 3개 insertText 호출
      expect(inserts).toHaveLength(3);
      expect(inserts).toEqual([
        'insertText(0,2,0,"첫 줄")',
        'insertText(0,3,0,"두 번째")',
        'insertText(0,4,0,"세 번째")',
      ]);
      // 줄바꿈 문자가 남아있지 않음
      inserts.forEach((call) => {
        expect(call).not.toContain('\\n');
      });
      // splitParagraph: 초기(INSERT_AFTER) 1회 + fillBodyLines(2줄) 2회 = 3회
      const splits = wasm.calls.filter((c) => c.startsWith('splitParagraph('));
      expect(splits).toHaveLength(3);
      expect(result.changed).toHaveLength(3); // 3개 문단이 changed에 기록됨
    });

    it('REPLACE with newlines splits into multiple paragraphs', () => {
      const wasm = new FakeWasm();
      wasm.lengths['0.2'] = 4;
      const result = applyActionScript(
        wasm,
        script([
          {
            command: 'REPLACE',
            target_id: 'sec[0].p[2]',
            payload: { text: '연구내용 1\n연구내용 2\n연구내용 3' },
          },
        ]),
      );
      expect(result.applied).toBe(1);
      const inserts = wasm.calls.filter((c) => c.startsWith('insertText('));
      expect(inserts).toHaveLength(3);
      // REPLACE는 초기 분할 없음, fillBodyLines만 2줄 분할
      const splits = wasm.calls.filter((c) => c.startsWith('splitParagraph('));
      expect(splits).toHaveLength(2);
    });

    it('empty lines in split text create empty paragraphs', () => {
      const wasm = new FakeWasm();
      wasm.lengths['0.0'] = 3;
      applyActionScript(
        wasm,
        script([
          {
            command: 'INSERT_AFTER',
            target_id: 'sec[0].p[0]',
            payload: { text: '첫 줄\n\n세 번째' },
          },
        ]),
      );
      const inserts = wasm.calls.filter((c) => c.startsWith('insertText('));
      // 3줄(첫, 빈, 세) → insertText는 빈 줄을 건너뛴다
      expect(inserts).toHaveLength(2); // "첫 줄"과 "세 번째"만
      expect(inserts[0]).toContain('"첫 줄"');
      expect(inserts[1]).toContain('"세 번째"');
      // 초기 1회 + fillBodyLines 2줄 분할 2회 = 3회
      const splits = wasm.calls.filter((c) => c.startsWith('splitParagraph('));
      expect(splits).toHaveLength(3);
    });
  });

  describe('AC-f1c06b (cell multi-line via splitParagraphInCell)', () => {
    it('REPLACE in top-level cell with newlines uses splitParagraphInCell for each extra line', () => {
      const wasm = new FakeWasm();
      wasm.lengths['0.2.0.5.0'] = 5;
      const result = applyActionScript(
        wasm,
        script([
          {
            command: 'REPLACE',
            target_id: 'sec[0].p[2].tbl[0].cell[5].p[0]',
            payload: { text: '항목 1\n항목 2\n항목 3' },
          },
        ]),
      );
      expect(result.applied).toBe(1);
      const splits = wasm.calls.filter((c) => c.startsWith('splitParagraphInCell('));
      // fillCellLinesFlat: 2줄 분할 (3줄이므로 줄마다 분할하되 i>0일 때만)
      expect(splits).toHaveLength(2);
      const inserts = wasm.calls.filter((c) => c.startsWith('insertTextInCell('));
      expect(inserts).toHaveLength(3);
      // 표 구조 변경 API 호출 없음
      expect(wasm.calls.some((c) => c.startsWith('insertTableRow'))).toBe(false);
      expect(wasm.calls.some((c) => c.startsWith('insertTableColumn'))).toBe(false);
      expect(wasm.calls.some((c) => c.startsWith('mergeTableCells'))).toBe(false);
    });

    it('INSERT_AFTER in top-level cell with newlines splits and fills each line', () => {
      const wasm = new FakeWasm();
      wasm.lengths['0.2.0.5.0'] = 3;
      const result = applyActionScript(
        wasm,
        script([
          {
            command: 'INSERT_AFTER',
            target_id: 'sec[0].p[2].tbl[0].cell[5].p[0]',
            payload: { text: '추가 1\n추가 2' },
          },
        ]),
      );
      expect(result.applied).toBe(1);
      const splits = wasm.calls.filter((c) => c.startsWith('splitParagraphInCell('));
      // 첫 번째 분할(p[0] 끝) + 2줄 fillCellLinesFlat(1줄 분할) = 2회
      expect(splits).toHaveLength(2);
      const inserts = wasm.calls.filter((c) => c.startsWith('insertTextInCell('));
      expect(inserts).toHaveLength(2); // 2줄
      expect(inserts[0]).toContain('"추가 1"');
      expect(inserts[1]).toContain('"추가 2"');
    });

    it('REPLACE in nested cell with newlines uses splitParagraphInCellByPath', () => {
      const wasm = new FakeWasm();
      const path =
        '[{"controlIndex":2,"cellIndex":0,"cellParaIndex":4},{"controlIndex":0,"cellIndex":11,"cellParaIndex":0}]';
      wasm.lengths[`0.0.${path}`] = 5;
      const result = applyActionScript(
        wasm,
        script([
          {
            command: 'REPLACE',
            target_id: 'sec[0].p[0].tbl[2].cell[0].p[4].tbl[0].cell[11].p[0]',
            payload: { text: '중첩 줄 1\n중첩 줄 2' },
          },
        ]),
      );
      expect(result.applied).toBe(1);
      const splits = wasm.calls.filter((c) => c.startsWith('splitParagraphInCellByPath('));
      // fillCellLinesByPath: 2줄이므로 1줄 분할
      expect(splits).toHaveLength(1);
      const inserts = wasm.calls.filter((c) => c.startsWith('insertTextInCellByPath('));
      expect(inserts).toHaveLength(2);
      expect(inserts[0]).toContain('"중첩 줄 1"');
      expect(inserts[1]).toContain('"중첩 줄 2"');
      // 표 구조 변경 API 호출 없음
      expect(wasm.calls.some((c) => c.startsWith('insertTableRow'))).toBe(false);
      expect(wasm.calls.some((c) => c.startsWith('insertTableColumn'))).toBe(false);
      expect(wasm.calls.some((c) => c.startsWith('mergeTableCells'))).toBe(false);
    });

    it('INSERT_BEFORE in nested cell with newlines uses splitParagraphInCellByPath', () => {
      const wasm = new FakeWasm();
      const path =
        '[{"controlIndex":1,"cellIndex":3,"cellParaIndex":0},{"controlIndex":0,"cellIndex":7,"cellParaIndex":2}]';
      wasm.lengths[`0.1.${path}`] = 0;
      const result = applyActionScript(
        wasm,
        script([
          {
            command: 'INSERT_BEFORE',
            target_id: 'sec[0].p[1].tbl[1].cell[3].p[0].tbl[0].cell[7].p[2]',
            payload: { text: '앞추가 1\n앞추가 2\n앞추가 3' },
          },
        ]),
      );
      expect(result.applied).toBe(1);
      const splits = wasm.calls.filter((c) => c.startsWith('splitParagraphInCellByPath('));
      // 초기(INSERT_BEFORE) 1회 + fillCellLinesByPath(2줄) 2회 = 3회
      expect(splits).toHaveLength(3);
      const inserts = wasm.calls.filter((c) => c.startsWith('insertTextInCellByPath('));
      expect(inserts).toHaveLength(3);
    });
  });

  describe('AC-cf5898 (format inheritance)', () => {
    it('body multi-line split applies style to each derived paragraph', () => {
      const wasm = new FakeWasm();
      wasm.lengths['0.1'] = 0;
      applyActionScript(
        wasm,
        script([
          {
            command: 'INSERT_AFTER',
            target_id: 'sec[0].p[1]',
            payload: { text: '스타일 1\n스타일 2', style: 'heading' },
          },
        ]),
      );
      // applyParaStyle가 각 문단마다 호출됨
      const charFormats = wasm.calls.filter((c) => c.startsWith('applyCharFormat('));
      const paraFormats = wasm.calls.filter((c) => c.startsWith('applyParaFormat('));
      // 2줄 → 각각 charFormat/paraFormat 적용
      expect(charFormats.length).toBeGreaterThanOrEqual(2);
      expect(paraFormats.length).toBeGreaterThanOrEqual(2);
    });

    it('flat cell multi-line split preserves formatting via splitParagraphInCell inheritance', () => {
      const wasm = new FakeWasm();
      wasm.lengths['0.2.0.5.0'] = 0;
      applyActionScript(
        wasm,
        script([
          {
            command: 'INSERT_AFTER',
            target_id: 'sec[0].p[2].tbl[0].cell[5].p[0]',
            payload: { text: '형식 A\n형식 B\n형식 C' },
          },
        ]),
      );
      // splitParagraphInCell이 원 셀 문단의 형식을 상속 → 추가 형식 호출 없음
      const cellParaFormats = wasm.calls.filter((c) => c.startsWith('applyParaFormatInCell('));
      // 형식 호출이 없거나(분할이 상속함) 최소한 분할된 줄 수보다 적음
      expect(cellParaFormats.length).toBeLessThanOrEqual(0);
    });

    it('nested cell multi-line split preserves formatting via splitParagraphInCellByPath', () => {
      const wasm = new FakeWasm();
      const path =
        '[{"controlIndex":2,"cellIndex":0,"cellParaIndex":4},{"controlIndex":0,"cellIndex":11,"cellParaIndex":0}]';
      wasm.lengths[`0.0.${path}`] = 0;
      applyActionScript(
        wasm,
        script([
          {
            command: 'REPLACE',
            target_id: 'sec[0].p[0].tbl[2].cell[0].p[4].tbl[0].cell[11].p[0]',
            payload: { text: '중첩형식 1\n중첩형식 2' },
          },
        ]),
      );
      // by-path API는 자동으로 형식을 상속 → 추가 형식 호출 없음
      const byPathCalls = wasm.calls.filter((c) => c.includes('ByPath'));
      expect(byPathCalls.length).toBeGreaterThan(0);
      // 중첩 셀 전용 형식 API(예: applyParaFormatInCellByPath)는 호출되지 않음
      expect(wasm.calls.some((c) => c.includes('applyParaFormatInCellByPath'))).toBe(false);
    });
  });

  describe('AC-0e8abc (no-newline regression)', () => {
    it('single-line text results in one insert and one initial split (unchanged path)', () => {
      const wasm = new FakeWasm();
      wasm.lengths['0.1'] = 5;
      applyActionScript(
        wasm,
        script([
          {
            command: 'INSERT_AFTER',
            target_id: 'sec[0].p[1]',
            payload: { text: '단일 줄 텍스트' },
          },
        ]),
      );
      // INSERT_AFTER: 초기 분할 1회 + fillBodyLines(1줄) 0회 = 1회
      const splits = wasm.calls.filter((c) => c.startsWith('splitParagraph('));
      expect(splits).toHaveLength(1); // 초기 분할만
      const inserts = wasm.calls.filter((c) => c.startsWith('insertText('));
      expect(inserts).toHaveLength(1); // 단일 삽입
    });

    it('REPLACE without newlines does not split', () => {
      const wasm = new FakeWasm();
      wasm.lengths['0.2'] = 4;
      applyActionScript(
        wasm,
        script([
          {
            command: 'REPLACE',
            target_id: 'sec[0].p[2]',
            payload: { text: '단순 교체' },
          },
        ]),
      );
      // REPLACE는 초기 분할이 없음, fillBodyLines(1줄) 0회 = 0회
      const splits = wasm.calls.filter((c) => c.startsWith('splitParagraph('));
      expect(splits).toHaveLength(0);
      const inserts = wasm.calls.filter((c) => c.startsWith('insertText('));
      expect(inserts).toHaveLength(1);
    });

    it('cell REPLACE without newlines uses single insertTextInCell', () => {
      const wasm = new FakeWasm();
      wasm.lengths['0.2.0.5.0'] = 8;
      applyActionScript(
        wasm,
        script([
          {
            command: 'REPLACE',
            target_id: 'sec[0].p[2].tbl[0].cell[5].p[0]',
            payload: { text: '셀 내용' },
          },
        ]),
      );
      const splits = wasm.calls.filter((c) => c.startsWith('splitParagraphInCell('));
      expect(splits).toHaveLength(0); // 줄바꿈이 없으면 분할 없음
      const inserts = wasm.calls.filter((c) => c.startsWith('insertTextInCell('));
      expect(inserts).toHaveLength(1);
    });

    it('cell INSERT_BEFORE without newlines uses single insert', () => {
      const wasm = new FakeWasm();
      const result = applyActionScript(
        wasm,
        script([
          {
            command: 'INSERT_BEFORE',
            target_id: 'sec[0].p[0].tbl[2].cell[0].p[0]',
            payload: { text: '앞 단일' },
          },
        ]),
      );
      expect(result.applied).toBe(1);
      // INSERT_BEFORE: 초기 분할 1회 + fillCellLinesFlat(1줄) 0회 = 1회
      const splits = wasm.calls.filter((c) => c.startsWith('splitParagraphInCell('));
      expect(splits).toHaveLength(1); // INSERT_BEFORE 초기 분할만
      const inserts = wasm.calls.filter((c) => c.startsWith('insertTextInCell('));
      expect(inserts).toHaveLength(1);
    });
  });
});
