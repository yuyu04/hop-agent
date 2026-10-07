/**
 * F-45cee3df AI 문서 서식 명령 — para_format, page_setup, page_number, char_format의 적합성 검증.
 *
 * 각 AC마다 하나씩. WasmEditing은 호출을 기록하는 목이고, 검증 대상은
 * "AI가 낸 편집이 어떤 엔진 호출로 번역되는가"와 "어떤 편집이 skipped로 보고되는가"다.
 */
import { describe, it, expect } from 'vitest';
import { applyActionScript, paraFormatProps, type PageDefLike, type WasmEditing } from './ai-apply';
import { DOC_SCOPE_TARGET, type ActionScript, type Edit } from './ai-bridge';

interface Call {
  fn: string;
  args: unknown[];
}

function makeWasm(opts: { omit?: string[] } = {}): { wasm: WasmEditing; calls: Call[] } {
  const calls: Call[] = [];
  const omit = new Set(opts.omit ?? []);

  const rec = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return { ok: true } as any;
  };

  const base: Record<string, unknown> = {
    getParagraphLength: () => 0,
    insertText: rec('insertText'),
    deleteText: rec('deleteText'),
    splitParagraph: rec('splitParagraph'),
    mergeParagraph: rec('mergeParagraph'),
    insertPageBreak: rec('insertPageBreak'),
    applyParaFormat: rec('applyParaFormat'),
    applyCharFormat: rec('applyCharFormat'),
    getTextRange: () => 'target',
    findOrCreateFontId: (name: string) => {
      calls.push({ fn: 'findOrCreateFontId', args: [name] });
      return 42;
    },
  };

  if (!omit.has('section')) {
    base.getSectionCount = () => {
      calls.push({ fn: 'getSectionCount', args: [] });
      return 1;
    };
    base.getPageDef = (idx: number) => {
      calls.push({ fn: 'getPageDef', args: [idx] });
      return {
        width: 59535,
        height: 84211,
        marginLeft: 1417,
        marginRight: 1417,
        marginTop: 1417,
        marginBottom: 1417,
        marginHeader: 709,
        marginFooter: 709,
        marginGutter: 0,
        landscape: false,
        binding: 0,
      };
    };
    base.setPageDef = rec('setPageDef');
  }

  if (!omit.has('hf')) {
    base.applyHfTemplate = rec('applyHfTemplate');
    base.insertTextInHeaderFooter = rec('insertTextInHeaderFooter');
    base.insertFieldInHf = rec('insertFieldInHf');
  }

  if (!omit.has('numbering')) {
    base.ensureDefaultNumbering = () => {
      calls.push({ fn: 'ensureDefaultNumbering', args: [] });
      return 1;
    };
    base.ensureDefaultBullet = (bulletChar: string) => {
      calls.push({ fn: 'ensureDefaultBullet', args: [bulletChar] });
      return 2;
    };
  }

  return { wasm: base as unknown as WasmEditing, calls };
}

function script(...edits: Edit[]): ActionScript {
  return { edits };
}

/**
 * 대상에 실제 내용이 있는 목. 서식 전용 편집이 잘못된 경로로 흘러가면 그 내용을 지우는 호출
 * (deleteText·setFieldValue('')·머리말/각주/셀 지우기·분할)이 기록되도록 각 표면을 단다.
 */
function makeContentWasm(): { wasm: WasmEditing; calls: Call[] } {
  const made = makeWasm();
  const { calls } = made;
  const rec = (fn: string) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return { ok: true } as any;
  };
  Object.assign(made.wasm, {
    getParagraphLength: () => 5,
    setFieldValue: (fieldId: number, value: string) => {
      calls.push({ fn: 'setFieldValue', args: [fieldId, value] });
      return { ok: true, fieldId, oldValue: '기존 값', newValue: value };
    },
    getHeaderFooter: () => JSON.stringify({ ok: true, exists: true }),
    createHeaderFooter: rec('createHeaderFooter'),
    getHeaderFooterParaInfo: () => JSON.stringify({ ok: true, paraCount: 1, charCount: 4 }),
    deleteTextInHeaderFooter: rec('deleteTextInHeaderFooter'),
    splitParagraphInHeaderFooter: rec('splitParagraphInHeaderFooter'),
    getFootnoteInfo: () => ({ ok: true, paraCount: 1, totalTextLen: 5, number: 1, texts: ['각주 내용'] }),
    deleteTextInFootnote: rec('deleteTextInFootnote'),
    insertTextInFootnote: rec('insertTextInFootnote'),
    getCellParagraphLength: () => 3,
    deleteTextInCell: rec('deleteTextInCell'),
    insertTextInCell: rec('insertTextInCell'),
    splitParagraphInCell: rec('splitParagraphInCell'),
    applyParaFormatInCell: rec('applyParaFormatInCell'),
  });
  return made;
}

