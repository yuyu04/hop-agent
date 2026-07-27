/**
 * F-293e8c99 AI 찾아 바꾸기 — 문서 전역 치환 적합성 테스트.
 *
 * AC마다 하나씩. WasmEditing은 호출만 기록하는 목이고, 검증 대상은 "AI가 낸 편집이
 * 어떤 엔진 호출로 번역되는가 / 무엇이 skipped로 보고되는가"다.
 */
import { describe, it, expect } from 'vitest';
import { applyActionScript, type WasmEditing } from './ai-apply';
import { DOC_SCOPE_TARGET, type ActionScript, type Edit } from './ai-bridge';

interface Call {
  fn: string;
  args: unknown[];
}

/** applyActionScript가 요구하는 표면을 채우는 최소 목. 필요한 것만 실제로 동작한다. */
function makeWasm(opts: {
  replaceAllCount?: number;
  replaceAllOk?: boolean;
  replaceOne?: { ok: boolean; sec?: number; para?: number };
  hits?: Array<{ sec: number; para: number; charOffset: number; length: number; cellContext?: unknown }>;
  searchThrows?: boolean;
  omitReplaceApis?: boolean;
}): { wasm: WasmEditing; calls: Call[] } {
  const calls: Call[] = [];
  const rec = (fn: string) => (...args: unknown[]): never | string => {
    calls.push({ fn, args });
    return '';
  };
  const base = {
    getParagraphLength: () => 0,
    insertText: rec('insertText'),
    deleteText: rec('deleteText'),
    splitParagraph: rec('splitParagraph'),
    mergeParagraph: rec('mergeParagraph'),
    insertPageBreak: rec('insertPageBreak'),
  } as unknown as WasmEditing;

  const wasm = base as unknown as Record<string, unknown>;
  if (!opts.omitReplaceApis) {
    wasm.replaceAll = (query: string, newText: string, caseSensitive: boolean) => {
      calls.push({ fn: 'replaceAll', args: [query, newText, caseSensitive] });
      return { ok: opts.replaceAllOk ?? true, count: opts.replaceAllCount ?? 3 };
    };
    wasm.replaceOne = (query: string, newText: string, caseSensitive: boolean) => {
      calls.push({ fn: 'replaceOne', args: [query, newText, caseSensitive] });
      return opts.replaceOne ?? { ok: true, sec: 0, para: 2 };
    };
    wasm.searchAllText = (query: string, caseSensitive: boolean, includeCells?: boolean) => {
      calls.push({ fn: 'searchAllText', args: [query, caseSensitive, includeCells] });
      if (opts.searchThrows) throw new Error('search failed');
      return opts.hits ?? [];
    };
  }
  return { wasm: base, calls };
}

const replaceEdit = (
  replace_text: Record<string, unknown>,
  targetId: string = DOC_SCOPE_TARGET,
): Edit =>
  ({
    command: 'REPLACE',
    target_id: targetId,
    payload: { type: 'replace_text', replace_text },
  }) as unknown as Edit;

const script = (...edits: Edit[]): ActionScript => ({ edits });

describe('F-293e8c99 AC-001 — 전역 치환을 엔진 프리미티브 한 번으로', () => {
  it('replace_text 편집 하나가 replaceAll 호출 한 번이 된다(표 셀 포함 검색)', () => {
    const { wasm, calls } = makeWasm({
      replaceAllCount: 7,
      hits: [
        { sec: 0, para: 1, charOffset: 0, length: 5 },
        { sec: 0, para: 4, charOffset: 3, length: 5 },
      ],
    });

    const result = applyActionScript(wasm, script(replaceEdit({ query: '2025년', new_text: '2026년' })));

    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual([]);
    const replaceCalls = calls.filter((c) => c.fn === 'replaceAll');
    expect(replaceCalls).toHaveLength(1);
    expect(replaceCalls[0].args).toEqual(['2025년', '2026년', false]);
    // 표 셀 안까지 찾도록 includeCells=true로 검색한다.
    expect(calls.find((c) => c.fn === 'searchAllText')?.args[2]).toBe(true);
  });

  it('scope="first"면 replaceOne을 쓰고 그 위치만 changed로 보고한다', () => {
    const { wasm, calls } = makeWasm({ replaceOne: { ok: true, sec: 0, para: 2 } });

    const result = applyActionScript(
      wasm,
      script(replaceEdit({ query: '가', new_text: '나', scope: 'first' })),
    );

    expect(result.applied).toBe(1);
    expect(calls.some((c) => c.fn === 'replaceOne')).toBe(true);
    expect(calls.some((c) => c.fn === 'replaceAll')).toBe(false);
    expect(result.changed).toEqual([{ sec: 0, para: 2 }]);
  });

  it('본문 매치 위치를 changed에 실어 diff/부분 승인이 동작하게 한다', () => {
    const { wasm } = makeWasm({
      hits: [
        { sec: 0, para: 1, charOffset: 0, length: 2 },
        // 표 셀 매치는 changed(본문 문단 모델)에서 제외된다 — 치환 자체는 수행된다.
        { sec: 0, para: 3, charOffset: 0, length: 2, cellContext: { cellIdx: 1 } },
        { sec: 1, para: 0, charOffset: 4, length: 2 },
      ],
    });

    const result = applyActionScript(wasm, script(replaceEdit({ query: '가', new_text: '나' })));

    expect(result.changed).toEqual([
      { sec: 0, para: 1 },
      { sec: 1, para: 0 },
    ]);
  });
});

