import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearInlineDiff, showInlineDiff, type InlineDiffEntry } from './ai-inline-diff';

class FakeElement {
  tagName: string;
  className = '';
  textContent: string | null = '';
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
  click(): void {
    this.listeners.get('click')?.forEach((fn) => fn({}));
  }
  querySelectorAll(selector: string): FakeElement[] {
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
    return this.allDescendants().find((n) => n.className.split(/\s+/).includes(cls)) ?? null;
  }
}

describe('ai-inline-diff', () => {
  let scrollContent: FakeElement;
  let scrollContainer: FakeElement;

  let body: FakeElement;

  beforeEach(() => {
    body = new FakeElement('body');
    (globalThis as Record<string, unknown>).document = {
      createElement: (tag: string) => new FakeElement(tag),
      body,
    };
    scrollContent = new FakeElement('div');
    scrollContainer = new FakeElement('div');
    (scrollContainer as unknown as { scrollTo: () => void }).scrollTo = vi.fn();
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

    const bar = body.find('hop-ai-inline-bar')!;
    // 컨테이너 좌표를 못 구하는 환경(테스트)은 변경 위치 위 폴백(top=80-30).
    expect(bar.style.top).toBe(`${80 - 30}px`);
    expect(body.find('hop-ai-inline-label')?.textContent).toBe('AI 제안 2건');

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
});