/** 대상 내용·구조·쪽 설정을 바꾸는 엔진 호출(서식 전용 편집이 거부되면 하나도 없어야 한다). */
const MUTATING_CALLS = new Set([
  'insertText',
  'deleteText',
  'splitParagraph',
  'mergeParagraph',
  'insertPageBreak',
  'applyParaFormat',
  'setFieldValue',
  'createHeaderFooter',
  'insertTextInHeaderFooter',
  'deleteTextInHeaderFooter',
  'splitParagraphInHeaderFooter',
  'deleteTextInFootnote',
  'insertTextInFootnote',
  'deleteTextInCell',
  'insertTextInCell',
  'splitParagraphInCell',
  'applyParaFormatInCell',
  'setPageDef',
  'applyHfTemplate',
  'insertFieldInHf',
]);

function mutations(calls: Call[]): string[] {
  return calls.filter((c) => MUTATING_CALLS.has(c.fn)).map((c) => c.fn);
}

function propsOf(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.args[call.args.length - 1]));
}

describe('F-45cee3df AC-bce2505c: 문단 서식을 적용하고 텍스트는 바꾸지 않는다', () => {
  it('para_format 편집이 본문 문단에 applyParaFormat을 호출한다', () => {
    const { wasm, calls } = makeWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'para_format', para_format: { alignment: 'center' } },
      }),
    );

    expect(result.applied).toBeGreaterThan(0);
    expect(calls.some((c) => c.fn === 'applyParaFormat')).toBe(true);
  });

  it('정렬, 줄간격, 들여쓰기, 여백을 JSON props로 인코딩한다(pt×200)', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: {
          type: 'para_format',
          para_format: {
            alignment: 'left',
            line_spacing_percent: 150,
            indent_pt: 10,
            margin_left_pt: 5,
            spacing_before_pt: 6,
            spacing_after_pt: 12,
            keep_with_next: true,
          },
        },
      }),
    );

    const call = calls.find((c) => c.fn === 'applyParaFormat');
    const propsJson = String(call?.args[2]);
    const props = JSON.parse(propsJson);
    expect(props.alignment).toBe('left');
    expect(props.lineSpacingType).toBe('Percent');
    expect(props.lineSpacing).toBe(150);
    expect(props.indent).toBe(2000); // 10pt×200
    expect(props.marginLeft).toBe(1000); // 5pt×200
    expect(props.spacingBefore).toBe(1200); // 6pt×200
    expect(props.spacingAfter).toBe(2400); // 12pt×200
    expect(props.keepWithNext).toBe(true);
  });

  it('텍스트 INSERT_AFTER에 동봉된 para_format을 새 문단들에 적용한다', () => {
    const { wasm, calls } = makeWasm();
    wasm.getParagraphLength = () => 5;
    applyActionScript(
      wasm,
      script({
        command: 'INSERT_AFTER',
        target_id: 'sec[0].p[1]',
        payload: {
          type: 'paragraph',
          text: '새 문단',
          para_format: { alignment: 'right', spacing_after_pt: 10 },
        },
      }),
    );

    const formatCalls = calls.filter((c) => c.fn === 'applyParaFormat');
    expect(formatCalls.length).toBeGreaterThan(0);
    const lastFormatCall = formatCalls[formatCalls.length - 1];
    const props = JSON.parse(String(lastFormatCall.args[2]));
    expect(props.alignment).toBe('right');
    expect(props.spacingAfter).toBe(2000); // 10pt×200
  });
});

