// 회귀 테스트: 문서 위에서 AI 변경을 커서처럼 검토한다 (F-21ca4efe).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearInlineDiff, showInlineDiff, type InlineDiffEntry } from './ai-inline-diff';

/**
 * CSS 원문. vitest 기본 설정(css: false)은 `.css?raw`까지 빈 문자열로 바꾸므로 Node 내장
 * fs로 직접 읽는다(@types/node 없이 필요한 모양만 좁혀 쓴다).
 */
const css = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, encoding: 'utf8'): string } };
  }
).process
  .getBuiltinModule('node:fs')
  .readFileSync(new URL('../styles/agent-sidebar.css', import.meta.url), 'utf8');

/** 선택자가 정확히 일치하는 규칙들의 선언을 합친다. */
function cssDecls(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.replace(/\s+/g, ' ').trim());
    if (!selectors.includes(selector)) continue;
    for (const decl of m[2].split(';')) {
      const idx = decl.indexOf(':');
      if (idx > 0) out.set(decl.slice(0, idx).trim(), decl.slice(idx + 1).trim());
    }
  }
  return out;
}

interface FakeEventInit {
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

class FakeElement {
  tagName: string;
  className = '';
  textContent: string | null = '';
  title = '';
  type = '';
  innerHTML = '';
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  private listeners = new Map<string, Array<(e: unknown) => void>>();
  private attrs = new Map<string, string>();

  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }
  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }
  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes: FakeElement[]): void {
    for (const n of nodes) this.appendChild(n);
  }
  remove(): void {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
      this.parentNode = null;
    }
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  fire(type: string, event: FakeEventInit = {}): void {
    this.listeners.get(type)?.forEach((fn) => fn(event));
  }
  click(): void {
    this.fire('click');
  }
  hasClass(cls: string): boolean {
    return this.className.split(/\s+/).includes(cls);
  }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1);
      return this.allDescendants().filter((n) => n.hasClass(cls));
    }
    // `[attr]` only.
    const attr = selector.replace(/^\[|\]$/g, '');
    return this.allDescendants().filter((n) => n.getAttribute(attr) !== null);
  }
  private allDescendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.children) {
      out.push(c);
      out.push(...c.allDescendants());
    }
    return out;
  }
  find(cls: string): FakeElement | null {
    return this.allDescendants().find((n) => n.hasClass(cls)) ?? null;
  }
  findAll(cls: string): FakeElement[] {
    return this.querySelectorAll(`.${cls}`);
  }
}

