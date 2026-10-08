// 회귀 테스트: AI 패널이 긴 문서를 개요 → 절별로 나눠 쓰고 한 번에 검토하게 한다 (F-866a1c71).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiEventHandlers } from '@/core/ai-bridge';

/**
 * F-866a1c71 — 긴 문서 분할 작성(패널 동작).
 *
 * 가짜 브리지는 문단 배열 하나를 문서로 들고 있다: insertText/deleteText/splitParagraph/
 * mergeParagraph가 그 배열을 실제로 바꾸고, getParagraphCount/getParagraphLength/getSectionCount는
 * 그 배열을 읽는다. 그래서 제목 REPLACE·절 INSERT_AFTER는 실제 적용 경로(applyActionScript)를
 * 그대로 타고, 테스트는 '문서에 남은 문단'과 브리지 호출 인자·패널 DOM을 정확한 값으로 단언한다.
 * exportHwp는 그 시점 문단을 스냅샷 바이트에 묶어 두고, loadDocument는 그 바이트로 되돌린다.
 *
 * 응답은 listenAiEvents로 잡은 onEditReady/onEditFailed에, aiRequestEdit이 돌려준 요청 ID
 * ('req-1', 'req-2', …)로 흘려보낸다.
 */

let captured: AiEventHandlers | null = null;

vi.mock('@/core/ai-bridge', async (importActual) => {
  const actual = await importActual<typeof import('@/core/ai-bridge')>();
  return {
    ...actual,
    listenAiEvents: vi.fn(async (handlers: AiEventHandlers) => {
      captured = handlers;
      return () => {
        captured = null;
      };
    }),
  };
});

import { AgentSidebar, type AgentSidebarDeps } from './agent-sidebar';

// ── 가짜 DOM (agent-sidebar-layout.test.ts와 같은 의미) ─────────────────

interface FakeEvent {
  type: string;
  key?: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  target: FakeElement | null;
  currentTarget: FakeElement | null;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  dataTransfer?: unknown;
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

type Listener = (event: FakeEvent) => void;

function makeEvent(type: string, init: Partial<FakeEvent> = {}): FakeEvent {
  const event: FakeEvent = {
    type,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    target: null,
    currentTarget: null,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      event.defaultPrevented = true;
    },
    stopPropagation() {
      event.propagationStopped = true;
    },
    stopImmediatePropagation() {
      event.propagationStopped = true;
    },
    ...init,
  };
  return event;
}

function camel(dataAttr: string): string {
  return dataAttr.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

class FakeElement {
  tagName: string;
  title = '';
  type = '';
  rows = 0;
  placeholder = '';
  disabled = false;
  checked = false;
  multiple = false;
  accept = '';
  autocomplete = '';
  innerHTML = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  scrollTop = 0;
  scrollHeight = 0;
  focusCalls = 0;
  selectCalls = 0;
  selectionRanges: Array<[number, number]> = [];
  scrollToCalls: Array<{ top: number; behavior?: string }> = [];
  private classTokens: string[] = [];
  private ownText = '';
  private explicitValue: string | null = null;
  private listeners = new Map<string, Listener[]>();
  private attrs = new Map<string, string>();

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
  }

  get className(): string {
    return this.classTokens.join(' ');
  }
  set className(value: string) {
    this.classTokens = String(value).split(/\s+/).filter(Boolean);
  }

  get classList() {
    const self = this;
    return {
      add(...classes: string[]) {
        for (const cls of classes) if (!self.classTokens.includes(cls)) self.classTokens.push(cls);
      },
      remove(...classes: string[]) {
        self.classTokens = self.classTokens.filter((c) => !classes.includes(c));
      },
      contains(cls: string) {
        return self.classTokens.includes(cls);
      },
      toggle(cls: string, force?: boolean) {
        const next = force ?? !self.classTokens.includes(cls);
        if (next) this.add(cls);
        else this.remove(cls);
        return next;
      },
    };
  }

  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  set textContent(value: string | null) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.ownText = value ?? '';
  }

  get value(): string {
    if (this.tagName === 'SELECT') {
      const options = this.children.filter((c) => c.tagName === 'OPTION');
      if (this.explicitValue !== null && options.some((o) => o.value === this.explicitValue)) {
        return this.explicitValue;
      }
      return options[0]?.value ?? '';
    }
    return this.explicitValue ?? '';
  }
  set value(value: string) {
    this.explicitValue = value;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[camel(name)] = String(value);
  }

  getAttribute(name: string): string | null {
    if (this.attrs.has(name)) return this.attrs.get(name)!;
    if (name.startsWith('data-') && camel(name) in this.dataset) return this.dataset[camel(name)];
    return null;
  }

  appendChild(child: FakeElement): FakeElement {
    child.remove();
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) this.appendChild(node);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.ownText = '';
    for (const node of nodes) this.appendChild(node);
  }

  before(...nodes: FakeElement[]): void {
    const parent = this.parentNode;
    if (!parent) return;
    for (const node of nodes) {
      node.remove();
      node.parentNode = parent;
      parent.children.splice(parent.children.indexOf(this), 0, node);
    }
  }

  remove(): void {
    if (!this.parentNode) return;
    const idx = this.parentNode.children.indexOf(this);
    if (idx >= 0) this.parentNode.children.splice(idx, 1);
    this.parentNode = null;
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    const idx = list.indexOf(listener);
    if (idx >= 0) list.splice(idx, 1);
  }

  /** 이벤트를 이 요소에서 시작해 조상으로 버블링시킨다(stopPropagation에서 멈춤). */
  dispatch(type: string, init: Partial<FakeEvent> = {}): FakeEvent {
    const event = makeEvent(type, init);
    if (!event.target) event.target = this;
    for (let node: FakeElement | null = this; node; node = node.parentNode) {
      event.currentTarget = node;
      for (const fn of [...(node.listeners.get(type) ?? [])]) fn(event);
      if (event.propagationStopped) break;
    }
    return event;
  }

  click(): FakeEvent {
    return this.dispatch('click');
  }

  focus(): void {
    this.focusCalls += 1;
  }

  select(): void {
    this.selectCalls += 1;
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionRanges.push([start, end]);
  }

  scrollTo(arg: { top: number; behavior?: string }): void {
    this.scrollToCalls.push(arg);
  }

  get clientWidth(): number {
    return 600;
  }

  contains(node: unknown): boolean {
    if (node === this) return true;
    return this.descendants().some((n) => n === node);
  }

  matches(selector: string): boolean {
    return selector
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .some((simple) => this.matchesSimple(simple));
  }

  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node; node = node.parentNode) {
      if (node.matches(selector)) return node;
    }
    return null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((node) => node.matches(selector));
  }

  descendants(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of this.children) {
      out.push(child, ...child.descendants());
    }
    return out;
  }

  private matchesSimple(simple: string): boolean {
    const attr = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(simple);
    if (attr) {
      const actual = this.getAttribute(attr[1]);
      return attr[2] === undefined ? actual !== null : actual === attr[2];
    }
    if (simple.startsWith('.')) {
      return simple
        .slice(1)
        .split('.')
        .every((cls) => this.classTokens.includes(cls));
    }
    return this.tagName === simple.toUpperCase();
  }
}