describe('F-45cee3df AC-bce2505c: 문단 서식은 텍스트를 건드리지 않고, 최상위 셀 문단에도 적용된다', () => {
  it('type=para_format REPLACE는 본문 문단의 텍스트를 지우거나 다시 쓰지 않는다', () => {
    const { wasm, calls } = makeContentWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'para_format', para_format: { alignment: 'center', line_spacing_percent: 160 } },
      }),
    );

    expect(result.applied).toBe(1);
    expect(mutations(calls)).toEqual(['applyParaFormat']);
    const call = calls.find((c) => c.fn === 'applyParaFormat');
    expect(call?.args.slice(0, 2)).toEqual([0, 1]);
    expect(propsOf(call)).toMatchObject({ alignment: 'center', lineSpacing: 160 });
  });

  it('type=para_format REPLACE는 최상위 표 셀 문단에 applyParaFormatInCell로 적용하고 셀 텍스트는 그대로 둔다', () => {
    const { wasm, calls } = makeContentWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[2].tbl[0].cell[1].p[0]',
        payload: { type: 'para_format', para_format: { alignment: 'right' } },
      }),
    );

    expect(result.applied).toBe(1);
    expect(mutations(calls)).toEqual(['applyParaFormatInCell']);
    const call = calls.find((c) => c.fn === 'applyParaFormatInCell');
    expect(call?.args.slice(0, 5)).toEqual([0, 2, 0, 1, 0]);
    expect(propsOf(call)).toEqual({ alignment: 'right' });
  });

  it('셀 REPLACE에 동봉된 para_format은 값을 채운 그 셀 문단에 적용된다', () => {
    const { wasm, calls } = makeContentWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[2].tbl[0].cell[1].p[0]',
        payload: { text: '새 값', para_format: { alignment: 'right' } },
      }),
    );

    expect(result.applied).toBe(1);
    expect(calls.find((c) => c.fn === 'insertTextInCell')?.args).toEqual([0, 2, 0, 1, 0, 0, '새 값']);
    const call = calls.find((c) => c.fn === 'applyParaFormatInCell');
    expect(call?.args.slice(0, 5)).toEqual([0, 2, 0, 1, 0]);
    expect(propsOf(call)).toEqual({ alignment: 'right' });
  });

  it('셀 INSERT_AFTER에 동봉된 para_format은 새로 생긴 다음 셀 문단(cellParaIndex+1)에 적용된다', () => {
    const { wasm, calls } = makeContentWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'INSERT_AFTER',
        target_id: 'sec[0].p[2].tbl[0].cell[1].p[0]',
        payload: { text: '추가 줄', para_format: { alignment: 'center' } },
      }),
    );

    expect(result.applied).toBe(1);
    // 새 줄은 cp=1에 들어가고, 서식도 원래 문단(cp=0)이 아니라 그 새 문단에 입혀진다.
    expect(calls.find((c) => c.fn === 'insertTextInCell')?.args).toEqual([0, 2, 0, 1, 1, 0, '추가 줄']);
    const formatCalls = calls.filter((c) => c.fn === 'applyParaFormatInCell');
    expect(formatCalls).toHaveLength(1);
    expect(formatCalls[0].args.slice(0, 5)).toEqual([0, 2, 0, 1, 1]);
    expect(propsOf(formatCalls[0])).toEqual({ alignment: 'center' });
  });
});

describe('F-45cee3df AC-1f969f1d: 문단 번호/글머리표 정의를 보장한다', () => {
  it('list.kind="number"면 ensureDefaultNumbering을 호출하고 numberingId를 건다', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'para_format', para_format: { list: { kind: 'number', level: 1 } } },
      }),
    );

    expect(calls.some((c) => c.fn === 'ensureDefaultNumbering')).toBe(true);
    const formatCall = calls.find((c) => c.fn === 'applyParaFormat');
    const props = JSON.parse(String(formatCall?.args[2]));
    expect(props.headType).toBe('Number');
    expect(props.numberingId).toBe(1);
    expect(props.paraLevel).toBe(1);
  });

  it('list.kind="bullet"면 ensureDefaultBullet을 호출하고 bullet_char를 전달한다', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'para_format', para_format: { list: { kind: 'bullet', bullet_char: '◆' } } },
      }),
    );

    expect(calls.some((c) => c.fn === 'ensureDefaultBullet')).toBe(true);
    const formatCall = calls.find((c) => c.fn === 'applyParaFormat');
    const props = JSON.parse(String(formatCall?.args[2]));
    expect(props.headType).toBe('Bullet');
    expect(props.numberingId).toBe(2);
  });

  it('list.kind="none"이면 headType을 None으로 설정해 번호를 해제한다', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'para_format', para_format: { list: { kind: 'none' } } },
      }),
    );

    const formatCall = calls.find((c) => c.fn === 'applyParaFormat');
    const props = JSON.parse(String(formatCall?.args[2]));
    expect(props.headType).toBe('None');
  });

  it('list.kind="outline"이면 headType을 Outline으로 설정한다', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'para_format', para_format: { list: { kind: 'outline', level: 2 } } },
      }),
    );

    const formatCall = calls.find((c) => c.fn === 'applyParaFormat');
    const props = JSON.parse(String(formatCall?.args[2]));
    expect(props.headType).toBe('Outline');
    expect(props.paraLevel).toBe(2);
  });
});

