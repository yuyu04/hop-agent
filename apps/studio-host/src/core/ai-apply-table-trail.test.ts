/**
 * F-a7b2c7ba AC-afcb29ff: AI가 새 표를 본문에 INSERT 하면 표 뒤에 빈 문단을 남기지 않고,
 * 미리 적용 결과 changed[]의 위치가 실제 문단과 어긋나지 않는다.
 *
 * 엔진 목(ParagraphDoc)은 문단을 배열로 모델링한다 — split은 문단을 끼우고, merge는 문단을
 * 앞 문단에 붙여 없애며, createTable은 rhwp `create_table_native`처럼 '빈 문단이면 그 자리를
 * 표 문단으로 바꾸고 바로 뒤에 빈 문단 하나를 덧붙인다'(문단 수 +1). 그래서 테스트는 호출
 * 순서가 아니라 '적용 후 문서의 실제 문단 배열'과 changed[]를 대조한다.
 */
import { describe, expect, it } from 'vitest';
import { applyActionScript, type WasmEditing } from './ai-apply';
import type { ActionScript, Edit } from './ai-bridge';

interface Para {
  text: string;
  /** 표 컨트롤이 든 문단(표 host). */
  table?: boolean;
  /** 표 셀 텍스트(행 우선 셀 인덱스). */
  cells?: string[];
}

/**
 * createTable 동작 방식.
 * - rhwp: 실제 엔진과 같다(빈 host 문단 → 표 문단, 그 뒤에 빈 문단 덧붙임, 문단 수 +1).
 * - noTrailing: 표 문단으로 바꾸기만 하고 문단 수가 늘지 않는다.
 * - trailingText: rhwp와 같지만 덧붙은 문단에 글자가 남아 있다(지우면 안 되는 내용).
 * - appendAfter: 대상 문단 '뒤'에 표 문단을 끼운다(대상이 마지막이면 표 문단이 문서 끝).
 */
type TableMode = 'rhwp' | 'noTrailing' | 'trailingText' | 'appendAfter';

class ParagraphDoc implements WasmEditing {
  paras: Para[];
  calls: string[] = [];
  tableMode: TableMode = 'rhwp';

  constructor(texts: string[]) {
    this.paras = texts.map((text) => ({ text }));
  }

  /** 테스트에서 지워(delete) '문단 수 API가 없는 엔진'을 흉내 낸다. */
  getParagraphCount?: (sec: number) => number = (sec: number) => {
    this.calls.push(`getParagraphCount(${sec})`);
    return this.paras.length;
  };

  private at(para: number): Para {
    const p = this.paras[para];
    if (!p) throw new Error(`문단 ${para} 범위 초과(총 ${this.paras.length}개)`);
    return p;
  }

  getParagraphLength(sec: number, para: number): number {
    this.calls.push(`getParagraphLength(${sec},${para})`);
    return [...this.at(para).text].length;
  }

  insertText(sec: number, para: number, charOffset: number, text: string): string {
    this.calls.push(`insertText(${sec},${para},${charOffset})`);
    const p = this.at(para);
    const chars = [...p.text];
    chars.splice(charOffset, 0, ...text);
    p.text = chars.join('');
    return '';
  }

  deleteText(sec: number, para: number, charOffset: number, count: number): string {
    this.calls.push(`deleteText(${sec},${para},${charOffset},${count})`);
    const p = this.at(para);
    const chars = [...p.text];
    chars.splice(charOffset, count);
    p.text = chars.join('');
    return '';
  }

  splitParagraph(sec: number, para: number, charOffset: number): string {
    this.calls.push(`splitParagraph(${sec},${para},${charOffset})`);
    const p = this.at(para);
    const chars = [...p.text];
    p.text = chars.slice(0, charOffset).join('');
    this.paras.splice(para + 1, 0, { text: chars.slice(charOffset).join('') });
    return '';
  }

  /** `para`를 앞 문단(para-1)에 붙여 없앤다. */
  mergeParagraph(sec: number, para: number): string {
    this.calls.push(`mergeParagraph(${sec},${para})`);
    if (para <= 0) throw new Error('첫 문단은 앞 문단에 붙일 수 없습니다.');
    const p = this.at(para);
    this.at(para - 1).text += p.text;
    this.paras.splice(para, 1);
    return '';
  }

  insertPageBreak(sec: number, para: number, charOffset: number): string {
    this.calls.push(`insertPageBreak(${sec},${para},${charOffset})`);
    return '';
  }