class FakeDocument {
  body = new FakeElement('body');
  private listeners = new Map<string, Listener[]>();

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  addEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: Listener): void {
    const list = this.listeners.get(type) ?? [];
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }

  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector);
  }
}

// ── 가짜 브리지: 문단 배열이 곧 문서 ───────────────────────────────

/** 마이크로태스크·0ms 타이머까지 모두 비운다(루프가 다음 요청을 보낼 때까지). */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

interface TestSkill {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  body: string;
}

function createBridge(initialParas: string[]) {
  const doc = { paras: [...initialParas] };
  /** exportHwp가 만든 스냅샷 바이트 → 그때의 문단. */
  const saved = new Map<Uint8Array, string[]>();
  /** aiRequestEdit이 돌려준 요청 ID(순서대로). */
  const issued: string[] = [];
  const chars = (para: number): string[] => {
    if (para < 0 || para >= doc.paras.length) throw new Error(`문단 범위 밖: ${para}`);
    return [...doc.paras[para]];
  };
  const bridge = {
    aiGetDocumentContext: vi.fn(async (..._args: unknown[]) => ({
      document_metadata: { total_sections: 1 },
      content: doc.paras.map((text, i) => ({ type: 'paragraph', id: `sec[0].p[${i}]`, text })),
    })),
    aiRequestEdit: vi.fn(async (..._args: unknown[]) => {
      const id = `req-${issued.length + 1}`;
      issued.push(id);
      return id;
    }),
    aiCancelRequest: vi.fn(async (_id: string) => undefined),
    aiSetApiKey: vi.fn(async () => undefined),
    aiHasApiKey: vi.fn(async () => false),
    aiDeleteApiKey: vi.fn(async () => undefined),
    aiListModels: vi.fn(async (_provider: string, _baseUrl?: string) => [] as string[]),
    createNewDocumentAsync: vi.fn(async () => null as { docInfo: unknown; message: string } | null),
    aiSetDocumentSensitivity: vi.fn(async () => undefined),
    aiExtractText: vi.fn(async () => ''),
    currentDocId: vi.fn(() => 'doc-1' as string | null),
    getCursorRect: vi.fn((_sec: number, para: number, _offset: number) => ({
      pageIndex: 0,
      x: 10,
      y: 100 + para * 50,
      height: 12,
    })),
    getCursorRectByPath: vi.fn(() => ({ pageIndex: 0, x: 20, y: 40, height: 10 })),
    getPageInfo: vi.fn(() => ({ width: 400, height: 800 })),
    // ── 문서 모델 ──
    getSectionCount: vi.fn(() => 1),
    getParagraphCount: vi.fn((_sec: number) => doc.paras.length),
    getParagraphLength: vi.fn((_sec: number, para: number) => chars(para).length),
    insertText: vi.fn((_sec: number, para: number, offset: number, text: string) => {
      const c = chars(para);
      c.splice(offset, 0, ...[...text]);
      doc.paras[para] = c.join('');
      return '';
    }),
    deleteText: vi.fn((_sec: number, para: number, offset: number, count: number) => {
      const c = chars(para);
      c.splice(offset, count);
      doc.paras[para] = c.join('');
      return '';
    }),
    splitParagraph: vi.fn((_sec: number, para: number, offset: number) => {
      const c = chars(para);
      doc.paras.splice(para, 1, c.slice(0, offset).join(''), c.slice(offset).join(''));
      return '';
    }),
    mergeParagraph: vi.fn((_sec: number, para: number) => {
      doc.paras.splice(para - 1, 2, doc.paras[para - 1] + doc.paras[para]);
      return '';
    }),
    insertPageBreak: vi.fn(() => ''),
    createTable: vi.fn(() => ({ ok: true, paraIdx: 3, controlIdx: 0 })),
    mergeTableCells: vi.fn(() => ({ ok: true, cellCount: 1 })),
    getCellParagraphLength: vi.fn(() => 0),
    insertTextInCell: vi.fn(() => ''),
    deleteTextInCell: vi.fn(() => ''),
    getCellParagraphLengthByPath: vi.fn(() => 0),
    insertTextInCellByPath: vi.fn(() => ''),
    deleteTextInCellByPath: vi.fn(() => ''),
    splitParagraphInCellByPath: vi.fn(() => ''),
    markDocumentDirty: vi.fn(),
    // ── 스냅샷(되돌리기) ──
    getSourceFormat: vi.fn(() => 'hwp'),
    exportHwp: vi.fn(() => {
      const bytes = new Uint8Array([9, 9, saved.size]);
      saved.set(bytes, [...doc.paras]);
      return bytes;
    }),
    loadDocument: vi.fn((bytes: Uint8Array, _fileName: string) => {
      const paras = saved.get(bytes);
      if (!paras) throw new Error('모르는 스냅샷');
      doc.paras = [...paras];
    }),
    fileName: 'plan.hwp',
    aiParseResearchNoteDocx: vi.fn(async () => {
      throw new Error('연구노트 구조 아님');
    }),
    aiParseResearchNotePdf: vi.fn(async () => {
      throw new Error('연구노트 구조 아님');
    }),
  };
  return { bridge, doc, issued };
}