describe('F-45cee3df AC-0cb85336: 모든 구역의 용지 설정을 변경한다', () => {
  it('page_setup이 모든 섹션의 setPageDef를 호출한다', () => {
    const { wasm, calls } = makeWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: DOC_SCOPE_TARGET,
        payload: { type: 'page_setup', page_setup: { paper: 'A4', margins_mm: { top: 20, bottom: 20 } } },
      }),
    );

    expect(result.applied).toBeGreaterThan(0);
    expect(calls.filter((c) => c.fn === 'setPageDef').length).toBeGreaterThan(0);
  });

  it('paper와 margins_mm만 지정된 필드를 변경한다(HWPUNIT로 변환)', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: DOC_SCOPE_TARGET,
        payload: { type: 'page_setup', page_setup: { paper: 'A4', margins_mm: { left: 15 } } },
      }),
    );

    const setPageDefCall = calls.find((c) => c.fn === 'setPageDef');
    const pageDef = setPageDefCall?.args[1] as Record<string, number>;
    const mmToHu = (mm: number) => Math.round((mm * 7200) / 25.4);
    expect(pageDef.width).toBe(mmToHu(210)); // A4 width
    expect(pageDef.height).toBe(mmToHu(297)); // A4 height
    expect(pageDef.marginLeft).toBe(mmToHu(15));
  });

  it('page_setup은 텍스트 없어도 건너뛰지 않는다(text exemption)', () => {
    const { wasm } = makeWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: DOC_SCOPE_TARGET,
        payload: { type: 'page_setup', page_setup: { paper: 'A4' } },
        // 의도적으로 text 필드 없음
      }),
    );

    expect(result.applied).toBeGreaterThan(0);
    expect(result.skipped).toHaveLength(0);
  });
});

describe('F-45cee3df AC-0cb85336: 구역마다 지정한 값만 바꾸고 나머지는 그 구역의 값을 유지한다', () => {
  const BASE: PageDefLike = {
    width: 59535,
    height: 84211,
    marginLeft: 1417,
    marginRight: 1417,
    marginTop: 1417,
    marginBottom: 1417,
    marginHeader: 709,
    marginFooter: 709,
    marginGutter: 0,
    landscape: false,
    binding: 0,
  };
  /** 두 번째 구역은 다른 용지·여백(B4 가로·넓은 위 여백)을 가진 문서. */
  const SECOND: PageDefLike = { ...BASE, width: 72852, height: 103181, marginTop: 2835, marginGutter: 567 };

  function twoSectionWasm() {
    const made = makeWasm();
    made.wasm.getSectionCount = () => 2;
    made.wasm.getPageDef = (sec: number) => ({ ...(sec === 0 ? BASE : SECOND) });
    return made;
  }

  function pageDefsSet(calls: Call[]): Array<[number, PageDefLike]> {
    return calls
      .filter((c) => c.fn === 'setPageDef')
      .map((c) => [c.args[0] as number, c.args[1] as PageDefLike]);
  }

  const mmToHu = (mm: number) => Math.round((mm * 7200) / 25.4);

  it('구역이 둘이면 두 구역 모두 setPageDef를 호출한다', () => {
    const { wasm, calls } = twoSectionWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: DOC_SCOPE_TARGET,
        payload: { type: 'page_setup', page_setup: { paper: 'A3' } },
      }),
    );

    expect(result.applied).toBe(1);
    const sets = pageDefsSet(calls);
    expect(sets.map(([sec]) => sec)).toEqual([0, 1]);
    for (const [, def] of sets) {
      expect(def.width).toBe(mmToHu(297));
      expect(def.height).toBe(mmToHu(420));
    }
  });

  it('orientation=landscape면 모든 구역의 landscape를 켜고 용지 크기는 그대로 둔다', () => {
    const { wasm, calls } = twoSectionWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: DOC_SCOPE_TARGET,
        payload: { type: 'page_setup', page_setup: { orientation: 'landscape' } },
      }),
    );

    const sets = pageDefsSet(calls);
    expect(sets).toHaveLength(2);
    expect(sets[0][1]).toEqual({ ...BASE, landscape: true });
    expect(sets[1][1]).toEqual({ ...SECOND, landscape: true });
  });

  it('좌우 여백만 지정하면 위·아래·머리말·꼬리말 여백과 용지 크기는 각 구역의 기존 값을 유지한다', () => {
    const { wasm, calls } = twoSectionWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: DOC_SCOPE_TARGET,
        payload: { type: 'page_setup', page_setup: { margins_mm: { left: 20, right: 25 } } },
      }),
    );

    const sets = pageDefsSet(calls);
    expect(sets[0][1]).toEqual({ ...BASE, marginLeft: mmToHu(20), marginRight: mmToHu(25) });
    expect(sets[1][1]).toEqual({ ...SECOND, marginLeft: mmToHu(20), marginRight: mmToHu(25) });
  });
});