  createTable(sec: number, para: number, charOffset: number, rows: number, cols: number) {
    this.calls.push(`createTable(${sec},${para},${charOffset},${rows},${cols})`);
    const host = this.at(para);
    const table = (): Para => ({ text: '', table: true, cells: Array(rows * cols).fill('') });
    switch (this.tableMode) {
      case 'rhwp': {
        // create_table_native: 빈 문단이면 그 자리를 표 문단으로, 아니면(오프셋 0) 앞에 끼운다.
        // 어느 쪽이든 표 문단 바로 뒤에 빈 문단을 하나 덧붙인다.
        if (host.text === '' && !host.table) this.paras[para] = table();
        else this.paras.splice(para, 0, table());
        this.paras.splice(para + 1, 0, { text: '' });
        return { ok: true, paraIdx: para, controlIdx: 0 };
      }
      case 'noTrailing':
        this.paras[para] = table();
        return { ok: true, paraIdx: para, controlIdx: 0 };
      case 'trailingText':
        this.paras[para] = table();
        this.paras.splice(para + 1, 0, { text: '꼬리 글' });
        return { ok: true, paraIdx: para, controlIdx: 0 };
      case 'appendAfter':
        this.paras.splice(para + 1, 0, table());
        return { ok: true, paraIdx: para + 1, controlIdx: 0 };
    }
  }

  insertTextInCell(
    sec: number,
    parentPara: number,
    controlIdx: number,
    cellIdx: number,
    cellParaIdx: number,
    charOffset: number,
    text: string,
  ): string {
    this.calls.push(`insertTextInCell(${sec},${parentPara},${controlIdx},${cellIdx})`);
    const host = this.at(parentPara);
    if (!host.table || !host.cells) throw new Error(`문단 ${parentPara}에는 표가 없습니다.`);
    host.cells[cellIdx] = text;
    return '';
  }

  mergeTableCells() {
    return { ok: true, cellCount: 1 };
  }

  // ── 이 기능 경로에서 쓰이지 않는 표면: 불리면 바로 드러나도록 던진다 ──
  private unexpected(name: string): never {
    throw new Error(`예상하지 않은 호출: ${name}`);
  }
  getCellParagraphLength(): number {
    return this.unexpected('getCellParagraphLength');
  }
  deleteTextInCell(): string {
    return this.unexpected('deleteTextInCell');
  }
  splitParagraphInCell(): string {
    return this.unexpected('splitParagraphInCell');
  }
  getCellParagraphLengthByPath(): number {
    return this.unexpected('getCellParagraphLengthByPath');
  }
  insertTextInCellByPath(): string {
    return this.unexpected('insertTextInCellByPath');
  }
  splitParagraphInCellByPath(): string {
    return this.unexpected('splitParagraphInCellByPath');
  }
  deleteTextInCellByPath(): string {
    return this.unexpected('deleteTextInCellByPath');
  }
  setFieldValue(): { ok: boolean; fieldId: number; oldValue: string; newValue: string } {
    return this.unexpected('setFieldValue');
  }
  getHeaderFooter(): string {
    return this.unexpected('getHeaderFooter');
  }
  createHeaderFooter(): string {
    return this.unexpected('createHeaderFooter');
  }
  getHeaderFooterParaInfo(): string {
    return this.unexpected('getHeaderFooterParaInfo');
  }
  insertTextInHeaderFooter(): string {
    return this.unexpected('insertTextInHeaderFooter');
  }
  deleteTextInHeaderFooter(): string {
    return this.unexpected('deleteTextInHeaderFooter');
  }
  splitParagraphInHeaderFooter(): string {
    return this.unexpected('splitParagraphInHeaderFooter');
  }
  getFootnoteInfo(): { ok: boolean; paraCount: number; totalTextLen: number; number: number; texts: string[] } {
    return this.unexpected('getFootnoteInfo');
  }
  insertTextInFootnote(): { ok: boolean; charOffset: number } {
    return this.unexpected('insertTextInFootnote');
  }
  deleteTextInFootnote(): { ok: boolean; charOffset: number } {
    return this.unexpected('deleteTextInFootnote');
  }
  insertTableRow(): { ok: boolean; rowCount: number; colCount: number } {
    return this.unexpected('insertTableRow');
  }
  insertTableColumn(): { ok: boolean; rowCount: number; colCount: number } {
    return this.unexpected('insertTableColumn');
  }
  deleteTableRow(): { ok: boolean; rowCount: number; colCount: number } {
    return this.unexpected('deleteTableRow');
  }
  deleteTableColumn(): { ok: boolean; rowCount: number; colCount: number } {
    return this.unexpected('deleteTableColumn');
  }