function createBus() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  const emit = vi.fn((name: string, ...args: unknown[]) => {
    for (const handler of [...(handlers.get(name) ?? [])]) handler(...args);
  });
  const on = vi.fn((name: string, handler: (...args: unknown[]) => void) => {
    const set = handlers.get(name) ?? new Set();
    set.add(handler);
    handlers.set(name, set);
    return () => set.delete(handler);
  });
  return { emit, on, handlers };
}

// ── 공통 데이터 ─────────────────────────────────────────────────

const OUTLINE = {
  title: '2027 신규 사업계획서',
  message: '세 개 절로 구성했습니다.',
  sections: [
    { heading: '1. 사업 개요', brief: '목적과 배경', target_chars: 1200, table: false },
    { heading: '2. 추진 일정', brief: '분기별 마일스톤', target_chars: 1500, table: true },
    { heading: '3. 기대 효과', brief: '정량·정성 효과', target_chars: 900, table: false },
  ],
};

/** 절 하나 응답 — 제목(heading) + 본문 문단들을 모두 anchor 뒤에 INSERT_AFTER. */
function sectionScript(anchor: string, heading: string, bodies: string[]) {
  return {
    message: `${heading}을 썼습니다.`,
    edits: [
      { command: 'INSERT_AFTER', target_id: anchor, payload: { text: heading, style: 'heading' } },
      ...bodies.map((text) => ({ command: 'INSERT_AFTER', target_id: anchor, payload: { text, style: 'body' } })),
    ],
  };
}

const BIZ_SKILL: TestSkill = {
  id: 'biz-plan',
  name: '사업계획서',
  description: '사업계획서 표준 구성',
  triggers: ['사업계획서'],
  body: '## 사업계획서 작성 지침\n- 개요 → 일정 → 효과 순서',
};

// ── 테스트 ─────────────────────────────────────────────────────