describe('F-45cee3df AC-b1ddd59b: 자동 쪽 번호를 머리말/꼬리말에 삽입한다', () => {
  it('page_number가 applyHfTemplate을 호출한다', () => {
    const { wasm, calls } = makeWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: DOC_SCOPE_TARGET,
        payload: { type: 'page_number', page_number: { align: 'center' } },
      }),
    );

    expect(result.applied).toBeGreaterThan(0);
    expect(calls.some((c) => c.fn === 'applyHfTemplate')).toBe(true);
  });

  it('align=left/center/right에 따라 templateId를 1/2/3으로 설정한다', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: DOC_SCOPE_TARGET,
        payload: { type: 'page_number', page_number: { align: 'right' } },
      }),
    );

    const templateCall = calls.find((c) => c.fn === 'applyHfTemplate');
    expect(templateCall?.args[3]).toBe(3); // right = templateId 3
  });

  it('format="dash"면 "- "와 " -"를 쪽 번호 앞뒤에 삽입한다', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: DOC_SCOPE_TARGET,
        payload: { type: 'page_number', page_number: { format: 'dash' } },
      }),
    );

    const textCalls = calls.filter((c) => c.fn === 'insertTextInHeaderFooter');
    const insertedTexts = textCalls.map((c) => c.args[5]);
    expect(insertedTexts).toContain('- ');
    expect(insertedTexts).toContain(' -');
  });

  it('format="total"면 총 쪽수 필드(fieldType=2)를 insertFieldInHf로 삽입한다', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: DOC_SCOPE_TARGET,
        payload: { type: 'page_number', page_number: { format: 'total' } },
      }),
    );

    const fieldCall = calls.find((c) => c.fn === 'insertFieldInHf');
    expect(fieldCall?.args[5]).toBe(2); // fieldType = 총 쪽수
  });

  it('page_number는 텍스트 없어도 건너뛰지 않는다(text exemption)', () => {
    const { wasm } = makeWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: DOC_SCOPE_TARGET,
        payload: { type: 'page_number', page_number: { align: 'center' } },
        // 의도적으로 text 필드 없음
      }),
    );

    expect(result.applied).toBeGreaterThan(0);
    expect(result.skipped).toHaveLength(0);
  });
});

describe('F-45cee3df AC-9fb77b9d: 글꼴, 형광펜, 위/아래 첨자를 적용한다', () => {
  it('char_format.font_family가 findOrCreateFontId를 호출하고 fontId를 props에 담는다', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'format', char_format: { font_family: 'Arial' }, format_target: 'target' },
      }),
    );

    expect(calls.some((c) => c.fn === 'findOrCreateFontId')).toBe(true);
    const formatCall = calls.find((c) => c.fn === 'applyCharFormat');
    const props = JSON.parse(String(formatCall?.args[4]));
    expect(props.fontId).toBe(42);
  });

  it('char_format.highlight_color가 shadeColor로 전달된다', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'format', char_format: { highlight_color: '#FFFF00' }, format_target: 'target' },
      }),
    );

    const formatCall = calls.find((c) => c.fn === 'applyCharFormat');
    const props = JSON.parse(String(formatCall?.args[4]));
    expect(props.shadeColor).toBe('#FFFF00');
  });

  it('superscript/subscript를 그대로 전달한다', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'format', char_format: { superscript: true }, format_target: 'target' },
      }),
    );

    const formatCall = calls.find((c) => c.fn === 'applyCharFormat');
    const props = JSON.parse(String(formatCall?.args[4]));
    expect(props.superscript).toBe(true);
  });

  it('font_size_pt를 100배 곱해 fontSize로 변환한다(HWPUNIT)', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'format', char_format: { font_size_pt: 14.5 }, format_target: 'target' },
      }),
    );

    const formatCall = calls.find((c) => c.fn === 'applyCharFormat');
    const props = JSON.parse(String(formatCall?.args[4]));
    expect(props.fontSize).toBe(1450); // 14.5pt * 100
  });
});

