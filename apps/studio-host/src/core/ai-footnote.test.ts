/**
 * F-3e2d0f9a AI 각주 달기/떼기 — payload.type="footnote" 적합성 테스트.
 *
 * F-191fd6은 '기존 각주의 내용 수정'만 가능했다. 여기서 검증하는 것은 각주를 새로
 * 달고 떼는 경로, 그리고 payload.type 유무로 기존 동작과 갈리는 하위 호환이다.
 */
import { describe, it, expect } from 'vitest';
import { applyActionScript, type WasmEditing } from './ai-apply';
import type { ActionScript, Edit } from './ai-bridge';

interface Call {
  fn: string;
  args: unknown[];
}

const BODY_ID = 'sec[0].p[4]';
const FN_ID = 'sec[0].p[4].fn[1].p[0]';
const PARA_TEXT = '연구 결과는 유의미했다. 후속 연구가 필요하다.';

function makeWasm(
  opts: {
    text?: string;
    insertOk?: boolean;
    deleteOk?: boolean;
    omit?: string[];
    fnTexts?: string[];
  } = {},
): { wasm: WasmEditing; calls: Call[] } {
  const calls: Call[] = [];
  const omit = new Set(opts.omit ?? []);
  const text = opts.text ?? PARA_TEXT;
  const wasm: Record<string, unknown> = {
    getParagraphLength: () => Array.from(text).length,
    insertText: (...args: unknown[]) => {
      calls.push({ fn: 'insertText', args });
      return '';
    },
    deleteText: (...args: unknown[]) => {
      calls.push({ fn: 'deleteText', args });
      return '';
    },
    splitParagraph: () => '',
    mergeParagraph: () => '',
    insertPageBreak: () => '',
    getFootnoteInfo: () => ({
      ok: true,
      paraCount: 1,
      totalTextLen: 5,
      number: 1,
      texts: opts.fnTexts ?? ['기존 각주 '],
    }),
    insertTextInFootnote: (...args: unknown[]) => {
      calls.push({ fn: 'insertTextInFootnote', args });
      return { ok: true, charOffset: 0 };
    },
    deleteTextInFootnote: (...args: unknown[]) => {
      calls.push({ fn: 'deleteTextInFootnote', args });
      return { ok: true, charOffset: 0 };
    },
  };
  if (!omit.has('getTextRange')) {
    wasm.getTextRange = (_s: number, _p: number, from: number, to: number) =>
      Array.from(text).slice(from, to).join('');
  }
  if (!omit.has('insertFootnote')) {
    wasm.insertFootnote = (...args: unknown[]) => {
      calls.push({ fn: 'insertFootnote', args });
      return {
        ok: opts.insertOk ?? true,
        paraIdx: 4,
        controlIdx: 2,
        footnoteNumber: 1,
      };
    };
  }
  if (!omit.has('deleteFootnote')) {
    wasm.deleteFootnote = (...args: unknown[]) => {
      calls.push({ fn: 'deleteFootnote', args });
      return { ok: opts.deleteOk ?? true, deletedNumber: 1 };
    };
  }
  return { wasm: wasm as unknown as WasmEditing, calls };
}

const addFootnote = (footnote: Record<string, unknown>, targetId = BODY_ID): Edit =>
  ({
    command: 'REPLACE',
    target_id: targetId,
    payload: { type: 'footnote', footnote },
  }) as unknown as Edit;

const script = (...edits: Edit[]): ActionScript => ({ edits });

describe('F-3e2d0f9a AC-001 — 본문 문단에 각주를 새로 단다', () => {
  it('insertFootnote 후 그 각주에 내용을 넣는다', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(wasm, script(addFootnote({ text: '한국연구재단(2026)' })));

    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([]);
    // anchor_text 없으면 문단 끝(= 문단 길이)에 표식을 단다.
    expect(calls.find((c) => c.fn === 'insertFootnote')?.args).toEqual([
      0,
      4,
      Array.from(PARA_TEXT).length,
    ]);
    // insertFootnote가 돌려준 (paraIdx, controlIdx)로 내용을 채운다.
    expect(calls.find((c) => c.fn === 'insertTextInFootnote')?.args).toEqual([
      0, 4, 2, 0, 0, '한국연구재단(2026)',
    ]);
  });

  it('문단 본문은 바뀌지 않는다(본문 텍스트 API를 부르지 않음)', () => {
    const { wasm, calls } = makeWasm();

    applyActionScript(wasm, script(addFootnote({ text: '출처' })));

    expect(calls.some((c) => c.fn === 'insertText')).toBe(false);
    expect(calls.some((c) => c.fn === 'deleteText')).toBe(false);
  });

  it('각주를 단 문단을 changed로 보고한다', () => {
    const { wasm } = makeWasm();
    const result = applyActionScript(wasm, script(addFootnote({ text: '출처' })));
    expect(result.changed).toEqual([{ sec: 0, para: 4 }]);
  });
});

