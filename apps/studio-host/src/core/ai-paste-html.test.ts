/**
 * F-4f6d826e AI HTML 붙여넣기 — payload.type="paste_html" 적합성 테스트.
 *
 * 웹/워드 내용이 순수 텍스트로만 들어오던 것을 서식 유지 반입으로 바꾼 기능.
 * 검증 대상은 명령별 삽입 위치, 늘어난 문단 수 계산, 셀 지원 범위, 거부 사유다.
 */
import { describe, it, expect } from 'vitest';
import { applyActionScript, type WasmEditing } from './ai-apply';
import type { ActionScript, Edit } from './ai-bridge';

interface Call {
  fn: string;
  args: unknown[];
}

const BODY_ID = 'sec[0].p[3]';
const CELL_ID = 'sec[0].p[6].tbl[0].cell[2].p[0]';
const HTML = '<p><b>제목</b></p><ul><li>항목 1</li><li>항목 2</li></ul>';

function makeWasm(
  opts: { paraCounts?: number[]; omit?: string[] } = {},
): { wasm: WasmEditing; calls: Call[] } {
  const calls: Call[] = [];
  const omit = new Set(opts.omit ?? []);
  // getParagraphCount는 호출 순서대로 이 값을 돌려준다(붙여넣기 전/후).
  const counts = [...(opts.paraCounts ?? [10, 13])];
  const wasm: Record<string, unknown> = {
    getParagraphLength: () => 12,
    insertText: (...args: unknown[]) => {
      calls.push({ fn: 'insertText', args });
      return '';
    },
    deleteText: (...args: unknown[]) => {
      calls.push({ fn: 'deleteText', args });
      return '';
    },
    splitParagraph: (...args: unknown[]) => {
      calls.push({ fn: 'splitParagraph', args });
      return '';
    },
    mergeParagraph: () => '',
    insertPageBreak: (...args: unknown[]) => {
      calls.push({ fn: 'insertPageBreak', args });
      return '';
    },
    applyParaFormat: () => '',
    applyStyle: () => '',
    getStyleList: () => '[]',
    getCellParagraphLength: () => 4,
    deleteTextInCell: (...args: unknown[]) => {
      calls.push({ fn: 'deleteTextInCell', args });
      return '';
    },
    insertTextInCell: (...args: unknown[]) => {
      calls.push({ fn: 'insertTextInCell', args });
      return '';
    },
    splitParagraphInCell: (...args: unknown[]) => {
      calls.push({ fn: 'splitParagraphInCell', args });
      return '';
    },
  };
  if (!omit.has('pasteHtml')) {
    wasm.pasteHtml = (...args: unknown[]) => {
      calls.push({ fn: 'pasteHtml', args });
      return '{"ok":true}';
    };
  }
  if (!omit.has('pasteHtmlInCell')) {
    wasm.pasteHtmlInCell = (...args: unknown[]) => {
      calls.push({ fn: 'pasteHtmlInCell', args });
      return '{"ok":true}';
    };
  }
  if (!omit.has('getParagraphCount')) {
    wasm.getParagraphCount = () => (counts.length > 1 ? counts.shift()! : counts[0]);
  }
  return { wasm: wasm as unknown as WasmEditing, calls };
}

const pasteEdit = (
  command: string,
  targetId: string,
  html: string = HTML,
  extra: Record<string, unknown> = {},
): Edit =>
  ({
    command,
    target_id: targetId,
    payload: { type: 'paste_html', paste_html: { html }, ...extra },
  }) as unknown as Edit;

const script = (...edits: Edit[]): ActionScript => ({ edits });

describe('F-4f6d826e AC-001 — 명령별 붙여넣기 위치', () => {
  it('REPLACE는 문단 내용을 비우고 그 자리에 붙여넣는다', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(wasm, script(pasteEdit('REPLACE', BODY_ID)));

    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(calls.find((c) => c.fn === 'deleteText')?.args).toEqual([0, 3, 0, 12]);
    // (sec, para, charOffset, html) — 비운 문단의 0 오프셋에 붙인다.
    expect(calls.find((c) => c.fn === 'pasteHtml')?.args).toEqual([0, 3, 0, HTML]);
    // 서식 있는 반입이므로 평문 삽입 경로를 타지 않는다.
    expect(calls.some((c) => c.fn === 'insertText')).toBe(false);
  });

  it('INSERT_AFTER는 문단을 끝에서 쪼개 새 문단에 붙여넣는다', () => {
    const { wasm, calls } = makeWasm();

    applyActionScript(wasm, script(pasteEdit('INSERT_AFTER', BODY_ID)));

    expect(calls.find((c) => c.fn === 'splitParagraph')?.args).toEqual([0, 3, 12]);
    expect(calls.find((c) => c.fn === 'pasteHtml')?.args).toEqual([0, 4, 0, HTML]);
  });

  it('INSERT_BEFORE는 앞에 빈 문단을 만들어 거기에 붙여넣는다', () => {
    const { wasm, calls } = makeWasm();

    applyActionScript(wasm, script(pasteEdit('INSERT_BEFORE', BODY_ID)));

    expect(calls.find((c) => c.fn === 'splitParagraph')?.args).toEqual([0, 3, 0]);
    expect(calls.find((c) => c.fn === 'pasteHtml')?.args).toEqual([0, 3, 0, HTML]);
  });

  it('page_break가 참이면 붙여넣은 문단을 새 페이지에서 시작한다', () => {
    const { wasm, calls } = makeWasm();
    applyActionScript(wasm, script(pasteEdit('INSERT_AFTER', BODY_ID, HTML, { page_break: true })));
    expect(calls.find((c) => c.fn === 'insertPageBreak')?.args).toEqual([0, 4, 0]);
  });
});