describe('F-45cee3df: target_id="doc"는 페이지 서식 편집만 허용한다', () => {
  it('target_id="doc"이고 para_format이 아닌 payload는 거부된다', () => {
    const { wasm } = makeWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: DOC_SCOPE_TARGET,
        payload: { type: 'paragraph', text: 'should fail' },
      }),
    );

    expect(result.applied).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('찾아 바꾸기·쪽 설정·쪽 번호');
  });

  it('para_format은 본문 문단에만 적용 — target_id="doc"이면 거부된다', () => {
    const { wasm } = makeWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: DOC_SCOPE_TARGET,
        payload: { type: 'para_format', para_format: { alignment: 'center' } },
      }),
    );

    expect(result.applied).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('doc');
  });
});

describe('F-45cee3df: 포맷 편집은 텍스트 없어도 허용된다(text exemption)', () => {
  it('para_format 편집에는 text 필드가 필수 아니다', () => {
    const { wasm } = makeWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'para_format', para_format: { alignment: 'center' } },
        // text 필드 생략
      }),
    );

    expect(result.applied).toBeGreaterThan(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('char_format 편집도 text 필드가 필수 아니다', () => {
    const { wasm } = makeWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'format', char_format: { bold: true }, format_target: 'target' },
        // text 필드 생략
      }),
    );

    expect(result.applied).toBeGreaterThan(0);
    expect(result.skipped).toHaveLength(0);
  });
});