describe('F-866a1c71: 긴 문서 분할 작성(AI 패널)', () => {
  let fakeDoc: FakeDocument;
  let env: ReturnType<typeof createBridge>;
  let bus: ReturnType<typeof createBus>;
  let scrollContent: FakeElement;
  let sidebar: AgentSidebar | null;

  function build(opts: { paras?: string[]; skills?: TestSkill[]; canvas?: boolean } = {}): AgentSidebar {
    env = createBridge(opts.paras ?? ['']);
    if (opts.skills) {
      (env.bridge as Record<string, unknown>).aiListSkills = vi.fn(async () => opts.skills);
    }
    scrollContent = new FakeElement('div');
    const canvasView = {
      getVirtualScroll: () => ({ getPageOffset: () => 0 }),
      getViewportManager: () => ({ getZoom: () => 1 }),
    };
    const deps = {
      bridge: env.bridge,
      eventBus: bus,
      getCanvasView: () => (opts.canvas ? canvasView : null),
      scrollContent,
      scrollContainer: new FakeElement('div'),
    };
    sidebar = new AgentSidebar(deps as unknown as AgentSidebarDeps);
    return sidebar;
  }

  function q(cls: string): FakeElement {
    const node = fakeDoc.body.querySelector(`.${cls}`);
    if (!node) throw new Error(`missing element: .${cls}`);
    return node;
  }

  function qa(cls: string): FakeElement[] {
    return fakeDoc.body.querySelectorAll(`.${cls}`);
  }

  function hidden(node: FakeElement): boolean {
    return node.classList.contains('hop-ai-hidden');
  }

  async function start(opts: { paras?: string[]; skills?: TestSkill[]; canvas?: boolean } = {}): Promise<void> {
    build(opts);
    await flush();
    const select = q('hop-ai-provider');
    select.value = 'ollama';
    select.dispatch('change');
    await flush();
  }

  async function send(text: string): Promise<void> {
    q('hop-ai-prompt').value = text;
    q('hop-ai-send').click();
    await flush();
  }

  /** 가장 최근 요청에 대한 응답(원문 JSON). */
  async function ready(payload: unknown): Promise<void> {
    const requestId = env.issued[env.issued.length - 1];
    captured!.onEditReady?.({
      requestId,
      actionScriptJson: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
    await flush();
  }

  /** 가장 최근 요청의 실패. */
  async function fail(reason = '응답 시간 초과'): Promise<void> {
    const requestId = env.issued[env.issued.length - 1];
    captured!.onEditFailed?.({ requestId, reason, code: 'TIMEOUT' });
    await flush();
  }

  function calls(): unknown[][] {
    return env.bridge.aiRequestEdit.mock.calls;
  }

  function call(i: number): unknown[] {
    const c = calls()[i];
    if (!c) throw new Error(`aiRequestEdit 호출 ${i}번이 없다(총 ${calls().length}번)`);
    return c;
  }

  function lastBubble(): FakeElement {
    const all = qa('hop-ai-msg-assistant');
    const last = all[all.length - 1];
    if (!last) throw new Error('답변 버블이 없다');
    return last;
  }

  /** 진행 목록: 머리 문구 + 행마다 [상태 클래스, 절 제목, 상태 글자]. */
  function progress(): { head: string; rows: [string, string, string][] } {
    const box = lastBubble().querySelector('.hop-ai-progress');
    if (!box) throw new Error('진행 목록 자리가 없다');
    const rows = box.querySelectorAll('.hop-ai-progress-item').map((row): [string, string, string] => {
      const state = row.className
        .split(' ')
        .find((c) => /^hop-ai-progress-(wait|run|done|skip)$/.test(c));
      return [
        state?.replace('hop-ai-progress-', '') ?? '?',
        row.querySelector('.hop-ai-progress-heading')?.textContent ?? '',
        row.querySelector('.hop-ai-progress-state')?.textContent ?? '',
      ];
    });
    return { head: box.querySelector('.hop-ai-progress-head')?.textContent ?? '', rows };
  }

  function bubbleStatus(): string {
    return lastBubble().querySelector('.hop-ai-bubble-status')?.textContent ?? '';
  }

  /** 개요까지 받은 상태(첫 절 요청이 나간 상태)로 만든다. */
  async function throughOutline(outline: unknown = OUTLINE, opts: { skills?: TestSkill[]; canvas?: boolean } = {}) {
    await start(opts);
    await send('사업계획서 작성해줘');
    expect(calls()).toHaveLength(1);
    await ready(outline);
  }

  /** 세 절을 모두 써서 검토 대기 상태로 만든다 — 편집 8건(제목 1 + 1절 3 + 2절 2 + 3절 2). */
  async function writeAllThree(opts: { canvas?: boolean } = {}): Promise<void> {
    await throughOutline(OUTLINE, opts);
    await ready(sectionScript('sec[0].p[0]', '1. 사업 개요', ['개요 본문 하나', '개요 본문 둘']));
    await ready(sectionScript('sec[0].p[3]', '2. 추진 일정', ['일정 본문']));
    await ready(sectionScript('sec[0].p[5]', '3. 기대 효과', ['효과 본문']));
  }

  beforeEach(() => {
    captured = null;
    sidebar = null;
    fakeDoc = new FakeDocument();
    (globalThis as Record<string, unknown>).document = fakeDoc;
    bus = createBus();
  });

  afterEach(() => {
    sidebar?.dispose();
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).document;
  });

  // ─────────────────────────────────────────────────────────
  // AC-5c6d1ea3: 빈 문서의 긴 작성 요청만 분할 작성으로 보낸다
  // ─────────────────────────────────────────────────────────
  describe('AC-5c6d1ea3', () => {
    it('AC-5c6d1ea3: a long-document request on a blank document starts with an outline-only request', async () => {
      await start();
      await send('사업계획서 작성해줘');

      expect(calls()).toHaveLength(1);
      const first = call(0);
      expect(first[0]).toBe('doc-1');
      expect(String(first[1])).toContain('[긴 문서 분할 작성 — 1단계: 개요]');
      expect(String(first[1]).endsWith('사업계획서 작성해줘')).toBe(true);
      expect(first[2]).toBe('ollama');
      expect(first[4]).toBeNull(); // 개요 요청은 커서 위치가 없다
      expect(first[11]).toBe(true); // 개요 요청 플래그
      // 개요 단계는 문서를 건드리지 않는다 — 시작 전 스냅샷만 잡는다.
      expect(env.bridge.exportHwp).toHaveBeenCalledTimes(1);
      expect(env.doc.paras).toEqual(['']);
      // 개요 요청은 일반 경로처럼 문서 문맥을 미리 읽지 않는다.
      expect(env.bridge.aiGetDocumentContext).not.toHaveBeenCalled();
    });

    it('AC-5c6d1ea3: the same request on a document with content takes the normal single-request path', async () => {
      await start({ paras: ['기존 본문이 있는 문서'] });
      await send('사업계획서 작성해줘');

      expect(calls()).toHaveLength(1);
      const only = call(0);
      expect(only[11]).toBeUndefined();
      expect(only).toHaveLength(9); // 예전 인자 모양 그대로
      expect(String(only[1])).not.toContain('분할 작성');
      expect(String(only[1]).endsWith('사업계획서 작성해줘')).toBe(true);
      expect(env.bridge.aiGetDocumentContext).toHaveBeenCalledTimes(1);
    });

    it('AC-5c6d1ea3: a blank document with two empty paragraphs is not "blank" — normal path', async () => {
      await start({ paras: ['', ''] });
      await send('사업계획서 작성해줘');

      expect(calls()).toHaveLength(1);
      expect(call(0)[11]).toBeUndefined();
      expect(String(call(0)[1])).not.toContain('분할 작성');
    });

    it('AC-5c6d1ea3: an explicit short page count (<6) on a blank document takes the normal path', async () => {
      await start();
      await send('사업계획서 3쪽으로 작성해줘');

      expect(calls()).toHaveLength(1);
      expect(call(0)[11]).toBeUndefined();
      expect(String(call(0)[1])).not.toContain('분할 작성');
    });

    it('AC-5c6d1ea3: a short document type (공문) on a blank document takes the normal path', async () => {
      await start();
      await send('공문 작성해줘');

      expect(calls()).toHaveLength(1);
      expect(call(0)[11]).toBeUndefined();
      expect(String(call(0)[1])).not.toContain('분할 작성');
    });

    it('AC-5c6d1ea3: a question in 질문 mode on a blank document takes the normal ask path', async () => {
      await start();
      qa('hop-ai-mode-btn')[1].click(); // 질문
      await send('사업계획서 10쪽이면 보통 몇 자야?');

      expect(calls()).toHaveLength(1);
      expect(call(0)[11]).toBeUndefined();
      const prompt = String(call(0)[1]);
      expect(prompt).not.toContain('분할 작성');
      expect(prompt.startsWith('다음은 편집 요청이 아니라 질문입니다.')).toBe(true);
    });

    it('AC-5c6d1ea3: a long authoring request in 질문 mode switches to 편집 and is sectioned', async () => {
      await start();
      const [editBtn, askBtn] = qa('hop-ai-mode-btn');
      askBtn.click(); // 질문
      expect(askBtn.classList.contains('hop-ai-mode-active')).toBe(true);

      await send('사업계획서 작성해줘');

      expect(calls()).toHaveLength(1);
      expect(call(0)[11]).toBe(true);
      const prompt = String(call(0)[1]);
      expect(prompt).toContain('[긴 문서 분할 작성 — 1단계: 개요]');
      expect(prompt).not.toContain('다음은 편집 요청이 아니라 질문입니다.');
      // 편집 모드로 바뀌었다.
      expect(editBtn.classList.contains('hop-ai-mode-active')).toBe(true);
      expect(askBtn.classList.contains('hop-ai-mode-active')).toBe(false);
      expect(q('hop-ai-mode-trigger').querySelector('.hop-ai-dd-label')?.textContent).toBe('편집');
    });

    it('AC-5c6d1ea3: with an attachment the request takes the normal path', async () => {
      // 텍스트 파일을 패널에 끌어다 놓는다(FileReader는 파일 내용을 그대로 읽는다).
      class FakeReader {
        result: unknown = null;
        error: unknown = null;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsText(file: { content: string }) {
          this.result = file.content;
          this.onload?.();
        }
      }
      vi.stubGlobal('FileReader', FakeReader);
      await start();
      q('hop-ai-panel').dispatch('drop', {
        dataTransfer: { files: [{ type: 'text/plain', name: 'notes.txt', content: '참고 메모 내용' }] },
      });
      await flush();
      expect(qa('hop-ai-chip-label').map((c) => c.textContent)).toEqual(['notes.txt']);

      await send('사업계획서 작성해줘');

      expect(calls()).toHaveLength(1);
      const only = call(0);
      expect(only[11]).toBeUndefined();
      expect(String(only[1])).not.toContain('분할 작성');
      expect(String(only[1])).toContain('[첨부 문서: notes.txt]\n참고 메모 내용');
    });
  });

  // ─────────────────────────────────────────────────────────
  // AC-a622a229: 개요를 먼저 받아 절 목록과 진행 상태를 보인다
  // ─────────────────────────────────────────────────────────
  describe('AC-a622a229', () => {
    it('AC-a622a229: the outline shows the section list with states and the first section starts', async () => {
      await throughOutline();

      const { head, rows } = progress();
      expect(head).toBe('개요 3개 절 — 0개 작성');
      expect(rows).toEqual([
        ['run', '1. 사업 개요', '작성 중'],
        ['wait', '2. 추진 일정', '대기'],
        ['wait', '3. 기대 효과', '대기'],
      ]);
      expect(bubbleStatus()).toBe('절 1/3 작성 중 — 1. 사업 개요');
    });

    it('AC-a622a229: with skills, the outline request carries the skill catalog before the outline header', async () => {
      await start({ skills: [BIZ_SKILL] });
      await send('사업계획서 작성해줘');

      const prompt = String(call(0)[1]);
      expect(prompt.startsWith('[작성 지침 목록]')).toBe(true);
      expect(prompt).toContain(`### ${BIZ_SKILL.name} — ${BIZ_SKILL.description}\n${BIZ_SKILL.body}`);
      expect(prompt.indexOf('[긴 문서 분할 작성 — 1단계: 개요]')).toBeGreaterThan(prompt.indexOf(BIZ_SKILL.body));
      expect(call(0)[11]).toBe(true);
    });

    it('AC-a622a229: a rejected outline (native schema check failed) writes nothing', async () => {
      await start();
      await send('사업계획서 작성해줘');
      captured!.onEditFailed?.({
        requestId: env.issued[0],
        reason: '개요의 절이 너무 많습니다(21개 — 최대 20개).',
        code: 'PARSE_ERROR',
      });
      await flush();

      expect(calls()).toHaveLength(1);
      expect(env.doc.paras).toEqual(['']);
      expect(env.bridge.loadDocument).not.toHaveBeenCalled();
      expect(bubbleStatus()).toBe('개요를 받지 못해 문서를 쓰지 않았습니다.');
      expect(hidden(q('hop-ai-review'))).toBe(true);
      expect(hidden(q('hop-ai-send'))).toBe(false);
    });

    it('AC-a622a229: an unusable outline (no sections) writes nothing and leaves the document as it was', async () => {
      await start();
      await send('사업계획서 작성해줘');
      await ready({ title: '빈 개요', sections: [] });

      expect(calls()).toHaveLength(1); // 절 요청이 나가지 않는다
      expect(env.doc.paras).toEqual(['']);
      expect(bubbleStatus()).toBe('개요를 받지 못해 문서를 쓰지 않았습니다.');
      expect(hidden(q('hop-ai-review'))).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────
  // AC-d156df37: 제목을 넣고 절마다 따로 요청해 문서 끝에 이어 붙인다
  // ─────────────────────────────────────────────────────────
  describe('AC-d156df37', () => {
    it('AC-d156df37: the app writes the title into the first paragraph right after the outline', async () => {
      await throughOutline();
      expect(env.doc.paras).toEqual(['2027 신규 사업계획서']);
    });

    it('AC-d156df37: each section is its own request anchored at the current last paragraph', async () => {
      await throughOutline();

      // 1절: 제목 한 문단뿐 → p[0] 뒤에.
      expect(calls()).toHaveLength(2);
      expect(call(1)[4]).toBe('sec[0].p[0]');
      expect(call(1)[11] ?? false).toBe(false);
      expect(String(call(1)[1]).startsWith('[긴 문서 분할 작성 — 1/3번째 절]')).toBe(true);
      expect(String(call(1)[1])).toContain("'sec[0].p[0]'에 INSERT_AFTER");

      await ready(sectionScript('sec[0].p[0]', '1. 사업 개요', ['개요 본문 하나', '개요 본문 둘']));
      // 받은 즉시 문서 끝에 붙는다(다음 절 응답을 기다리지 않는다).
      expect(env.doc.paras).toEqual(['2027 신규 사업계획서', '1. 사업 개요', '개요 본문 하나', '개요 본문 둘']);

      // 2절: 문단 4개 → p[3] 뒤에.
      expect(calls()).toHaveLength(3);
      expect(call(2)[4]).toBe('sec[0].p[3]');
      expect(call(2)[11] ?? false).toBe(false);
      const second = String(call(2)[1]);
      expect(second.startsWith('[긴 문서 분할 작성 — 2/3번째 절]')).toBe(true);
      expect(second).toContain("'sec[0].p[3]'에 INSERT_AFTER");
      expect(second).toContain('✓ 1. 사업 개요\n▶ 2. 추진 일정\n· 3. 기대 효과');
      expect(second).toContain('원래 요청: 사업계획서 작성해줘');

      await ready(sectionScript('sec[0].p[3]', '2. 추진 일정', ['일정 본문']));
      expect(calls()).toHaveLength(4);
      expect(call(3)[4]).toBe('sec[0].p[5]');
      expect(String(call(3)[1]).startsWith('[긴 문서 분할 작성 — 3/3번째 절]')).toBe(true);

      await ready(sectionScript('sec[0].p[5]', '3. 기대 효과', ['효과 본문']));
      expect(calls()).toHaveLength(4); // 마지막 절 뒤에는 요청이 더 없다
      expect(env.doc.paras).toEqual([
        '2027 신규 사업계획서',
        '1. 사업 개요',
        '개요 본문 하나',
        '개요 본문 둘',
        '2. 추진 일정',
        '일정 본문',
        '3. 기대 효과',
        '효과 본문',
      ]);
    });

    it('AC-d156df37: the progress list moves run → done and the status names the current section', async () => {
      await throughOutline();
      await ready(sectionScript('sec[0].p[0]', '1. 사업 개요', ['본문']));

      expect(progress()).toEqual({
        head: '개요 3개 절 — 1개 작성',
        rows: [
          ['done', '1. 사업 개요', '완료'],
          ['run', '2. 추진 일정', '작성 중'],
          ['wait', '3. 기대 효과', '대기'],
        ],
      });
      expect(bubbleStatus()).toBe('절 2/3 작성 중 — 2. 추진 일정');

      await ready(sectionScript('sec[0].p[2]', '2. 추진 일정', ['본문']));
      await ready(sectionScript('sec[0].p[4]', '3. 기대 효과', ['본문']));
      expect(progress()).toEqual({
        head: '개요 3개 절 — 3개 작성',
        rows: [
          ['done', '1. 사업 개요', '완료'],
          ['done', '2. 추진 일정', '완료'],
          ['done', '3. 기대 효과', '완료'],
        ],
      });
    });

    it('AC-d156df37: a section whose first attempt fails is retried once at the same anchor', async () => {
      await throughOutline();
      await ready(sectionScript('sec[0].p[0]', '1. 사업 개요', ['본문']));
      expect(calls()).toHaveLength(3);

      await fail();
      // 같은 절을 한 번 더 요청한다(문서는 그대로라 같은 자리).
      expect(calls()).toHaveLength(4);
      expect(call(3)[4]).toBe('sec[0].p[2]');
      expect(String(call(3)[1]).startsWith('[긴 문서 분할 작성 — 2/3번째 절]')).toBe(true);
      expect(progress().rows[1]).toEqual(['run', '2. 추진 일정', '작성 중']);
      // 재시도 중에도 요청 중 상태(중지 버튼)다.
      expect(hidden(q('hop-ai-cancel'))).toBe(false);
      expect(hidden(q('hop-ai-send'))).toBe(true);

      await ready(sectionScript('sec[0].p[2]', '2. 추진 일정', ['일정 본문']));
      expect(progress().rows[1]).toEqual(['done', '2. 추진 일정', '완료']);
      expect(env.doc.paras.slice(3)).toEqual(['2. 추진 일정', '일정 본문']);
      // 다음 절로 넘어갔다.
      expect(calls()).toHaveLength(5);
      expect(String(call(4)[1]).startsWith('[긴 문서 분할 작성 — 3/3번째 절]')).toBe(true);
    });

    it("AC-d156df37: while a failed section is being retried the status still says '절 i/N 작성 중'", async () => {
      await throughOutline();
      await ready(sectionScript('sec[0].p[0]', '1. 사업 개요', ['본문']));
      expect(bubbleStatus()).toBe('절 2/3 작성 중 — 2. 추진 일정');

      await fail(); // 2절 1차 실패 → 재시도 요청이 나간 상태
      expect(calls()).toHaveLength(4);
      // 재시도 중에는 onFailed가 남긴 오류 문구('…다시 시도해 주세요.', tone=error)가 남지 않고
      // 진행 상태로 다시 적힌다(예전에는 오류 문구가 그대로 남았다 — 이 테스트가 잡은 결함).
      expect(bubbleStatus()).toContain('절 2/3 작성 중');
      expect(bubbleStatus()).toBe('절 2/3 작성 중 — 다시 시도 · 2. 추진 일정');
      expect(lastBubble().querySelector('.hop-ai-bubble-status')?.dataset.tone).toBe('info');

      // 재시도가 성공하면 다음 절의 진행 상태로 넘어간다.
      await ready(sectionScript('sec[0].p[2]', '2. 추진 일정', ['일정 본문']));
      expect(bubbleStatus()).toBe('절 3/3 작성 중 — 3. 기대 효과');
    });

    it('AC-d156df37: after a section is skipped, the next section prompt marks it ✗ (not written)', async () => {
      await throughOutline();
      await ready(sectionScript('sec[0].p[0]', '1. 사업 개요', ['본문']));
      // 2절 1차 요청에서는 1절이 ✓(썼음).
      expect(String(call(2)[1])).toContain(
        '전체 개요(✓ 이미 씀 · ✗ 쓰지 못함 · ▶ 지금 쓸 절):\n✓ 1. 사업 개요\n▶ 2. 추진 일정\n· 3. 기대 효과',
      );

      await fail(); // 2절 1차
      // 재시도 요청에서도 아직 건너뛴 절은 없다.
      expect(String(call(3)[1])).toContain('✓ 1. 사업 개요\n▶ 2. 추진 일정\n· 3. 기대 효과');
      await fail(); // 2절 2차 → 건너뜀

      expect(calls()).toHaveLength(5);
      const third = String(call(4)[1]);
      expect(third.startsWith('[긴 문서 분할 작성 — 3/3번째 절]')).toBe(true);
      expect(third).toContain(
        '전체 개요(✓ 이미 씀 · ✗ 쓰지 못함 · ▶ 지금 쓸 절):\n✓ 1. 사업 개요\n✗ 2. 추진 일정\n▶ 3. 기대 효과',
      );
      expect(third).not.toContain('✓ 2. 추진 일정');
    });

    it('AC-d156df37: an empty or unappliable answer also counts as a failed attempt', async () => {
      await throughOutline();
      // 1차: 편집이 없는 응답 → 재시도.
      await ready({ message: '쓸 내용이 없습니다', edits: [] });
      expect(calls()).toHaveLength(3);
      expect(String(call(2)[1]).startsWith('[긴 문서 분할 작성 — 1/3번째 절]')).toBe(true);
      // 2차: 문단이 아닌 대상만 겨눈 응답(적용 0건) → 건너뛰고 다음 절.
      await ready({ edits: [{ command: 'INSERT_AFTER', target_id: 'nowhere', payload: { text: '엉뚱한 곳' } }] });
      expect(progress().rows[0]).toEqual(['skip', '1. 사업 개요', '건너뜀']);
      expect(calls()).toHaveLength(4);
      expect(String(call(3)[1]).startsWith('[긴 문서 분할 작성 — 2/3번째 절]')).toBe(true);
      expect(env.doc.paras).toEqual(['2027 신규 사업계획서']);
    });

    it('AC-d156df37: a section that fails twice is skipped and the loop continues with the next section', async () => {
      await throughOutline();
      await ready(sectionScript('sec[0].p[0]', '1. 사업 개요', ['본문']));

      await fail(); // 2절 1차
      await fail('provider 오류'); // 2절 2차
      expect(progress()).toEqual({
        head: '개요 3개 절 — 1개 작성',
        rows: [
          ['done', '1. 사업 개요', '완료'],
          ['skip', '2. 추진 일정', '건너뜀'],
          ['run', '3. 기대 효과', '작성 중'],
        ],
      });
      // 3절은 문서 끝(1절 뒤)에 이어 붙는다.
      expect(calls()).toHaveLength(5);
      expect(call(4)[4]).toBe('sec[0].p[2]');
      expect(String(call(4)[1]).startsWith('[긴 문서 분할 작성 — 3/3번째 절]')).toBe(true);

      await ready(sectionScript('sec[0].p[2]', '3. 기대 효과', ['효과 본문']));
      expect(env.doc.paras).toEqual(['2027 신규 사업계획서', '1. 사업 개요', '본문', '3. 기대 효과', '효과 본문']);
      expect(lastBubble().querySelector('.hop-ai-msg-text')?.textContent).toBe(
        "세 개 절로 구성했습니다. '2027 신규 사업계획서'를 3개 절 중 2개 써서 넣었습니다 (1개 절은 쓰지 못해 건너뜀).",
      );
    });

    it('AC-d156df37: when the outline picks a known skill, every section prompt starts with that skill', async () => {
      await throughOutline({ ...OUTLINE, skill: '사업계획서' }, { skills: [BIZ_SKILL] });

      const skillHead = `[작성 스킬: 사업계획서]\n${BIZ_SKILL.body}\n\n---\n\n[긴 문서 분할 작성 — 1/3번째 절]`;
      expect(String(call(1)[1]).startsWith(skillHead)).toBe(true);
      await ready(sectionScript('sec[0].p[0]', '1. 사업 개요', ['본문']));
      expect(String(call(2)[1]).startsWith(`[작성 스킬: 사업계획서]\n${BIZ_SKILL.body}\n\n---\n\n[긴 문서 분할 작성 — 2/3번째 절]`)).toBe(
        true,
      );
      // 답변에 따른 지침이 표시된다.
      expect(lastBubble().querySelector('.hop-ai-skill-chip-label')?.textContent).toBe('지침: 사업계획서 · AI 선택');
    });

    it('AC-d156df37: when the outline names an unknown skill, section prompts carry no skill prefix', async () => {
      await throughOutline({ ...OUTLINE, skill: '없는 지침' }, { skills: [BIZ_SKILL] });

      expect(String(call(1)[1]).startsWith('[긴 문서 분할 작성 — 1/3번째 절]')).toBe(true);
      expect(String(call(1)[1])).not.toContain('[작성 스킬:');
      expect(lastBubble().querySelector('.hop-ai-skill-chip-label')).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────
  // AC-8cc6b557: 끝나면(또는 멈추면) 스냅샷 기준으로 한 번에 검토
  // ─────────────────────────────────────────────────────────
  describe('AC-8cc6b557', () => {
    it('AC-8cc6b557: after all sections, one all-or-nothing review covers every edit including the title', async () => {
      await writeAllThree();

      expect(env.bridge.aiRequestEdit).toHaveBeenCalledTimes(4); // 개요 1 + 절 3
      expect(hidden(q('hop-ai-review'))).toBe(false);
      expect(q('hop-ai-review-label').textContent).toBe('변경 8건 검토 중');
      // 변경별 승인/거절은 없다(모두 승인·모두 거절만).
      expect(qa('hop-ai-diff-drop')).toHaveLength(0);
      expect(qa('hop-ai-diff-keep')).toHaveLength(0);
      expect(qa('hop-ai-diff-item')).toHaveLength(8);
      expect(bubbleStatus()).toBe('3개 절을 미리 넣었습니다 — 모두 승인 또는 모두 거절하세요.');
      // 요청은 끝났다 — 보내기 버튼이 돌아온다.
      expect(hidden(q('hop-ai-cancel'))).toBe(true);
      expect(hidden(q('hop-ai-send'))).toBe(false);
    });

    it('AC-8cc6b557: the on-document review marks every written paragraph but offers no per-change buttons', async () => {
      await writeAllThree({ canvas: true });

      // 제목 + 1절 3문단 + 2절 2문단 + 3절 2문단 = 8문단이 초록으로 칠해진다.
      expect(scrollContent.querySelectorAll('.hop-ai-inline-mark')).toHaveLength(8);
      expect(scrollContent.querySelectorAll('.hop-ai-inline-mini')).toHaveLength(0);
      const bar = fakeDoc.body.querySelector('.hop-ai-inline-bar');
      expect(bar).not.toBeNull();
      expect(hidden(bar!.querySelector('.hop-ai-inline-one')!)).toBe(true);
      expect(bar!.querySelector('.hop-ai-inline-accept')?.textContent).toBe('모두 승인');
      expect(bar!.querySelector('.hop-ai-inline-reject')?.textContent).toBe('모두 거절');
    });

    it('AC-8cc6b557: (contrast) a normal multi-edit answer in the same harness does offer per-change controls', async () => {
      // 위 두 테스트의 '0개'가 하네스 탓이 아님을 보인다 — 일반 요청은 변경별 ✗/✓를 단다.
      await start({ paras: ['첫 문단', '둘째 문단'], canvas: true });
      await send('두 문단을 다듬어줘');
      await ready({
        edits: [
          { command: 'REPLACE', target_id: 'sec[0].p[0]', payload: { text: '다듬은 첫 문단' } },
          { command: 'REPLACE', target_id: 'sec[0].p[1]', payload: { text: '다듬은 둘째 문단' } },
        ],
      });

      expect(env.doc.paras).toEqual(['다듬은 첫 문단', '다듬은 둘째 문단']);
      expect(qa('hop-ai-diff-drop')).toHaveLength(2);
      expect(scrollContent.querySelectorAll('.hop-ai-inline-mini')).toHaveLength(2);
      expect(q('hop-ai-review-label').textContent).toBe('변경 2건 검토 중');
    });

    it('AC-8cc6b557: accepting keeps the written document as is', async () => {
      await writeAllThree();
      const written = [...env.doc.paras];

      q('hop-ai-review-accept').click();
      await flush();

      expect(env.bridge.loadDocument).not.toHaveBeenCalled();
      expect(env.doc.paras).toEqual(written);
      expect(env.bridge.markDocumentDirty).toHaveBeenCalledTimes(1);
      expect(hidden(q('hop-ai-review'))).toBe(true);
      expect(bubbleStatus()).toBe('적용 완료: 8건');
    });

    it('AC-8cc6b557: rejecting restores the snapshot taken before the outline', async () => {
      await writeAllThree();
      const snapshot = env.bridge.exportHwp.mock.results[0].value as Uint8Array;
      expect(env.bridge.exportHwp).toHaveBeenCalledTimes(1);

      q('hop-ai-review-reject').click();
      await flush();

      expect(env.bridge.loadDocument).toHaveBeenCalledTimes(1);
      expect(env.bridge.loadDocument).toHaveBeenCalledWith(snapshot, 'plan.hwp');
      expect(env.doc.paras).toEqual(['']);
      expect(hidden(q('hop-ai-review'))).toBe(true);
    });

    it('AC-8cc6b557: when no section could be written, the document goes back to the snapshot and nothing is reviewed', async () => {
      await throughOutline({
        title: '2027 신규 사업계획서',
        sections: OUTLINE.sections.slice(0, 2),
      });
      // 제목은 이미 들어갔다.
      expect(env.doc.paras).toEqual(['2027 신규 사업계획서']);
      const snapshot = env.bridge.exportHwp.mock.results[0].value as Uint8Array;

      await fail(); // 1절 1차
      await ready('응답이 JSON이 아님'); // 1절 2차 — 파싱 실패
      await fail(); // 2절 1차
      await ready({ edits: [] }); // 2절 2차 — 빈 응답

      expect(calls()).toHaveLength(5);
      expect(env.bridge.loadDocument).toHaveBeenCalledTimes(1);
      expect(env.bridge.loadDocument).toHaveBeenCalledWith(snapshot, 'plan.hwp');
      expect(env.doc.paras).toEqual(['']);
      expect(hidden(q('hop-ai-review'))).toBe(true);
      expect(qa('hop-ai-diff-item')).toHaveLength(0);
      expect(lastBubble().querySelector('.hop-ai-msg-text')?.textContent).toBe(
        '절을 하나도 쓰지 못해 문서를 바꾸지 않았습니다.',
      );
      expect(progress().rows.map((r) => r[0])).toEqual(['skip', 'skip']);
    });

    it('AC-8cc6b557: stopping during section 2 sends no more requests and reviews the title + section 1', async () => {
      await throughOutline();
      await ready(sectionScript('sec[0].p[0]', '1. 사업 개요', ['개요 본문']));
      expect(calls()).toHaveLength(3); // 2절 요청 중

      q('hop-ai-cancel').click();
      await flush();

      expect(env.bridge.aiCancelRequest).toHaveBeenCalledWith('req-3');
      expect(calls()).toHaveLength(3); // 재시도도, 3절 요청도 없다
      expect(env.doc.paras).toEqual(['2027 신규 사업계획서', '1. 사업 개요', '개요 본문']);
      expect(hidden(q('hop-ai-review'))).toBe(false);
      expect(q('hop-ai-review-label').textContent).toBe('변경 3건 검토 중');
      expect(qa('hop-ai-diff-drop')).toHaveLength(0);
      expect(progress().rows.map((r) => r[0])).toEqual(['done', 'wait', 'wait']);
      expect(lastBubble().querySelector('.hop-ai-msg-text')?.textContent).toBe(
        "세 개 절로 구성했습니다. '2027 신규 사업계획서'를 3개 절 중 1개 써서 넣었습니다 — 중간에 멈춰 나머지 절은 쓰지 않았습니다.",
      );

      // 멈춘 뒤 거절하면 시작 전 문서로 돌아간다.
      q('hop-ai-review-reject').click();
      await flush();
      expect(env.bridge.loadDocument).toHaveBeenCalledWith(env.bridge.exportHwp.mock.results[0].value, 'plan.hwp');
      expect(env.doc.paras).toEqual(['']);
    });

    it('AC-8cc6b557: stopping before any section is written leaves the document unchanged', async () => {
      await throughOutline();
      expect(env.doc.paras).toEqual(['2027 신규 사업계획서']);

      q('hop-ai-cancel').click(); // 1절 요청 중
      await flush();

      expect(calls()).toHaveLength(2);
      expect(env.doc.paras).toEqual(['']);
      expect(hidden(q('hop-ai-review'))).toBe(true);
      expect(lastBubble().querySelector('.hop-ai-msg-text')?.textContent).toBe(
        '멈췄습니다 — 쓴 절이 없어 문서를 바꾸지 않았습니다.',
      );
    });
  });
});