  /** 문서를 읽기 쉬운 배열로: 표 문단은 `[표:셀1|셀2…]`. */
  snapshot(): string[] {
    return this.paras.map((p) => (p.table ? `[표:${(p.cells ?? []).join('|')}]` : p.text));
  }

  merges(): string[] {
    return this.calls.filter((c) => c.startsWith('mergeParagraph'));
  }
}

const TABLE_2X2 = { rows: 2, cols: 2, matrix: [['구분', '값'], ['A', '1']] };
const TABLE_2X2_SNAPSHOT = '[표:구분|값|A|1]';

function tableAfter(targetId: string, matrix = TABLE_2X2.matrix): Edit {
  return {
    command: 'INSERT_AFTER',
    target_id: targetId,
    payload: { type: 'table', table_data: { rows: matrix.length, cols: matrix[0].length, matrix } },
  };
}

function textAfter(targetId: string, text: string): Edit {
  return { command: 'INSERT_AFTER', target_id: targetId, payload: { type: 'paragraph', text } };
}

function script(...edits: Edit[]): ActionScript {
  return { edits };
}

/** changed[]를 편집 순서(editIndex)별 최종 문단 번호로. */
function positionsByEdit(changed: { sec: number; para: number; editIndex?: number }[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const c of changed) {
    expect(c.sec).toBe(0);
    out[c.editIndex ?? -1] = c.para;
  }
  return out;
}

describe('F-a7b2c7ba AC-afcb29ff: 새 표 INSERT 뒤에 빈 문단을 남기지 않는다', () => {
  it('AC-afcb29ff: INSERT_AFTER 표 — 표 생성이 덧붙인 빈 문단을 걷어 내 표 바로 뒤에 다음 내용이 온다', () => {
    const doc = new ParagraphDoc(['제목', '앵커', '끝 문단']);

    const result = applyActionScript(doc, script(tableAfter('sec[0].p[1]')));

    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(doc.snapshot()).toEqual(['제목', '앵커', TABLE_2X2_SNAPSHOT, '끝 문단']);
    // 걷어 낸 것은 표(2번) 바로 뒤에 덧붙은 빈 문단(3번) 하나뿐이다.
    expect(doc.merges()).toEqual(['mergeParagraph(0,3)']);
    expect(result.changed).toEqual([{ sec: 0, para: 2, editIndex: 0 }]);
    expect(doc.paras[2].table).toBe(true);
  });

  it('AC-afcb29ff: INSERT_BEFORE 표 — 표와 원래 문단 사이에도 빈 문단이 남지 않는다', () => {
    const doc = new ParagraphDoc(['제목', '본문']);

    const result = applyActionScript(doc, script({ ...tableAfter('sec[0].p[1]'), command: 'INSERT_BEFORE' }));

    expect(result.applied).toBe(1);
    expect(doc.snapshot()).toEqual(['제목', TABLE_2X2_SNAPSHOT, '본문']);
    expect(result.changed).toEqual([{ sec: 0, para: 1, editIndex: 0 }]);
  });

  it('AC-afcb29ff: 표 뒤 문단에 글자가 있으면 합치지 않는다(내용을 표 문단에 붙이지 않음)', () => {
    const doc = new ParagraphDoc(['제목', '앵커', '끝 문단']);
    doc.tableMode = 'trailingText';

    const result = applyActionScript(doc, script(tableAfter('sec[0].p[1]')));

    expect(result.applied).toBe(1);
    expect(doc.merges()).toEqual([]);
    expect(doc.snapshot()).toEqual(['제목', '앵커', TABLE_2X2_SNAPSHOT, '꼬리 글', '끝 문단']);
  });

  it('AC-afcb29ff: 표 생성으로 문단 수가 늘지 않았으면, 원래 있던 빈 문단을 지우지 않는다', () => {
    // 앵커 뒤의 빈 문단(2번)은 사용자가 둔 것 — 표 생성이 덧붙인 것이 아니다.
    const doc = new ParagraphDoc(['제목', '앵커', '', '끝 문단']);
    doc.tableMode = 'noTrailing';

    const result = applyActionScript(doc, script(tableAfter('sec[0].p[1]')));

    expect(result.applied).toBe(1);
    expect(doc.merges()).toEqual([]);
    expect(doc.snapshot()).toEqual(['제목', '앵커', TABLE_2X2_SNAPSHOT, '', '끝 문단']);
    expect(result.changed).toEqual([{ sec: 0, para: 2, editIndex: 0 }]);
  });

  it('AC-afcb29ff: 표 문단이 구역의 마지막 문단이면 합치지 않고, 범위 밖 문단을 읽지도 않는다', () => {
    const doc = new ParagraphDoc(['제목', '앵커']);
    doc.tableMode = 'appendAfter';

    const result = applyActionScript(doc, script(tableAfter('sec[0].p[1]')));

    expect(result.applied).toBe(1);
    // 분할로 생긴 빈 문단(2번) 뒤에 표 문단(3번)이 문서 끝으로 들어갔다.
    expect(doc.snapshot()).toEqual(['제목', '앵커', '', TABLE_2X2_SNAPSHOT]);
    expect(doc.merges()).toEqual([]);
    expect(doc.calls).not.toContain('getParagraphLength(0,4)');
  });

  it('AC-afcb29ff: 문단 수를 잴 수 없는 엔진(getParagraphCount 없음)에서는 아무것도 합치지 않는다', () => {
    const doc = new ParagraphDoc(['제목', '앵커', '끝 문단']);
    delete doc.getParagraphCount;

    const result = applyActionScript(doc, script(tableAfter('sec[0].p[1]')));

    expect(result.applied).toBe(1);
    expect(doc.merges()).toEqual([]);
    // 정리하지 못한 빈 문단이 그대로 남는다(표 내용은 정상).
    expect(doc.snapshot()).toEqual(['제목', '앵커', TABLE_2X2_SNAPSHOT, '', '끝 문단']);
  });
});