describe('F-45cee3df AC-5408079a: 서식 전용 편집이 허용되지 않은 대상을 겨누면 지우지 않고 건너뛴다', () => {
  it.each<{ label: string; edit: Edit; reason: string }>([
    {
      label: 'page_setup을 본문 문단 ID에',
      edit: {
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'page_setup', page_setup: { orientation: 'landscape' } },
      },
      reason: '쪽 설정·쪽 번호는 target_id="doc"',
    },
    {
      label: 'page_number를 본문 문단 ID에',
      edit: {
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'page_number', page_number: { align: 'center' } },
      },
      reason: '쪽 설정·쪽 번호는 target_id="doc"',
    },
    {
      label: 'page_number를 꼬리말 ID에',
      edit: {
        command: 'REPLACE',
        target_id: 'sec[0].footer[0].p[0]',
        payload: { type: 'page_number', page_number: { align: 'right' } },
      },
      reason: '쪽 설정·쪽 번호는 target_id="doc"',
    },
    {
      label: 'para_format을 누름틀 ID에',
      edit: {
        command: 'REPLACE',
        target_id: 'field[3:성명]',
        payload: { type: 'para_format', para_format: { alignment: 'center' } },
      },
      reason: '문단 서식(para_format)은 command=REPLACE로 본문 문단이나 표 셀 문단에만',
    },
    {
      label: 'para_format을 머리말 ID에',
      edit: {
        command: 'REPLACE',
        target_id: 'sec[0].header[0].p[0]',
        payload: { type: 'para_format', para_format: { alignment: 'center' } },
      },
      reason: '문단 서식(para_format)은 command=REPLACE로 본문 문단이나 표 셀 문단에만',
    },
    {
      label: 'para_format을 각주 ID에',
      edit: {
        command: 'REPLACE',
        target_id: 'sec[0].p[2].fn[0].p[0]',
        payload: { type: 'para_format', para_format: { alignment: 'center' } },
      },
      reason: '문단 서식(para_format)은 command=REPLACE로 본문 문단이나 표 셀 문단에만',
    },
    {
      label: 'para_format을 INSERT_AFTER로(텍스트 동봉)',
      edit: {
        command: 'INSERT_AFTER',
        target_id: 'sec[0].p[1]',
        payload: { type: 'para_format', text: '새 문단', para_format: { alignment: 'center' } },
      },
      reason: '문단 서식(para_format)은 command=REPLACE로 본문 문단이나 표 셀 문단에만',
    },
    {
      label: 'para_format을 INSERT_AFTER로(텍스트 없음)',
      edit: {
        command: 'INSERT_AFTER',
        target_id: 'sec[0].p[1]',
        payload: { type: 'para_format', para_format: { alignment: 'center' } },
      },
      // 빈 텍스트 검사가 아니라 문단 서식 대상 검사가 정확한 사유로 거른다.
      reason: 'command=REPLACE',
    },
    {
      label: 'para_format을 중첩 표 셀 ID에',
      edit: {
        command: 'REPLACE',
        target_id: 'sec[0].p[2].tbl[0].cell[1].p[0].tbl[0].cell[0].p[0]',
        payload: { type: 'para_format', para_format: { alignment: 'center' } },
      },
      reason: '최상위 표 셀',
    },
  ])('$label 보내면 적용하지 않고 사유와 함께 건너뛴다(대상 내용 보존)', ({ edit, reason }) => {
    const { wasm, calls } = makeContentWasm();
    const result = applyActionScript(wasm, script(edit));

    expect(result.applied).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].targetId).toBe(edit.target_id);
    expect(result.skipped[0].reason).toContain(reason);
    // 빈 텍스트로 REPLACE·누름틀 비우기·머리말/각주 지우기·분할이 하나도 일어나지 않는다.
    expect(mutations(calls)).toEqual([]);
  });

  it('잘못 겨눈 서식 편집은 같은 응답의 다른 정상 편집을 막지 않는다', () => {
    const { wasm, calls } = makeContentWasm();
    const result = applyActionScript(
      wasm,
      script(
        {
          command: 'REPLACE',
          target_id: 'sec[0].p[1]',
          payload: { type: 'page_setup', page_setup: { paper: 'A4' } },
        },
        {
          command: 'REPLACE',
          target_id: DOC_SCOPE_TARGET,
          payload: { type: 'page_setup', page_setup: { paper: 'A4' } },
        },
      ),
    );

    expect(result.applied).toBe(1);
    expect(result.skipped.map((s) => s.targetId)).toEqual(['sec[0].p[1]']);
    expect(calls.some((c) => c.fn === 'deleteText')).toBe(false);
    expect(calls.filter((c) => c.fn === 'setPageDef')).toHaveLength(1);
  });
});

/**
 * F-a7b2c7ba AC-17ba1d6f — 번호·글머리표·개요 수준이 1 이상이고 margin_left_pt를 따로 주지
 * 않으면, 수준마다 왼쪽 여백(수준×15pt = 수준×3000 저장 단위)을 둬 하위 항목이 들여써진다.
 */