describe('F-3e2d0f9a AC-002 — anchor_text로 표식 위치 지정', () => {
  it('그 문자열 바로 뒤 오프셋에 각주를 단다', () => {
    const { wasm, calls } = makeWasm();

    applyActionScript(
      wasm,
      script(addFootnote({ text: '출처 있음', anchor_text: '유의미했다' })),
    );

    const expected = Array.from(PARA_TEXT).indexOf('유') + Array.from('유의미했다').length;
    expect(calls.find((c) => c.fn === 'insertFootnote')?.args[2]).toBe(expected);
  });

  it('anchor_text가 문단에 없으면 적용하지 않고 사유를 보고한다', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(
      wasm,
      script(addFootnote({ text: '출처', anchor_text: '없는문구' })),
    );

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn === 'insertFootnote')).toBe(false);
    expect(result.skipped[0].reason).toContain('찾지 못했습니다');
  });

  it('anchor_text가 여러 번 나오면 모호하므로 적용하지 않는다', () => {
    const { wasm, calls } = makeWasm({ text: '연구 결과. 연구 결과.' });

    const result = applyActionScript(
      wasm,
      script(addFootnote({ text: '출처', anchor_text: '연구 결과' })),
    );

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn === 'insertFootnote')).toBe(false);
    expect(result.skipped[0].reason).toContain('여러 번');
  });
});

describe('F-3e2d0f9a AC-003 — 각주 떼기와 기존 내용 수정의 구분', () => {
  it('각주 ID + DELETE + type="footnote" → 각주 자체를 뗀다', () => {
    const { wasm, calls } = makeWasm();
    const del = {
      command: 'DELETE',
      target_id: FN_ID,
      payload: { type: 'footnote' },
    } as unknown as Edit;

    const result = applyActionScript(wasm, script(del));

    expect(result.applied).toBe(1);
    expect(calls.find((c) => c.fn === 'deleteFootnote')?.args).toEqual([0, 4, 1]);
    // 내용만 비우는 기존 경로를 타면 안 된다.
    expect(calls.some((c) => c.fn === 'deleteTextInFootnote')).toBe(false);
  });

  it('payload.type이 없는 DELETE는 기존대로 내용만 비운다(F-191fd6 하위 호환)', () => {
    const { wasm, calls } = makeWasm();
    const clear = { command: 'DELETE', target_id: FN_ID, payload: {} } as unknown as Edit;

    const result = applyActionScript(wasm, script(clear));

    expect(result.applied).toBe(1);
    expect(calls.some((c) => c.fn === 'deleteFootnote')).toBe(false);
    expect(calls.some((c) => c.fn === 'deleteTextInFootnote')).toBe(true);
  });

  it('payload.type이 없는 REPLACE는 기존대로 내용을 교체한다', () => {
    const { wasm, calls } = makeWasm();
    const edit = {
      command: 'REPLACE',
      target_id: FN_ID,
      payload: { text: '새 각주 내용' },
    } as unknown as Edit;

    const result = applyActionScript(wasm, script(edit));

    expect(result.applied).toBe(1);
    expect(calls.some((c) => c.fn === 'deleteFootnote')).toBe(false);
    expect(calls.find((c) => c.fn === 'insertTextInFootnote')?.args[5]).toBe('새 각주 내용');
  });

  it('각주 ID에 type="footnote" + REPLACE는 거부한다(의도 모호)', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(wasm, script(addFootnote({ text: 'x' }, FN_ID)));

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn === 'deleteFootnote')).toBe(false);
    expect(result.skipped[0].reason).toContain('각주 떼기(DELETE)만');
  });
});

describe('F-3e2d0f9a AC-004 — 잘못된 입력·엔진 거부는 조용히 넘기지 않는다', () => {
  it('각주 내용이 비면 각주를 만들지 않는다', () => {
    const { wasm, calls } = makeWasm();

    const result = applyActionScript(wasm, script(addFootnote({ text: '   ' })));

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn === 'insertFootnote')).toBe(false);
    expect(result.skipped[0].reason).toContain('비어 있습니다');
  });

  it('엔진이 각주 생성을 거부하면 사유를 보고한다', () => {
    const { wasm } = makeWasm({ insertOk: false });

    const result = applyActionScript(wasm, script(addFootnote({ text: '출처' })));

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('달지 못했습니다');
  });

  it('엔진이 각주 제거를 거부하면 사유를 보고한다', () => {
    const { wasm } = makeWasm({ deleteOk: false });
    const del = {
      command: 'DELETE',
      target_id: FN_ID,
      payload: { type: 'footnote' },
    } as unknown as Edit;

    const result = applyActionScript(wasm, script(del));

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('떼지 못했습니다');
  });

  it('각주 API가 없는 환경이면 사유를 보고한다', () => {
    const { wasm } = makeWasm({ omit: ['insertFootnote'] });

    const result = applyActionScript(wasm, script(addFootnote({ text: '출처' })));

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('지원하지 않습니다');
  });

  it('본문 문단에 REPLACE가 아닌 명령으로 각주를 달려 하면 거부한다', () => {
    const { wasm, calls } = makeWasm();
    const bad = {
      command: 'INSERT_AFTER',
      target_id: BODY_ID,
      payload: { type: 'footnote', footnote: { text: '출처' } },
    } as unknown as Edit;

    const result = applyActionScript(wasm, script(bad));

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn === 'insertFootnote')).toBe(false);
    expect(result.skipped[0].reason).toContain('command=REPLACE');
  });
});