describe('ai-inline-diff', () => {
  let scrollContent: FakeElement;
  let scrollContainer: FakeElement;
  let scrollTo: ReturnType<typeof vi.fn>;
  let body: FakeElement;

  beforeEach(() => {
    body = new FakeElement('body');
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => new FakeElement(tag),
      body,
    };
    scrollContent = new FakeElement('div');
    scrollContainer = new FakeElement('div');
    scrollTo = vi.fn();
    (scrollContainer as unknown as { scrollTo: typeof scrollTo }).scrollTo = scrollTo;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).document;
  });

  function deps() {
    return {
      scrollContent: scrollContent as unknown as HTMLElement,
      scrollContainer: scrollContainer as unknown as HTMLElement,
    };
  }

  function bar(cls: string): FakeElement {
    const node = body.find(cls);
    if (!node) throw new Error(`missing bar element .${cls}`);
    return node;
  }

  function labelText(): string | null {
    return bar('hop-ai-inline-label').textContent;
  }

  /** 지금 가리키는 변경 표시(초록 칠·표시줄)의 top 목록. */
  function currentTops(): string[] {
    return scrollContent
      .findAll('hop-ai-inline-mark')
      .concat(scrollContent.findAll('hop-ai-inline-changebar'))
      .filter((m) => m.hasClass('hop-ai-inline-current'))
      .map((m) => m.style.top);
  }

  const entries: InlineDiffEntry[] = [
    { top: 200, lineBottom: 216, left: 40, maxWidth: 300, before: '525,000,000', after: '1,000,000,000' },
    { top: 80, lineBottom: 96, left: 40, maxWidth: 300, after: '새 문단' },
  ];

  it('renders before/after cards and a floating accept/reject bar', () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    const count = showInlineDiff(deps(), entries, { onAccept, onReject });
    expect(count).toBe(2);

    // 카드 2개는 본문 좌표에, 승인/거절 바는 뷰포트 고정용으로 body에 붙는다.
    expect(scrollContent.querySelectorAll('[data-hop-ai-inline]').length).toBe(2);
    expect(scrollContent.find('hop-ai-inline-before')?.textContent).toBe('525,000,000');
    expect(scrollContent.find('hop-ai-inline-after')?.textContent).toBe('1,000,000,000');

    const barEl = body.find('hop-ai-inline-bar')!;
    // 컨테이너 좌표를 못 구하는 환경(테스트)은 변경 위치 위 폴백(top=80-30).
    expect(barEl.style.top).toBe(`${80 - 30}px`);
    expect(body.find('hop-ai-inline-label')?.textContent).toBe('변경 1 / 2');

    body.find('hop-ai-inline-accept')!.click();
    expect(onAccept).toHaveBeenCalledOnce();
    body.find('hop-ai-inline-reject')!.click();
    expect(onReject).toHaveBeenCalledOnce();
  });

  it('clears previous overlay on re-render and via clearInlineDiff', () => {
    showInlineDiff(deps(), entries, { onAccept: vi.fn(), onReject: vi.fn() });
    showInlineDiff(deps(), entries, { onAccept: vi.fn(), onReject: vi.fn() });
    // 재렌더 시 누적되지 않는다(본문 카드 2 + body 바 1).
    expect(scrollContent.querySelectorAll('[data-hop-ai-inline]').length).toBe(2);
    expect(body.querySelectorAll('[data-hop-ai-inline]').length).toBe(1);

    clearInlineDiff(scrollContent as unknown as HTMLElement);
    expect(scrollContent.querySelectorAll('[data-hop-ai-inline]').length).toBe(0);
    expect(body.querySelectorAll('[data-hop-ai-inline]').length).toBe(0);
  });

  it('returns 0 and draws nothing for an empty entry list', () => {
    expect(showInlineDiff(deps(), [], { onAccept: vi.fn(), onReject: vi.fn() })).toBe(0);
    expect(scrollContent.children).toEqual([]);
    expect(body.children).toEqual([]);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────────────────
  // F-21ca4efe AC-9415c18e: 바뀐 문단 전체 연녹색 칠 + 사라진 원문 빨간 취소선
  // ─────────────────────────────────────────────────────────

  it('AC-9415c18e: draws exactly one full-paragraph mark per block entry with the entry geometry (bottom drives height)', () => {
    const blockEntries: InlineDiffEntry[] = [
      // 여러 줄 문단: 첫 줄 위(100) ~ 마지막 줄 아래(bottom 160).
      { top: 100, lineBottom: 118, bottom: 160, left: 52, maxWidth: 380, block: true, editIndex: 0 },
      // bottom 없음 → lineBottom이 아래 끝. 폭은 최소 40.
      { top: 300, lineBottom: 318, left: 52, maxWidth: 20, block: true, editIndex: 1 },
      // bottom이 lineBottom보다 위면 lineBottom을 쓰고, 높이는 최소 10.
      { top: 400, lineBottom: 405, bottom: 402, left: 10, maxWidth: 200, block: true, editIndex: 2 },
      // 칠이 아닌 원문 카드 항목은 칠을 만들지 않는다.
      { top: 500, lineBottom: 520, left: 60, maxWidth: 300, before: '원문', editIndex: 0 },
    ];
    const drawn = showInlineDiff(deps(), blockEntries, { onAccept: vi.fn(), onReject: vi.fn() }, { scroll: false });
    expect(drawn).toBe(4);
    const marks = scrollContent.findAll('hop-ai-inline-mark');
    expect(marks.map((m) => ({ ...m.style }))).toEqual([
      { position: 'absolute', left: '52px', top: '100px', width: '380px', height: '60px', pointerEvents: 'none' },
      { position: 'absolute', left: '52px', top: '300px', width: '40px', height: '18px', pointerEvents: 'none' },
      { position: 'absolute', left: '10px', top: '400px', width: '200px', height: '10px', pointerEvents: 'none' },
    ]);
    expect(marks.every((m) => m.getAttribute('data-hop-ai-inline') === 'mark')).toBe(true);
    // 칠은 연녹색 배경 + 왼쪽 초록 줄(종이 위 고정 색).
    expect(cssDecls('.hop-ai-inline-mark').get('background')).toBe('var(--hop-ai-doc-add-bg)');
    expect(cssDecls('.hop-ai-inline-mark').get('box-shadow')).toBe('inset 3px 0 0 var(--hop-ai-doc-add)');
    expect(cssDecls('.hop-ai-panel').get('--hop-ai-doc-add-bg')).toBe('rgba(43, 154, 94, 0.1)');
  });

  it('AC-9415c18e: the removed original is a strikethrough card placed just below the changed paragraph (bottom + 2)', () => {
    showInlineDiff(
      deps(),
      [
        { top: 100, lineBottom: 118, bottom: 160, left: 52, maxWidth: 380, block: true, editIndex: 0 },
        { top: 100, lineBottom: 118, bottom: 160, left: 52, maxWidth: 380, before: '사라진 원문', editIndex: 0 },
        { top: 600, lineBottom: 616, left: 70, maxWidth: 50, before: '좁은 원문', after: '좁은 새 글' },
      ],
      { onAccept: vi.fn(), onReject: vi.fn() },
      { scroll: false },
    );
    const cards = scrollContent.findAll('hop-ai-inline-card');
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => ({ ...c.style }))).toEqual([
      { position: 'absolute', left: '52px', top: '162px', maxWidth: '380px' },
      { position: 'absolute', left: '70px', top: '618px', maxWidth: '120px' },
    ]);
    expect(cards[0].children.map((c) => [c.className, c.textContent])).toEqual([
      ['hop-ai-inline-before', '사라진 원문'],
    ]);
    // 가상 미리보기(폴백)는 원문 아래 새 글을 함께 보인다.
    expect(cards[1].children.map((c) => [c.className, c.textContent])).toEqual([
      ['hop-ai-inline-before', '좁은 원문'],
      ['hop-ai-inline-after', '좁은 새 글'],
    ]);
    const before = cssDecls('.hop-ai-inline-before');
    expect(before.get('text-decoration')).toBe('line-through');
    expect(before.get('color')).toBe('var(--hop-ai-doc-del)');
    expect(cssDecls('.hop-ai-panel').get('--hop-ai-doc-del')).toBe('#b42318');
  });

  it('AC-9415c18e: a change bar (unknown paint width, e.g. table cells) sits 8px left of the line with the line height', () => {
    showInlineDiff(
      deps(),
      [
        { top: 200, lineBottom: 216, left: 30, maxWidth: 100, changeBar: true, editIndex: 0 },
        { top: 260, lineBottom: 262, left: 4, maxWidth: 100, changeBar: true, editIndex: 1 },
      ],
      { onAccept: vi.fn(), onReject: vi.fn() },
      { scroll: false },
    );
    const bars = scrollContent.findAll('hop-ai-inline-changebar');
    expect(bars.map((b) => ({ ...b.style }))).toEqual([
      { position: 'absolute', left: '22px', top: '200px', height: '16px', pointerEvents: 'none' },
      { position: 'absolute', left: '0px', top: '260px', height: '10px', pointerEvents: 'none' },
    ]);
    expect(scrollContent.findAll('hop-ai-inline-mark')).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────
  // F-21ca4efe AC-5c76a96c: 변경마다 오른쪽 여백 미니 승인/거절
  // ─────────────────────────────────────────────────────────

  it('AC-5c76a96c: exactly one mini per editIndex at miniLeft / that change’s first line, wired to that exact editIndex', () => {
    const onAcceptOne = vi.fn();
    const onRejectOne = vi.fn();
    const onAccept = vi.fn();
    const onReject = vi.fn();
    showInlineDiff(
      deps(),
      [
        { top: 100, lineBottom: 118, bottom: 140, left: 50, maxWidth: 300, block: true, editIndex: 0, miniLeft: 460 },
        // 같은 변경이 쪽을 넘겨 이어진 부분 — 미니는 다시 그리지 않는다.
        { top: 900, lineBottom: 918, bottom: 950, left: 50, maxWidth: 300, block: true, editIndex: 0, miniLeft: 470 },
        { top: 140, lineBottom: 158, left: 50, maxWidth: 300, before: '원문', editIndex: 0, miniLeft: 480 },
        { top: 200, lineBottom: 218, left: 50, maxWidth: 300, block: true, editIndex: 3, miniLeft: 461 },
      ],
      { onAccept, onReject, onAcceptOne, onRejectOne },
      { scroll: false },
    );
    const minis = scrollContent.findAll('hop-ai-inline-mini');
    expect(minis).toHaveLength(2);
    expect(minis.map((m) => ({ ...m.style }))).toEqual([
      { position: 'absolute', left: '460px', top: '100px' },
      { position: 'absolute', left: '461px', top: '200px' },
    ]);
    for (const mini of minis) {
      expect(mini.children.map((b) => [b.className, b.title])).toEqual([
        ['hop-ai-inline-mini-reject', '이 변경 거절'],
        ['hop-ai-inline-mini-accept', '이 변경 승인'],
      ]);
      expect(mini.children.every((b) => b.innerHTML.startsWith('<svg'))).toBe(true);
    }

    minis[1].find('hop-ai-inline-mini-reject')!.click();
    expect(onRejectOne.mock.calls).toEqual([[3]]);
    minis[1].find('hop-ai-inline-mini-accept')!.click();
    expect(onAcceptOne.mock.calls).toEqual([[3]]);
    minis[0].find('hop-ai-inline-mini-reject')!.click();
    minis[0].find('hop-ai-inline-mini-accept')!.click();
    expect(onRejectOne.mock.calls).toEqual([[3], [0]]);
    expect(onAcceptOne.mock.calls).toEqual([[3], [0]]);
    // 개별 결정은 '모두' 콜백을 부르지 않는다.
    expect(onAccept).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });

  it('AC-5c76a96c: no mini is drawn without per-edit callbacks, without editIndex, or without miniLeft', () => {
    const base = { top: 100, lineBottom: 118, left: 50, maxWidth: 300, block: true };
    showInlineDiff(deps(), [{ ...base, editIndex: 0, miniLeft: 460 }], { onAccept: vi.fn(), onReject: vi.fn() });
    expect(scrollContent.findAll('hop-ai-inline-mini')).toEqual([]);

    const perEdit = { onAccept: vi.fn(), onReject: vi.fn(), onAcceptOne: vi.fn(), onRejectOne: vi.fn() };
    showInlineDiff(deps(), [{ ...base, miniLeft: 460 }], perEdit);
    expect(scrollContent.findAll('hop-ai-inline-mini')).toEqual([]);

    showInlineDiff(deps(), [{ ...base, editIndex: 0 }], perEdit);
    expect(scrollContent.findAll('hop-ai-inline-mini')).toEqual([]);

    showInlineDiff(deps(), [{ ...base, editIndex: 0, miniLeft: 460 }], perEdit);
    expect(scrollContent.findAll('hop-ai-inline-mini')).toHaveLength(1);
  });

  it('AC-5c76a96c: mini buttons swallow mousedown so clicking them does not move the editor caret', () => {
    showInlineDiff(
      deps(),
      [{ top: 100, lineBottom: 118, left: 50, maxWidth: 300, block: true, editIndex: 0, miniLeft: 460 }],
      { onAccept: vi.fn(), onReject: vi.fn(), onAcceptOne: vi.fn(), onRejectOne: vi.fn() },
    );
    for (const cls of ['hop-ai-inline-mini-reject', 'hop-ai-inline-mini-accept']) {
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      scrollContent.find(cls)!.fire('mousedown', { preventDefault, stopPropagation });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(stopPropagation).toHaveBeenCalledOnce();
    }
  });

  // ─────────────────────────────────────────────────────────
  // F-21ca4efe AC-30abfd1b: '변경 i / N' 탐색 바
  // ─────────────────────────────────────────────────────────

  /** 입력 순서와 문서 순서가 다른 세 변경(그룹 top: 편집1=180, 편집2=400, 편집0=700). */
  const THREE_CHANGES: InlineDiffEntry[] = [
    { top: 700, lineBottom: 716, left: 50, maxWidth: 300, block: true, editIndex: 0, miniLeft: 460 },
    { top: 200, lineBottom: 216, left: 50, maxWidth: 300, block: true, editIndex: 1, miniLeft: 460 },
    { top: 400, lineBottom: 416, left: 50, maxWidth: 300, changeBar: true, editIndex: 2, miniLeft: 460 },
    // 편집1의 원문 카드가 칠보다 위에서 시작 → 그 변경의 위치는 180.
    { top: 180, lineBottom: 196, left: 50, maxWidth: 300, before: '원문', editIndex: 1 },
  ];

  function perEditCallbacks() {
    return { onAccept: vi.fn(), onReject: vi.fn(), onAcceptOne: vi.fn(), onRejectOne: vi.fn() };
  }

  it('AC-30abfd1b: the bar reads "변경 i / N" in document (top) order and next/prev scroll to each change (top − 80), wrapping', () => {
    const onFocusChange = vi.fn();
    showInlineDiff(deps(), THREE_CHANGES, perEditCallbacks(), { onFocusChange });
    expect(labelText()).toBe('변경 1 / 3');
    expect(scrollTo.mock.calls).toEqual([[{ top: 100, behavior: 'smooth' }]]);
    expect(currentTops()).toEqual(['200px']);

    bar('hop-ai-inline-next').click();
    expect(labelText()).toBe('변경 2 / 3');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 320, behavior: 'smooth' });
    expect(currentTops()).toEqual(['400px']);

    bar('hop-ai-inline-next').click();
    expect(labelText()).toBe('변경 3 / 3');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 620, behavior: 'smooth' });
    expect(currentTops()).toEqual(['700px']);

    bar('hop-ai-inline-next').click();
    expect(labelText()).toBe('변경 1 / 3');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 100, behavior: 'smooth' });

    bar('hop-ai-inline-prev').click();
    expect(labelText()).toBe('변경 3 / 3');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 620, behavior: 'smooth' });
    expect(onFocusChange.mock.calls).toEqual([[0], [1], [2], [0], [2]]);
    // 현재 표시 클래스는 하나의 변경에만 남는다(이전 위치에서 벗겨짐).
    expect(scrollContent.findAll('hop-ai-inline-mark').map((m) => m.className)).toEqual([
      'hop-ai-inline-mark hop-ai-inline-current',
      'hop-ai-inline-mark',
    ]);
  });

  it('AC-30abfd1b: reject-one / accept-one act on the CURRENT change; reject-all / accept-all on everything', () => {
    const callbacks = perEditCallbacks();
    showInlineDiff(deps(), THREE_CHANGES, callbacks, { scroll: false });
    expect(bar('hop-ai-inline-one').className).toBe('hop-ai-inline-one');
    expect(bar('hop-ai-inline-reject-one').textContent).toBe('거절');
    expect(bar('hop-ai-inline-accept-one').textContent).toBe('승인');

    bar('hop-ai-inline-reject-one').click();
    expect(callbacks.onRejectOne.mock.calls).toEqual([[1]]);
    bar('hop-ai-inline-next').click();
    bar('hop-ai-inline-accept-one').click();
    expect(callbacks.onAcceptOne.mock.calls).toEqual([[2]]);
    bar('hop-ai-inline-next').click();
    bar('hop-ai-inline-reject-one').click();
    expect(callbacks.onRejectOne.mock.calls).toEqual([[1], [0]]);

    expect(bar('hop-ai-inline-reject').textContent).toBe('모두 거절');
    expect(bar('hop-ai-inline-accept').textContent).toBe('모두 승인');
    bar('hop-ai-inline-reject').click();
    bar('hop-ai-inline-accept').click();
    expect(callbacks.onReject).toHaveBeenCalledTimes(1);
    expect(callbacks.onAccept).toHaveBeenCalledTimes(1);
    expect(callbacks.onAcceptOne).toHaveBeenCalledTimes(1);
    expect(callbacks.onRejectOne).toHaveBeenCalledTimes(2);
  });

  it('AC-30abfd1b: per-change bar buttons are hidden when any change lacks editIndex or per-edit callbacks are missing', () => {
    const two = (second: Partial<InlineDiffEntry>): InlineDiffEntry[] => [
      { top: 100, lineBottom: 116, left: 50, maxWidth: 300, block: true, editIndex: 0 },
      { top: 300, lineBottom: 316, left: 50, maxWidth: 300, block: true, ...second },
    ];
    showInlineDiff(deps(), two({}), perEditCallbacks(), { scroll: false });
    expect(bar('hop-ai-inline-one').className).toBe('hop-ai-inline-one hop-ai-hidden');

    showInlineDiff(deps(), two({ editIndex: 1 }), { onAccept: vi.fn(), onReject: vi.fn(), onAcceptOne: vi.fn() }, { scroll: false });
    expect(bar('hop-ai-inline-one').className).toBe('hop-ai-inline-one hop-ai-hidden');

    showInlineDiff(deps(), two({ editIndex: 1 }), perEditCallbacks(), { scroll: false });
    expect(bar('hop-ai-inline-one').className).toBe('hop-ai-inline-one');
    // 바는 매번 새로 그려 하나만 남는다.
    expect(body.findAll('hop-ai-inline-bar')).toHaveLength(1);
  });

  it('AC-30abfd1b: a single change reads "AI 변경 1건" with nav and per-change buttons hidden and plain 거절/승인', () => {
    const callbacks = perEditCallbacks();
    // 같은 편집 번호의 두 표시(칠 + 원문 카드)는 변경 1건이다.
    showInlineDiff(
      deps(),
      [
        { top: 100, lineBottom: 120, left: 50, maxWidth: 400, block: true, editIndex: 4 },
        { top: 100, lineBottom: 120, left: 50, maxWidth: 400, before: '원문', editIndex: 4 },
      ],
      callbacks,
    );
    expect(labelText()).toBe('AI 변경 1건');
    expect(bar('hop-ai-inline-nav').className).toBe('hop-ai-inline-nav hop-ai-hidden');
    expect(bar('hop-ai-inline-one').className).toBe('hop-ai-inline-one hop-ai-hidden');
    expect(bar('hop-ai-inline-reject').textContent).toBe('거절');
    expect(bar('hop-ai-inline-accept').textContent).toBe('승인');
    // 1건일 때는 '지금 변경' 강조를 따로 하지 않는다.
    expect(currentTops()).toEqual([]);
    expect(scrollTo.mock.calls).toEqual([[{ top: 20, behavior: 'smooth' }]]);
  });

  it('AC-30abfd1b: focusIndex picks the starting change and is clamped to the valid range', () => {
    const onFocusChange = vi.fn();
    showInlineDiff(deps(), THREE_CHANGES, perEditCallbacks(), { focusIndex: 1, onFocusChange });
    expect(labelText()).toBe('변경 2 / 3');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 320, behavior: 'smooth' });
    expect(currentTops()).toEqual(['400px']);

    showInlineDiff(deps(), THREE_CHANGES, perEditCallbacks(), { focusIndex: 9, onFocusChange });
    expect(labelText()).toBe('변경 3 / 3');
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 620, behavior: 'smooth' });

    showInlineDiff(deps(), THREE_CHANGES, perEditCallbacks(), { focusIndex: -2, onFocusChange });
    expect(labelText()).toBe('변경 1 / 3');
    expect(onFocusChange.mock.calls).toEqual([[1], [2], [0]]);
  });

  it('AC-30abfd1b: scroll:false does not scroll on show, but next/prev still scroll', () => {
    showInlineDiff(deps(), THREE_CHANGES, perEditCallbacks(), { scroll: false, focusIndex: 2 });
    expect(labelText()).toBe('변경 3 / 3');
    expect(scrollTo).not.toHaveBeenCalled();
    bar('hop-ai-inline-prev').click();
    expect(scrollTo.mock.calls).toEqual([[{ top: 320, behavior: 'smooth' }]]);
  });

  it('AC-30abfd1b: the bar is fixed at the bottom centre of the document view when the container can be measured', () => {
    (scrollContainer as unknown as { getBoundingClientRect: () => object }).getBoundingClientRect = () => ({
      left: 100,
      width: 800,
      top: 50,
      bottom: 650,
    });
    showInlineDiff(deps(), THREE_CHANGES, perEditCallbacks(), { scroll: false });
    const barEl = bar('hop-ai-inline-bar');
    expect(barEl.parentNode).toBe(body);
    expect({ ...barEl.style }).toEqual({
      position: 'fixed',
      left: '500px',
      transform: 'translateX(-50%)',
      top: '594px',
    });
    expect(barEl.getAttribute('role')).toBe('toolbar');
    expect(barEl.children.map((c) => c.className)).toEqual([
      'hop-ai-inline-label',
      'hop-ai-inline-nav',
      'hop-ai-inline-sep',
      'hop-ai-inline-one',
      'hop-ai-inline-reject',
      'hop-ai-inline-accept',
    ]);
  });
});