describe('F-4f6d826e AC-002 — 늘어난 문단 수를 재서 보정한다', () => {
  it('붙여넣기 전후 문단 수 차이만큼 새 문단을 changed로 보고한다', () => {
    // 10 → 13: 붙여넣기로 3개 늘었다(원래 자리 1 + 추가 2).
    const { wasm } = makeWasm({ paraCounts: [10, 13] });

    const result = applyActionScript(wasm, script(pasteEdit('INSERT_AFTER', BODY_ID)));

    expect(result.changed).toEqual([
      { sec: 0, para: 4 },
      { sec: 0, para: 5 },
      { sec: 0, para: 6 },
      { sec: 0, para: 7 },
    ]);
  });

  it('문단 수 측정 API가 없어도 붙여넣기는 수행된다(diff 표시만 덜 정확)', () => {
    const { wasm, calls } = makeWasm({ omit: ['getParagraphCount'] });

    const result = applyActionScript(wasm, script(pasteEdit('INSERT_AFTER', BODY_ID)));

    expect(result.applied).toBe(1);
    expect(calls.some((c) => c.fn === 'pasteHtml')).toBe(true);
    expect(result.changed).toEqual([{ sec: 0, para: 4 }]);
  });

  it('문단 수가 줄어든 것으로 나와도 음수로 보정하지 않는다', () => {
    const { wasm } = makeWasm({ paraCounts: [10, 8] });

    const result = applyActionScript(wasm, script(pasteEdit('INSERT_AFTER', BODY_ID)));

    expect(result.applied).toBe(1);
    expect(result.changed).toEqual([{ sec: 0, para: 4 }]);
  });
});

describe('F-4f6d826e AC-003 — 표 셀 붙여넣기', () => {
  it('최상위 표 셀에 REPLACE하면 셀을 비우고 pasteHtmlInCell로 넣는다', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(wasm, script(pasteEdit('REPLACE', CELL_ID)));

    expect(result.applied).toBe(1);
    expect(calls.some((c) => c.fn === 'deleteTextInCell')).toBe(true);
    // (sec, parentPara, controlIdx, cellIdx, cellParaIdx, charOffset, html)
    expect(calls.find((c) => c.fn === 'pasteHtmlInCell')?.args).toEqual([0, 6, 0, 2, 0, 0, HTML]);
    expect(calls.some((c) => c.fn === 'insertTextInCell')).toBe(false);
  });

  it('셀 INSERT_AFTER는 셀 문단을 쪼개고 다음 문단에 넣는다', () => {
    const { wasm, calls } = makeWasm();

    applyActionScript(wasm, script(pasteEdit('INSERT_AFTER', CELL_ID)));

    expect(calls.find((c) => c.fn === 'splitParagraphInCell')?.args).toEqual([0, 6, 0, 2, 0, 4]);
    expect(calls.find((c) => c.fn === 'pasteHtmlInCell')?.args[4]).toBe(1);
  });

  it('중첩 표 셀은 거부한다(by-path HTML API 없음)', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(
      wasm,
      script(pasteEdit('REPLACE', 'sec[0].p[0].tbl[2].cell[0].p[4].tbl[0].cell[11].p[0]')),
    );

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn.startsWith('paste'))).toBe(false);
    expect(result.skipped[0].reason).toContain('중첩 표 셀');
  });
});

describe('F-4f6d826e AC-004 — 빈 HTML·미지원 환경은 조용히 넘기지 않는다', () => {
  it('html이 비면 문서를 바꾸지 않고 사유를 보고한다', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(wasm, script(pasteEdit('REPLACE', BODY_ID, '   ')));

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn === 'pasteHtml')).toBe(false);
    expect(result.skipped[0].reason).toContain('비어 있습니다');
  });

  it('붙여넣기 API가 없는 환경이면 사유를 보고한다', () => {
    const { wasm } = makeWasm({ omit: ['pasteHtml'] });

    const result = applyActionScript(wasm, script(pasteEdit('INSERT_AFTER', BODY_ID)));

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('지원하지 않습니다');
  });

  it('셀 붙여넣기 API가 없는 환경이면 사유를 보고한다', () => {
    const { wasm } = makeWasm({ omit: ['pasteHtmlInCell'] });

    const result = applyActionScript(wasm, script(pasteEdit('REPLACE', CELL_ID)));

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('지원하지 않습니다');
  });
});