describe('F-a7b2c7ba AC-17ba1d6f: 목록 수준별 왼쪽 여백(수준×15pt)', () => {
  /** 15pt × 200(저장 단위/pt). */
  const LEVEL_INDENT = 15 * 200;

  it('AC-17ba1d6f: 번호(number) 수준 1·2는 왼쪽 여백 3000·6000을 낸다', () => {
    const { wasm } = makeWasm();
    expect(paraFormatProps(wasm, { list: { kind: 'number', level: 1 } })).toEqual({
      marginLeft: 1 * LEVEL_INDENT,
      headType: 'Number',
      numberingId: 1,
      paraLevel: 1,
    });
    expect(paraFormatProps(wasm, { list: { kind: 'number', level: 2 } }).marginLeft).toBe(6000);
  });

  it('AC-17ba1d6f: 글머리표(bullet) 수준 2는 왼쪽 여백 6000을 낸다', () => {
    const { wasm } = makeWasm();
    const props = paraFormatProps(wasm, { list: { kind: 'bullet', level: 2, bullet_char: '-' } });
    expect(props).toEqual({ marginLeft: 6000, headType: 'Bullet', numberingId: 2, paraLevel: 2 });
  });

  it('AC-17ba1d6f: 개요(outline) 수준 3은 왼쪽 여백 9000을 낸다', () => {
    const { wasm } = makeWasm();
    expect(paraFormatProps(wasm, { list: { kind: 'outline', level: 3 } })).toEqual({
      marginLeft: 9000,
      headType: 'Outline',
      paraLevel: 3,
    });
  });

  it('AC-17ba1d6f: 하위 수준일수록 더 들여써진다(수준 0 < 1 < 2 < 3)', () => {
    const { wasm } = makeWasm();
    const margin = (level: number) =>
      (paraFormatProps(wasm, { list: { kind: 'number', level } }).marginLeft as number | undefined) ?? 0;
    expect([0, 1, 2, 3].map(margin)).toEqual([0, 3000, 6000, 9000]);
  });

  it('AC-17ba1d6f: 수준 0(또는 수준 생략)은 왼쪽 여백을 정하지 않는다', () => {
    const { wasm } = makeWasm();
    for (const kind of ['number', 'bullet', 'outline'] as const) {
      expect(paraFormatProps(wasm, { list: { kind, level: 0 } })).not.toHaveProperty('marginLeft');
      expect(paraFormatProps(wasm, { list: { kind } })).not.toHaveProperty('marginLeft');
    }
  });

  it("AC-17ba1d6f: 번호 해제(kind 'none')는 수준이 있어도 왼쪽 여백을 정하지 않는다", () => {
    const { wasm } = makeWasm();
    expect(paraFormatProps(wasm, { list: { kind: 'none', level: 2 } })).toEqual({ headType: 'None' });
  });

  it('AC-17ba1d6f: margin_left_pt를 직접 주면 그 값이 수준 여백보다 우선한다(0pt 포함)', () => {
    const { wasm } = makeWasm();
    expect(paraFormatProps(wasm, { margin_left_pt: 7, list: { kind: 'number', level: 2 } }).marginLeft).toBe(1400);
    expect(paraFormatProps(wasm, { margin_left_pt: 0, list: { kind: 'bullet', level: 3 } }).marginLeft).toBe(0);
  });

  it('AC-17ba1d6f: para_format 편집이면 applyParaFormat으로 보내는 JSON에 수준 여백이 담긴다', () => {
    const { wasm, calls } = makeWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[1]',
        payload: { type: 'para_format', para_format: { list: { kind: 'number', level: 1 } } },
      }),
    );

    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([]);
    const formatCalls = calls.filter((c) => c.fn === 'applyParaFormat');
    expect(formatCalls).toHaveLength(1);
    expect(formatCalls[0].args.slice(0, 2)).toEqual([0, 1]);
    expect(propsOf(formatCalls[0])).toEqual({ marginLeft: 3000, headType: 'Number', numberingId: 1, paraLevel: 1 });
  });

  it('AC-17ba1d6f: 새 문단 INSERT에 동봉된 글머리표 수준 2도 그 새 문단에 여백 6000으로 적용된다', () => {
    const { wasm, calls } = makeWasm();
    wasm.getParagraphLength = () => 4;
    const result = applyActionScript(
      wasm,
      script({
        command: 'INSERT_AFTER',
        target_id: 'sec[0].p[1]',
        payload: { type: 'paragraph', text: '하위 항목', para_format: { list: { kind: 'bullet', level: 2 } } },
      }),
    );

    expect(result.applied).toBe(1);
    const listCalls = calls.filter((c) => c.fn === 'applyParaFormat' && propsOf(c).headType === 'Bullet');
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].args.slice(0, 2)).toEqual([0, 2]); // 새 문단 = 앵커(1) 다음
    expect(propsOf(listCalls[0]).marginLeft).toBe(6000);
  });

  it('AC-17ba1d6f: 표 셀 문단의 개요 수준 1도 applyParaFormatInCell JSON에 여백 3000이 담긴다', () => {
    const { wasm, calls } = makeContentWasm();
    const result = applyActionScript(
      wasm,
      script({
        command: 'REPLACE',
        target_id: 'sec[0].p[2].tbl[0].cell[1].p[0]',
        payload: { type: 'para_format', para_format: { list: { kind: 'outline', level: 1 } } },
      }),
    );

    expect(result.applied).toBe(1);
    const call = calls.find((c) => c.fn === 'applyParaFormatInCell');
    expect(propsOf(call)).toEqual({ marginLeft: 3000, headType: 'Outline', paraLevel: 1 });
  });
});