describe('F-a7b2c7ba AC-afcb29ff: 표가 섞인 스크립트의 changed[]가 실제 문단 위치와 맞는다', () => {
  it('AC-afcb29ff: 새 문서에서 같은 앵커에 글·표·글·표·글을 INSERT_AFTER 해도 빈 줄 없이 순서대로 놓이고 changed[]가 그 문단을 가리킨다', () => {
    const doc = new ParagraphDoc(['']);
    const plan = script(
      { command: 'REPLACE', target_id: 'sec[0].p[0]', payload: { type: 'paragraph', text: '보고서 제목' } },
      textAfter('sec[0].p[0]', '<표 1> 추진 일정'),
      tableAfter('sec[0].p[0]', [['단계', '기간'], ['설계', '1개월']]),
      textAfter('sec[0].p[0]', '표 다음 본문'),
      tableAfter('sec[0].p[0]', [['항목', '금액'], ['인건비', '100']]),
      textAfter('sec[0].p[0]', '마무리'),
    );

    const result = applyActionScript(doc, plan);

    expect(result.applied).toBe(6);
    expect(result.skipped).toEqual([]);
    expect(doc.snapshot()).toEqual([
      '보고서 제목',
      '<표 1> 추진 일정',
      '[표:단계|기간|설계|1개월]',
      '표 다음 본문',
      '[표:항목|금액|인건비|100]',
      '마무리',
    ]);
    expect(positionsByEdit(result.changed)).toEqual({ 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5 });
    // changed[]가 가리키는 문단이 그 편집이 만든 내용인지 직접 대조한다.
    for (const c of result.changed) {
      const edit = plan.edits[c.editIndex!];
      const para = doc.paras[c.para];
      if (edit.payload.type === 'table') expect(para.table).toBe(true);
      else expect(para.text).toBe(edit.payload.text);
    }
  });

  it('AC-afcb29ff: 서로 다른 앵커에 표와 글을 넣어도 changed[]가 표 문단·글 문단을 정확히 가리킨다', () => {
    const doc = new ParagraphDoc(['제목', '본문1', '본문2']);
    const plan = script(tableAfter('sec[0].p[0]'), textAfter('sec[0].p[1]', '추가 문단'), tableAfter('sec[0].p[2]'));

    const result = applyActionScript(doc, plan);

    expect(result.applied).toBe(3);
    expect(doc.snapshot()).toEqual([
      '제목',
      TABLE_2X2_SNAPSHOT,
      '본문1',
      '추가 문단',
      '본문2',
      TABLE_2X2_SNAPSHOT,
    ]);
    expect(positionsByEdit(result.changed)).toEqual({ 0: 1, 1: 3, 2: 5 });
    expect(doc.paras[1].table).toBe(true);
    expect(doc.paras[3].text).toBe('추가 문단');
    expect(doc.paras[5].table).toBe(true);
  });
});