describe('F-293e8c99 AC-002 — 대소문자 구분 기본 false', () => {
  it('case_sensitive 생략 시 false로 전달된다', () => {
    const { wasm, calls } = makeWasm({});
    applyActionScript(wasm, script(replaceEdit({ query: 'Hop', new_text: 'HOP' })));
    expect(calls.find((c) => c.fn === 'replaceAll')?.args[2]).toBe(false);
  });

  it('case_sensitive: true는 그대로 전달된다', () => {
    const { wasm, calls } = makeWasm({});
    applyActionScript(
      wasm,
      script(replaceEdit({ query: 'Hop', new_text: 'HOP', case_sensitive: true })),
    );
    expect(calls.find((c) => c.fn === 'replaceAll')?.args[2]).toBe(true);
    expect(calls.find((c) => c.fn === 'searchAllText')?.args[1]).toBe(true);
  });
});

describe('F-293e8c99 AC-003 — 못 찾으면 조용히 성공하지 않는다', () => {
  it('일치 0건이면 applied=0이고 사유가 skipped에 남는다', () => {
    const { wasm } = makeWasm({ replaceAllCount: 0 });

    const result = applyActionScript(wasm, script(replaceEdit({ query: '없는말', new_text: 'x' })));

    expect(result.applied).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].targetId).toBe(DOC_SCOPE_TARGET);
    expect(result.skipped[0].reason).toContain('찾지 못했습니다');
  });

  it('query가 비면 엔진을 부르지 않고 사유를 보고한다', () => {
    const { wasm, calls } = makeWasm({});

    const result = applyActionScript(wasm, script(replaceEdit({ query: '', new_text: 'x' })));

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn === 'replaceAll')).toBe(false);
    expect(result.skipped[0].reason).toContain('비어 있습니다');
  });

  it('scope="first"에서 못 찾아도 사유를 보고한다', () => {
    const { wasm } = makeWasm({ replaceOne: { ok: false } });

    const result = applyActionScript(
      wasm,
      script(replaceEdit({ query: '없는말', new_text: 'x', scope: 'first' })),
    );

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('찾지 못했습니다');
  });

  it('전역 치환 API가 없는 환경이면 문서를 바꾸지 않고 사유를 보고한다', () => {
    const { wasm } = makeWasm({ omitReplaceApis: true });

    const result = applyActionScript(wasm, script(replaceEdit({ query: '가', new_text: '나' })));

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('지원하지 않습니다');
  });

  it('검색이 실패해도 치환 자체는 수행된다(diff 표시만 생략)', () => {
    const { wasm, calls } = makeWasm({ searchThrows: true, replaceAllCount: 2 });

    const result = applyActionScript(wasm, script(replaceEdit({ query: '가', new_text: '나' })));

    expect(result.applied).toBe(1);
    expect(calls.some((c) => c.fn === 'replaceAll')).toBe(true);
    expect(result.changed).toEqual([]);
  });

  it('문단 ID를 target으로 쓴 전역 치환은 거부된다', () => {
    const { wasm, calls } = makeWasm({});

    const result = applyActionScript(
      wasm,
      script(replaceEdit({ query: '가', new_text: '나' }, 'sec[0].p[1]')),
    );

    expect(result.applied).toBe(0);
    expect(calls.some((c) => c.fn === 'replaceAll')).toBe(false);
    expect(result.skipped[0].reason).toContain('target_id="doc"');
  });

  it('replace_text가 아닌 payload가 doc을 target으로 잡으면 거부된다', () => {
    const { wasm } = makeWasm({});
    const bogus = {
      command: 'REPLACE',
      target_id: DOC_SCOPE_TARGET,
      payload: { type: 'paragraph', text: '문서 전체를 이걸로' },
    } as unknown as Edit;

    const result = applyActionScript(wasm, script(bogus));

    expect(result.applied).toBe(0);
    expect(result.skipped[0].reason).toContain('전역 찾아 바꾸기');
  });
});

describe('F-293e8c99 AC-004 — 전역 치환은 문단 편집 뒤에 적용된다', () => {
  it('문단 REPLACE가 모두 끝난 뒤 replaceAll이 호출된다', () => {
    const { wasm, calls } = makeWasm({ replaceAllCount: 1 });
    const paraEdit = (id: string, text: string): Edit =>
      ({ command: 'REPLACE', target_id: id, payload: { type: 'paragraph', text } }) as unknown as Edit;

    applyActionScript(
      wasm,
      script(
        replaceEdit({ query: '2025', new_text: '2026' }),
        paraEdit('sec[0].p[0]', '첫 문단'),
        paraEdit('sec[0].p[5]', '여섯째 문단'),
      ),
    );

    const replaceAt = calls.findIndex((c) => c.fn === 'replaceAll');
    const lastParaEdit = calls.map((c) => c.fn).lastIndexOf('insertText');
    expect(replaceAt).toBeGreaterThan(-1);
    expect(lastParaEdit).toBeGreaterThan(-1);
    // 전역 치환이 마지막 — 앞선 문단 편집의 target 인덱스를 어긋나게 하지 않는다.
    expect(replaceAt).toBeGreaterThan(lastParaEdit);
  });
});
