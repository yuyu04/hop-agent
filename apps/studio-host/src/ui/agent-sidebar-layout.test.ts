import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiEventHandlers } from '@/core/ai-bridge';
import indexHtml from '../../index.html?raw';

/**
 * F-15098e10 — AI 패널이 커서 채팅처럼 보이고 동작한다.
 *
 * 각 테스트는 AC 하나의 "동작"을 검증한다: 이벤트를 흘려보내고(입력·클릭·키·AI 응답)
 * 그 결과 상태(숨김/표시, 라벨 문구, 브리지 호출 인자, 클래스)를 정확한 값으로 단언한다.
 * DOM은 아래 FakeElement가 실제 DOM 의미(className↔classList 동기화, textContent는
 * 자손 글자 합, 이벤트 버블링, closest/matches, select.value)를 흉내 낸다.
 */

/**
 * CSS 원문. vitest는 기본 설정(css: false)에서 `.css?raw` 가져오기까지 빈 문자열로 바꾸므로
 * (vitest:css-disable 플러그인) Node 내장 fs로 직접 읽는다 — @types/node 없이 타입을 좁혀 쓴다.
 */
const nodeFs = (
  globalThis as unknown as {
    process: { getBuiltinModule(id: 'node:fs'): { readFileSync(path: URL, encoding: 'utf8'): string } };
  }
).process.getBuiltinModule('node:fs');
const css = nodeFs.readFileSync(new URL('../styles/agent-sidebar.css', import.meta.url), 'utf8');
const baseCss = nodeFs.readFileSync(
  new URL('../../../../third_party/rhwp/rhwp-studio/src/styles/base.css', import.meta.url),
  'utf8',
);

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
import { AI_PANEL_TOGGLE_EVENT, aiCommands } from '@/command/commands/ai';

// ── 가짜 DOM ───────────────────────────────────────────────────

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

  // className ↔ classList는 실제 DOM처럼 같은 토큰 목록을 본다.
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

  // textContent는 자기 글자 + 자손 글자(실제 DOM과 같은 합). 설정하면 자식이 사라진다.
  get textContent(): string {
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  set textContent(value: string | null) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.ownText = value ?? '';
  }

  // <select>는 명시 값이 옵션에 있으면 그것, 아니면 첫 옵션 값을 돌려준다.
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

  /** 문서 수준 리스너(사이드바가 캡처 단계에 붙인 것 포함)만 부른다. */
  fire(type: string, init: Partial<FakeEvent> = {}): FakeEvent {
    const event = makeEvent(type, init);
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
    return event;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.body.querySelectorAll(selector);
  }

  querySelector(selector: string): FakeElement | null {
    return this.body.querySelector(selector);
  }
}

// ── 공통 데이터 ─────────────────────────────────────────────────

const CONTEXT = {
  document_metadata: { total_sections: 1 },
  content: [{ type: 'paragraph', id: 'sec[0].p[0]', text: '원문' }],
};

const TWO_EDIT_SCRIPT = {
  edits: [
    { command: 'REPLACE', target_id: 'sec[0].p[0]', payload: { type: 'paragraph', text: '첫째 수정' } },
    { command: 'REPLACE', target_id: 'sec[0].p[1]', payload: { type: 'paragraph', text: '둘째 수정' } },
  ],
};

const ONE_EDIT_SCRIPT = {
  edits: [{ command: 'REPLACE', target_id: 'sec[0].p[0]', payload: { type: 'paragraph', text: '새 문단' } }],
};

const GRAMMAR_PRESET =
  '선택한 부분(선택이 없으면 현재 문단)의 맞춤법·문법·어색한 표현만 교정하고 내용은 그대로 둬.';
const SUMMARIZE_PRESET = '이 문서(선택 영역이 있으면 그 부분)의 핵심을 요약해줘.';
const ASK_PREFIX =
  '다음은 편집 요청이 아니라 질문입니다. 문서를 절대 수정하지 말고(edits는 반드시 빈 배열 []) message에만 한국어로 답하거나 요약하세요.\n\n';
const REPORT_PREFILL = '다음 주제로 보고서 초안을 써줘 — 제목, 개요, 본문(소제목별), 결론 순서로: ';

/** 이모지(그림 문자)와 예전 패널이 쓰던 글자 기호. */
const GLYPHS = /[🕘⋯✓✗⟳＋×]|\p{Extended_Pictographic}/u;

async function flush(): Promise<void> {
  for (let i = 0; i < 32; i += 1) await Promise.resolve();
}

function createBridge() {
  return {
    aiGetDocumentContext: vi.fn(async (..._args: unknown[]) => CONTEXT as unknown),
    aiRequestEdit: vi.fn(async (..._args: unknown[]) => 'req-1'),
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
    getParagraphLength: vi.fn(() => 2),
    insertText: vi.fn(() => ''),
    deleteText: vi.fn(() => ''),
    splitParagraph: vi.fn(() => ''),
    mergeParagraph: vi.fn(() => ''),
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
    aiParseResearchNoteDocx: vi.fn(async () => {
      throw new Error('연구노트 구조 아님');
    }),
    aiParseResearchNotePdf: vi.fn(async () => {
      throw new Error('연구노트 구조 아님');
    }),
  };
}

/** 이벤트 버스 — emit은 실제로 on 구독자에게 전달된다(명령 → 패널 토글 경로 검증용). */
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

// ── CSS 도우미 ─────────────────────────────────────────────────

interface CssRule {
  selectors: string[];
  body: string;
}

/** 가장 안쪽 규칙(선택자 { 선언 })을 모두 뽑는다. @media 안 규칙도 포함된다. */
function parseCss(source: string): CssRule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = m[1]
      .split(',')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    rules.push({ selectors, body: m[2] });
  }
  return rules;
}

function declarations(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of body.split(';')) {
    const idx = part.indexOf(':');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) map.set(name, value);
  }
  return map;
}

/** 선택자 하나가 정확히 일치하는 모든 규칙의 선언을 합친다. */
function declsFor(rules: CssRule[], selector: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of rules) {
    if (!rule.selectors.includes(selector)) continue;
    for (const [k, v] of declarations(rule.body)) merged.set(k, v);
  }
  return merged;
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const COLOR_PROPS =
  /^(color|background|background-color|border|border-color|border-(?:top|right|bottom|left)(?:-color)?|outline|outline-color|box-shadow|fill|stroke|text-decoration-color|caret-color)$/;

// ── 테스트 ─────────────────────────────────────────────────────

describe('F-15098e10: AI 패널 커서 레이아웃', () => {
  let doc: FakeDocument;
  let bridge: ReturnType<typeof createBridge>;
  let bus: ReturnType<typeof createBus>;
  let scrollContent: FakeElement;
  let scrollContainer: FakeElement;
  let sidebar: AgentSidebar | null;

  function build(opts: { canvas?: boolean } = {}): AgentSidebar {
    scrollContent = new FakeElement('div');
    scrollContainer = new FakeElement('div');
    const canvasView = {
      getVirtualScroll: () => ({ getPageOffset: () => 0 }),
      getViewportManager: () => ({ getZoom: () => 1 }),
    };
    const deps = {
      bridge,
      eventBus: bus,
      getCanvasView: () => (opts.canvas ? canvasView : null),
      scrollContent,
      scrollContainer,
    };
    sidebar = new AgentSidebar(deps as unknown as AgentSidebarDeps);
    return sidebar;
  }

  function q(cls: string): FakeElement {
    const node = doc.body.querySelector(`.${cls}`);
    if (!node) throw new Error(`missing element: .${cls}`);
    return node;
  }

  function qa(cls: string): FakeElement[] {
    return doc.body.querySelectorAll(`.${cls}`);
  }

  function hidden(node: FakeElement): boolean {
    return node.classList.contains('hop-ai-hidden');
  }

  function label(node: FakeElement): string {
    return node.querySelector('.hop-ai-pop-label')?.textContent ?? '';
  }

  function prompt(): FakeElement {
    return q('hop-ai-prompt');
  }

  async function selectProvider(id: string): Promise<void> {
    const select = q('hop-ai-provider');
    select.value = id;
    select.dispatch('change');
    await flush();
  }

  async function send(text: string): Promise<void> {
    prompt().value = text;
    q('hop-ai-send').click();
    await flush();
  }

  async function ready(script: unknown): Promise<void> {
    captured!.onEditReady?.({ requestId: 'req-1', actionScriptJson: JSON.stringify(script) });
    await flush();
  }

  /** 미리 적용(낙관적) 경로를 켠다 — 스냅샷 export/load를 지원하는 데스크톱 브리지. */
  function enableSnapshot() {
    const snapshotBytes = new Uint8Array([7, 7, 7]);
    const extra = bridge as unknown as Record<string, unknown>;
    const exportHwp = vi.fn(() => snapshotBytes);
    const loadDocument = vi.fn();
    extra.getSourceFormat = vi.fn(() => 'hwp');
    extra.exportHwp = exportHwp;
    extra.loadDocument = loadDocument;
    extra.fileName = 'doc.hwp';
    return { snapshotBytes, exportHwp, loadDocument };
  }

  function key(target: FakeElement, init: Partial<FakeEvent>): FakeEvent {
    return target.dispatch('keydown', init);
  }

  function slashChips(): FakeElement[] {
    return qa('hop-ai-quick-chip');
  }

  function visibleSlashLabels(): string[] {
    return slashChips()
      .filter((c) => !hidden(c))
      .map(label);
  }

  function bubbleStatus(): string {
    const all = qa('hop-ai-bubble-status');
    return all[all.length - 1]?.textContent ?? '';
  }

  beforeEach(() => {
    captured = null;
    sidebar = null;
    doc = new FakeDocument();
    (globalThis as Record<string, unknown>).document = doc;
    bridge = createBridge();
    bus = createBus();
  });

  afterEach(() => {
    sidebar?.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).document;
  });

  // ─────────────────────────────────────────────────────────
  // AC-a0e24ea5: 앱 테마 토큰에서 색을 가져온다
  // ─────────────────────────────────────────────────────────
  describe('AC-a0e24ea5', () => {
    const rules = parseCss(css);
    const baseRules = parseCss(baseCss);
    const tokenRule = rules.find(
      (r) => r.selectors.includes('.hop-ai-panel') && declarations(r.body).has('--hop-ai-bg'),
    );
    const tokens = declarations(tokenRule?.body ?? '');
    const lightApp = declsFor(baseRules, ':root');
    const darkApp = declsFor(baseRules, ':root[data-theme-effective="dark"]');

    it('AC-a0e24ea5: the panel token block maps surface/text/line/interaction tokens to app --ui-* tokens', () => {
      expect(tokenRule).toBeDefined();
      // 패널과 문서 위 검토 요소가 같은 토큰 묶음을 받는다.
      expect(tokenRule!.selectors).toEqual([
        '.hop-ai-panel',
        '.hop-ai-inline-bar',
        '.hop-ai-inline-mini',
        '.hop-ai-inline-card',
        '.hop-ai-inline-mark',
        '.hop-ai-inline-changebar',
      ]);
      const mapped = {
        '--hop-ai-bg': 'var(--ui-bg-light)',
        '--hop-ai-surface': 'var(--ui-surface)',
        '--hop-ai-sunken': 'var(--ui-surface-raised)',
        '--hop-ai-ink': 'var(--ui-text)',
        '--hop-ai-ink-2': 'var(--ui-text-secondary)',
        '--hop-ai-muted': 'var(--ui-text-muted)',
        '--hop-ai-hint': 'var(--ui-text-hint)',
        '--hop-ai-line': 'var(--ui-border-subtle)',
        '--hop-ai-line-strong': 'var(--ui-border-light)',
        '--hop-ai-hover': 'var(--ui-hover)',
        '--hop-ai-selected': 'var(--ui-selected)',
        '--hop-ai-focus': 'var(--focus-ring)',
        '--hop-ai-btn': 'var(--ui-text)',
        '--hop-ai-btn-ink': 'var(--ui-surface)',
      };
      for (const [token, value] of Object.entries(mapped)) {
        expect([token, tokens.get(token)]).toEqual([token, value]);
      }
    });

    it('AC-a0e24ea5: every app token the panel reads is defined for both light and dark app themes', () => {
      const referenced = new Set<string>();
      for (const value of tokens.values()) {
        for (const m of value.matchAll(/var\((--[\w-]+)\)/g)) referenced.add(m[1]);
      }
      // 컴포넌트 규칙이 토큰 묶음을 거치지 않고 직접 읽는 앱 토큰도 포함한다.
      for (const rule of rules) {
        for (const m of rule.body.matchAll(/var\((--(?:ui|color|focus|accent)[\w-]*)\)/g)) referenced.add(m[1]);
      }
      expect(referenced.size).toBeGreaterThanOrEqual(12);
      const missing = [...referenced].filter((t) => !lightApp.has(t) || !darkApp.has(t));
      expect(missing).toEqual([]);
    });

    it('AC-a0e24ea5: hex literals in the token block are only the doc-paper tokens and the light semantic add/del/mod tokens', () => {
      const hexTokens = [...tokens.entries()].filter(([, v]) => /#[0-9a-fA-F]{3,8}\b/.test(v)).map(([k]) => k);
      const semantic = ['--hop-ai-add-ink', '--hop-ai-add-bg', '--hop-ai-del-ink', '--hop-ai-del-bg', '--hop-ai-mod-ink'];
      const unexpected = hexTokens.filter((k) => !k.startsWith('--hop-ai-doc-') && !semantic.includes(k));
      expect(unexpected).toEqual([]);
      for (const name of semantic) expect(hexTokens).toContain(name);
    });

    it("AC-a0e24ea5: a :root[data-theme-effective='dark'] block redefines every light semantic token with a different value", () => {
      const darkRule = rules.find((r) =>
        r.selectors.includes(":root[data-theme-effective='dark'] .hop-ai-panel"),
      );
      expect(darkRule).toBeDefined();
      expect(darkRule!.selectors).toEqual([
        ":root[data-theme-effective='dark'] .hop-ai-panel",
        ":root[data-theme-effective='dark'] .hop-ai-inline-bar",
        ":root[data-theme-effective='dark'] .hop-ai-inline-mini",
      ]);
      const dark = declarations(darkRule!.body);
      for (const name of ['--hop-ai-add-ink', '--hop-ai-add-bg', '--hop-ai-del-ink', '--hop-ai-del-bg', '--hop-ai-mod-ink']) {
        expect(dark.get(name)).toMatch(/^#[0-9a-f]{6}$/i);
        expect(dark.get(name)).not.toBe(tokens.get(name));
      }
    });

    it('AC-a0e24ea5: --hop-ai-width lives on :root so body.hop-ai-open #studio-root can shrink by it', () => {
      const rootWidth = declsFor(rules, ':root').get('--hop-ai-width');
      expect(rootWidth).toBe('440px');
      // 패널 범위에만 두면 #studio-root에서 var()가 비어 문서 영역이 줄지 않는다(회귀).
      expect(tokens.has('--hop-ai-width')).toBe(false);
      expect(declsFor(rules, 'body.hop-ai-open #studio-root').get('width')).toBe(
        'calc(100vw - var(--hop-ai-width))',
      );
      expect(declsFor(rules, '.hop-ai-panel').get('width')).toBe('var(--hop-ai-width)');
    });

    it('AC-a0e24ea5: panel component rules (.hop-ai-panel/composer-card/review/diff/pop) use theme tokens and contain no hex literals', () => {
      const component = /\.hop-ai-(panel|composer-card|review|diff|pop)\b/;
      const checked = rules.filter(
        (r) => r !== tokenRule && r.selectors.some((s) => component.test(s) && !s.startsWith(':root')),
      );
      expect(checked.length).toBeGreaterThan(40);
      const offenders: string[] = [];
      let tokenUses = 0;
      for (const rule of checked) {
        const where = rule.selectors.join(', ');
        if (rule.body.match(HEX)) offenders.push(`${where}: hex ${rule.body.match(HEX)!.join(' ')}`);
        for (const [prop, value] of declarations(rule.body)) {
          if (!COLOR_PROPS.test(prop)) continue;
          if (/rgba?\(|hsla?\(/.test(value)) offenders.push(`${where}: ${prop} literal ${value}`);
          for (const m of value.matchAll(/var\((--[\w-]+)/g)) {
            const name = m[1];
            if (name.startsWith('--hop-ai-')) tokenUses += 1;
            else if (!(lightApp.has(name) && darkApp.has(name))) offenders.push(`${where}: ${prop} uses ${name}`);
          }
        }
      }
      expect(offenders).toEqual([]);
      expect(tokenUses).toBeGreaterThan(40);
      // 대표 표면 — 패널 바탕·글자·선은 토큰을 거친다.
      const panel = declsFor(rules, '.hop-ai-panel');
      expect(panel.get('background')).toBe('var(--hop-ai-bg)');
      expect(panel.get('color')).toBe('var(--hop-ai-ink)');
      expect(panel.get('border-left')).toBe('1px solid var(--hop-ai-line)');
    });

    it('AC-a0e24ea5: outside the token blocks, hex literals appear only in the allowed exception rules', () => {
      const allowed = new Set([
        // 디버그 로그 패널(어두운 고정 콘솔).
        '.hop-ai-log',
        '.hop-ai-log-clear',
        // 흰 종이 위 표시(종이 색은 다크에서도 고정) — 토큰 대신 리터럴인 두 곳.
        '.hop-ai-inline-after',
        '.hop-ai-inline-mini-accept:hover',
      ]);
      const offenders: string[] = [];
      for (const rule of rules) {
        if (rule === tokenRule) continue;
        if (rule.selectors.every((s) => s.startsWith(":root[data-theme-effective='dark']"))) continue;
        const hex = rule.body.match(HEX);
        if (!hex) continue;
        if (rule.selectors.every((s) => allowed.has(s))) continue;
        offenders.push(`${rule.selectors.join(', ')} → ${hex.join(' ')}`);
      }
      expect(offenders).toEqual([]);
      // 교정 점프 깜빡임은 리터럴 rgba(테마 무관 강조)지만 hex는 아니다.
      expect(declsFor(rules, '.hop-ai-proofread-flash').get('background')).toMatch(/^rgba\(/);
    });
  });

  // ─────────────────────────────────────────────────────────
  // AC-c20c4990: 헤더 한 줄 + SVG 선 아이콘
  // ─────────────────────────────────────────────────────────
  describe('AC-c20c4990', () => {
    it('AC-c20c4990: the header row is [title][tabs][new chat][history][menu][close] and each button is an SVG icon', async () => {
      // 단축키 표기는 실행 플랫폼을 따른다(macOS ⌘J / 그 밖 Ctrl+J) — CI(Linux)와 맥에서 같게 돌도록 고정한다.
      vi.stubGlobal('navigator', { platform: 'MacIntel' });
      build();
      await flush();
      const header = q('hop-ai-header');
      expect(header.children.map((c) => c.className)).toEqual([
        'hop-ai-title',
        'hop-ai-tabbar',
        'hop-ai-newchat',
        'hop-ai-history-btn',
        'hop-ai-settings-btn',
        'hop-ai-close',
      ]);
      expect(q('hop-ai-tabbar').getAttribute('role')).toBe('tablist');
      const names: Record<string, string> = {
        'hop-ai-newchat': '새 대화',
        'hop-ai-history-btn': '대화 기록',
        'hop-ai-settings-btn': '메뉴 (대화 · 로그 · Agent 설정)',
        'hop-ai-close': '패널 닫기 (⌘J)',
      };
      for (const [cls, name] of Object.entries(names)) {
        const button = q(cls);
        expect(button.tagName).toBe('BUTTON');
        expect(button.getAttribute('aria-label')).toBe(name);
        expect(button.children).toHaveLength(1);
        const ic = button.children[0];
        expect(ic.classList.contains('hop-ai-ic')).toBe(true);
        expect(ic.getAttribute('aria-hidden')).toBe('true');
        expect(ic.innerHTML.startsWith('<svg')).toBe(true);
        expect(ic.innerHTML).toMatch(/<(path|circle|rect)\b[^>]*\/>.*<\/svg>$/);
        // 아이콘만 있는 버튼 — 글자 기호를 버튼 글자로 쓰지 않는다.
        expect(button.textContent).toBe('');
      }
      vi.unstubAllGlobals();
    });

    it('AC-c20c4990: the close button names the Ctrl+J shortcut on non-mac platforms', async () => {
      vi.stubGlobal('navigator', { platform: 'Win32' });
      build();
      await flush();
      expect(q('hop-ai-close').getAttribute('aria-label')).toBe('패널 닫기 (Ctrl+J)');
      vi.unstubAllGlobals();
    });

    it('AC-c20c4990: no panel button text uses emoji or glyph symbols, in idle, proposal and open-menu states', async () => {
      enableSnapshot();
      build({ canvas: true });
      await flush();
      const panel = q('hop-ai-panel');
      const offenders = (): string[] =>
        panel
          .querySelectorAll('button')
          .filter((b) => GLYPHS.test(b.textContent))
          .map((b) => `${b.className}: ${b.textContent}`);
      expect(offenders()).toEqual([]);

      await selectProvider('ollama');
      await send('바꿔줘');
      await ready(TWO_EDIT_SCRIPT);
      q('hop-ai-model-trigger').click();
      q('hop-ai-settings-btn').click();
      prompt().value = '/';
      prompt().dispatch('input');
      expect(panel.querySelectorAll('button').length).toBeGreaterThan(40);
      expect(offenders()).toEqual([]);
      // 모든 아이콘 칸은 내장 SVG다(비어 있는 자리표시는 내용이 없다).
      for (const ic of panel.querySelectorAll('.hop-ai-ic')) {
        expect(ic.innerHTML === '' || ic.innerHTML.startsWith('<svg')).toBe(true);
      }
    });

    it('AC-c20c4990: header buttons work — new chat adds an active tab, history opens the drawer, menu opens, close closes', async () => {
      build();
      await flush();
      expect(qa('hop-ai-tab').map((t) => t.textContent)).toEqual(['새 대화']);
      q('hop-ai-newchat').click();
      const tabs = qa('hop-ai-tab');
      expect(tabs).toHaveLength(2);
      expect(tabs.map((t) => t.classList.contains('hop-ai-tab-active'))).toEqual([false, true]);
      expect(tabs.every((t) => t.parentNode === q('hop-ai-tabbar'))).toBe(true);

      expect(hidden(q('hop-ai-history'))).toBe(true);
      q('hop-ai-history-btn').click();
      expect(hidden(q('hop-ai-history'))).toBe(false);

      expect(hidden(q('hop-ai-menu'))).toBe(true);
      q('hop-ai-settings-btn').click();
      expect(hidden(q('hop-ai-menu'))).toBe(false);

      sidebar!.toggle(true);
      expect(q('hop-ai-panel').classList.contains('open')).toBe(true);
      q('hop-ai-close').click();
      expect(q('hop-ai-panel').classList.contains('open')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────
  // AC-7b26a7fa: '/' 빠른 작업 메뉴
  // ─────────────────────────────────────────────────────────
  describe('AC-7b26a7fa', () => {
    const ALL = ['간결하게', '격식 있게', '길게', '문법 교정', '변형 제안', '전체 교정', '요약', '양식 항목 추가'];

    it('AC-7b26a7fa: typing "/" opens the menu listing all 8 quick actions with the first highlighted', async () => {
      build();
      await flush();
      const slash = q('hop-ai-slash');
      expect(hidden(slash)).toBe(true);
      prompt().value = '/';
      prompt().dispatch('input');
      expect(hidden(slash)).toBe(false);
      expect(slash.classList.contains('hop-ai-slash-filtered')).toBe(false);
      expect(visibleSlashLabels()).toEqual(ALL);
      expect(slashChips().map((c) => c.classList.contains('hop-ai-pop-item-active'))).toEqual([
        true, false, false, false, false, false, false, false,
      ]);
      // '/' 가 맨 앞이 아니면 열리지 않는다.
      prompt().value = '문단 /';
      prompt().dispatch('input');
      expect(hidden(slash)).toBe(true);
    });

    it('AC-7b26a7fa: typing "/교정" filters to 문법 교정 (alias 교정) and 전체 교정 (label contains 교정), "/요약" to 요약 only', async () => {
      build();
      await flush();
      prompt().value = '/교정';
      prompt().dispatch('input');
      expect(visibleSlashLabels()).toEqual(['문법 교정', '전체 교정']);
      expect(q('hop-ai-slash').classList.contains('hop-ai-slash-filtered')).toBe(true);
      prompt().value = '/요약';
      prompt().dispatch('input');
      expect(visibleSlashLabels()).toEqual(['요약']);
      prompt().value = '/양식';
      prompt().dispatch('input');
      expect(visibleSlashLabels()).toEqual(['양식 항목 추가']);
    });

    it('AC-7b26a7fa: Enter on "/교정" runs 문법 교정 with the preset text, replacing the "/교정" text', async () => {
      build();
      await flush();
      await selectProvider('ollama');
      prompt().value = '/교정';
      prompt().dispatch('input');
      const ev = key(prompt(), { key: 'Enter' });
      expect(ev.defaultPrevented).toBe(true);
      expect(hidden(q('hop-ai-slash'))).toBe(true);
      await flush();
      expect(bridge.aiRequestEdit).toHaveBeenCalledTimes(1);
      expect(bridge.aiRequestEdit.mock.calls[0][1]).toBe(GRAMMAR_PRESET);
      expect(bridge.aiRequestEdit.mock.calls[0][2]).toBe('ollama');
      expect(prompt().value).toBe('');
    });

    it('AC-7b26a7fa: ArrowDown moves the highlight (ArrowUp wraps) and Enter runs the highlighted action', async () => {
      build();
      await flush();
      await selectProvider('ollama');
      prompt().value = '/';
      prompt().dispatch('input');
      const active = () => slashChips().filter((c) => c.classList.contains('hop-ai-pop-item-active')).map(label);
      key(prompt(), { key: 'ArrowUp' });
      expect(active()).toEqual(['양식 항목 추가']);
      key(prompt(), { key: 'ArrowDown' });
      expect(active()).toEqual(['간결하게']);
      for (let i = 0; i < 3; i += 1) key(prompt(), { key: 'ArrowDown' });
      expect(active()).toEqual(['문법 교정']);
      key(prompt(), { key: 'Enter' });
      await flush();
      expect(bridge.aiRequestEdit).toHaveBeenCalledTimes(1);
      expect(bridge.aiRequestEdit.mock.calls[0][1]).toBe(GRAMMAR_PRESET);
    });

    it('AC-7b26a7fa: clicking a menu item runs it (요약 → ask-mode request) and clears the "/" text', async () => {
      build();
      await flush();
      await selectProvider('ollama');
      prompt().value = '/';
      prompt().dispatch('input');
      slashChips().find((c) => label(c) === '요약')!.click();
      expect(hidden(q('hop-ai-slash'))).toBe(true);
      await flush();
      expect(bridge.aiRequestEdit).toHaveBeenCalledTimes(1);
      expect(bridge.aiRequestEdit.mock.calls[0][1]).toBe(`${ASK_PREFIX}${SUMMARIZE_PRESET}`);
      expect(q('hop-ai-mode-trigger').querySelector('.hop-ai-dd-label')?.textContent).toBe('질문');
    });

    it('AC-7b26a7fa: Escape closes the menu (keeping the text) and a space after the command closes it', async () => {
      build();
      await flush();
      prompt().value = '/교';
      prompt().dispatch('input');
      expect(hidden(q('hop-ai-slash'))).toBe(false);
      const ev = key(prompt(), { key: 'Escape' });
      expect(ev.defaultPrevented).toBe(true);
      expect(hidden(q('hop-ai-slash'))).toBe(true);
      expect(prompt().value).toBe('/교');
      expect(bridge.aiRequestEdit).not.toHaveBeenCalled();

      prompt().value = '/교정';
      prompt().dispatch('input');
      expect(hidden(q('hop-ai-slash'))).toBe(false);
      prompt().value = '/교정 해줘';
      prompt().dispatch('input');
      expect(hidden(q('hop-ai-slash'))).toBe(true);
    });

    it('AC-7b26a7fa: skill/theme selects live inside the slash menu and no quick-action button is shown outside it', async () => {
      build();
      await flush();
      const slash = q('hop-ai-slash');
      expect(slash.contains(q('hop-ai-skill-select'))).toBe(true);
      expect(slash.contains(q('hop-ai-theme-select'))).toBe(true);
      expect(q('hop-ai-skill-select').closest('.hop-ai-slash-foot')).not.toBeNull();
      // 빠른 작업 항목은 전부 '/' 메뉴 안에만 있고, 메뉴가 닫힌 동안 노출되지 않는다.
      const chips = slashChips();
      expect(chips).toHaveLength(8);
      expect(chips.every((c) => slash.contains(c))).toBe(true);
      expect(hidden(slash)).toBe(true);
      const panel = q('hop-ai-panel');
      const outside = panel.querySelectorAll('[data-action]').filter((n) => !slash.contains(n));
      expect(outside).toEqual([]);
      expect(q('hop-ai-composer-bar').querySelectorAll('[data-action]')).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────
  // AC-e8a6c4ab: 모델 팝오버 · 모드 드롭다운
  // ─────────────────────────────────────────────────────────
  describe('AC-e8a6c4ab', () => {
    const triggerLabel = () => q('hop-ai-model-trigger').querySelector('.hop-ai-dd-label')?.textContent;
    const chips = () => qa('hop-ai-provider-chip');
    const items = () => qa('hop-ai-model-item');

    it('AC-e8a6c4ab: the model trigger opens a popover with provider chips and the current provider models', async () => {
      build();
      await flush();
      expect(triggerLabel()).toBe('gemini-3.8-flash');
      const menu = q('hop-ai-model-menu');
      expect(hidden(menu)).toBe(true);
      q('hop-ai-model-trigger').click();
      expect(hidden(menu)).toBe(false);
      expect(q('hop-ai-model-trigger').getAttribute('aria-expanded')).toBe('true');
      expect(chips().map((c) => c.textContent)).toEqual([
        'Gemini',
        'OpenAI',
        'Anthropic',
        'Ollama',
        'Claude Code (로컬 CLI)',
        'agy CLI (로컬)',
        'OpenAI 호환 (Groq 등)',
      ]);
      expect(chips().filter((c) => c.classList.contains('hop-ai-provider-chip-active')).map((c) => c.textContent)).toEqual(['Gemini']);
      expect(items().map(label)).toEqual([
        'gemini-3.8-flash',
        'gemini-3.1-pro-preview',
        'gemini-3.7-flash',
        'gemini-3.5-flash-lite',
        'gemini-flash-latest',
        'gemini-pro-latest',
        '직접 입력…',
      ]);
      expect(items().filter((i) => i.getAttribute('aria-selected') === 'true').map(label)).toEqual(['gemini-3.8-flash']);
      // 목록 새로 고침·키 설정 항목도 같은 팝오버 안에 있다.
      expect(menu.contains(q('hop-ai-model-refresh'))).toBe(true);
      expect(menu.contains(q('hop-ai-model-key'))).toBe(true);
    });

    it('AC-e8a6c4ab: a provider chip switches the provider select and repopulates the model list', async () => {
      build();
      await flush();
      q('hop-ai-model-trigger').click();
      chips().find((c) => c.textContent === 'Ollama')!.click();
      await flush();
      expect(q('hop-ai-provider').value).toBe('ollama');
      expect(q('hop-ai-model-select').value).toBe('qwen3.8:27b');
      expect(hidden(q('hop-ai-model-menu'))).toBe(false);
      expect(chips().filter((c) => c.classList.contains('hop-ai-provider-chip-active')).map((c) => c.textContent)).toEqual(['Ollama']);
      expect(items().map(label)).toEqual([
        'qwen3.8:27b',
        'gemma4:12b',
        'qwen3.6:27b',
        'gpt-oss:20b',
        'qwen3.5:9b',
        'mistral-small3.2:24b',
        'llama3.1:8b',
        '직접 입력…',
      ]);
      expect(triggerLabel()).toBe('qwen3.8:27b');
    });

    it('AC-e8a6c4ab: picking a model item sets the model select, closes the popover, relabels the trigger and is used for the request', async () => {
      build();
      await flush();
      await selectProvider('ollama');
      q('hop-ai-model-trigger').click();
      items().find((i) => label(i) === 'gemma4:12b')!.click();
      expect(q('hop-ai-model-select').value).toBe('gemma4:12b');
      expect(hidden(q('hop-ai-model-menu'))).toBe(true);
      expect(q('hop-ai-model-trigger').getAttribute('aria-expanded')).toBe('false');
      expect(triggerLabel()).toBe('gemma4:12b');
      expect(q('hop-ai-model-trigger').title).toBe('모델: Ollama · gemma4:12b');
      await send('요약해줘');
      expect(bridge.aiRequestEdit.mock.calls[0].slice(2, 4)).toEqual(['ollama', 'gemma4:12b']);
    });

    it('AC-e8a6c4ab: 직접 입력… reveals the model id input, which then drives the trigger label', async () => {
      build();
      await flush();
      await selectProvider('ollama');
      expect(hidden(q('hop-ai-model'))).toBe(true);
      q('hop-ai-model-trigger').click();
      items().find((i) => label(i) === '직접 입력…')!.click();
      expect(q('hop-ai-model-select').value).toBe('__custom__');
      expect(hidden(q('hop-ai-model'))).toBe(false);
      expect(q('hop-ai-model').focusCalls).toBe(1);
      expect(hidden(q('hop-ai-model-menu'))).toBe(false);
      q('hop-ai-model').value = 'my-local-model';
      q('hop-ai-model').dispatch('input');
      expect(triggerLabel()).toBe('my-local-model');
      key(q('hop-ai-model'), { key: 'Enter' });
      expect(hidden(q('hop-ai-model-menu'))).toBe(true);
    });

    it('AC-e8a6c4ab: refresh asks the provider for models and the key item opens the settings modal', async () => {
      build();
      await flush();
      await selectProvider('anthropic');
      q('hop-ai-model-trigger').click();
      q('hop-ai-model-refresh').click();
      await flush();
      expect(bridge.aiListModels).toHaveBeenCalledWith('anthropic', undefined);
      expect(hidden(q('hop-ai-modal'))).toBe(true);
      q('hop-ai-model-key').click();
      expect(hidden(q('hop-ai-modal'))).toBe(false);
      expect(hidden(q('hop-ai-model-menu'))).toBe(true);
    });

    it('AC-e8a6c4ab: the mode dropdown switches to 질문 (active button, trigger label, placeholder) and back', async () => {
      build();
      await flush();
      const [editBtn, askBtn] = qa('hop-ai-mode-btn');
      const modeLabel = () => q('hop-ai-mode-trigger').querySelector('.hop-ai-dd-label')?.textContent;
      expect(modeLabel()).toBe('편집');
      expect(prompt().placeholder).toBe('무엇을 쓰거나 고칠까요?  / 빠른 작업');
      q('hop-ai-mode-trigger').click();
      expect(hidden(q('hop-ai-mode-menu'))).toBe(false);
      askBtn.click();
      expect(askBtn.classList.contains('hop-ai-mode-active')).toBe(true);
      expect(editBtn.classList.contains('hop-ai-mode-active')).toBe(false);
      expect(askBtn.getAttribute('aria-checked')).toBe('true');
      expect(modeLabel()).toBe('질문');
      expect(prompt().placeholder).toBe('문서에 대해 물어보세요 — 편집하지 않습니다');
      expect(q('hop-ai-panel').dataset.mode).toBe('ask');
      expect(hidden(q('hop-ai-mode-menu'))).toBe(true);
      editBtn.click();
      expect(modeLabel()).toBe('편집');
      expect(q('hop-ai-panel').dataset.mode).toBe('edit');
    });

    it('AC-e8a6c4ab: only one popover is open at a time and mousedown outside closes it (inside keeps it)', async () => {
      build();
      await flush();
      q('hop-ai-model-trigger').click();
      q('hop-ai-mode-trigger').click();
      expect(hidden(q('hop-ai-mode-menu'))).toBe(false);
      expect(hidden(q('hop-ai-model-menu'))).toBe(true);

      q('hop-ai-model-trigger').click();
      expect(hidden(q('hop-ai-model-menu'))).toBe(false);
      items()[1].dispatch('mousedown');
      expect(hidden(q('hop-ai-model-menu'))).toBe(false);
      q('hop-ai-threads').dispatch('mousedown');
      expect(hidden(q('hop-ai-model-menu'))).toBe(true);
      expect(q('hop-ai-model-trigger').getAttribute('aria-expanded')).toBe('false');
    });
  });

  // ─────────────────────────────────────────────────────────
  // AC-c4f32f85: 승인 대기 중 고정 검토 바
  // ─────────────────────────────────────────────────────────
  describe('AC-c4f32f85', () => {
    const review = () => q('hop-ai-review');
    const reviewLabel = () => q('hop-ai-review-label').textContent;

    async function propose(script: unknown = TWO_EDIT_SCRIPT): Promise<void> {
      await send('바꿔줘');
      await ready(script);
    }

    it('AC-c4f32f85: hidden before a proposal, shown with "변경 2건 검토 중" while pending, count follows per-edit exclusion, hidden on accept', async () => {
      const { loadDocument } = enableSnapshot();
      build({ canvas: true });
      await flush();
      await selectProvider('ollama');
      expect(hidden(review())).toBe(true);

      await propose();
      expect(hidden(review())).toBe(false);
      expect(reviewLabel()).toBe('변경 2건 검토 중');
      expect(q('hop-ai-panel').classList.contains('hop-ai-reviewing')).toBe(true);
      expect(q('hop-ai-review-accept').disabled).toBe(false);
      // 검토 바는 입력 카드 바로 위에 있다.
      const composer = q('hop-ai-composer');
      expect(composer.children.indexOf(review()) + 1).toBe(composer.children.indexOf(q('hop-ai-composer-card')));

      qa('hop-ai-diff-drop')[0].click();
      expect(reviewLabel()).toBe('변경 1/2건 적용 예정');
      qa('hop-ai-diff-keep')[0].click();
      expect(reviewLabel()).toBe('변경 2건 검토 중');
      qa('hop-ai-diff-drop')[1].click();
      expect(reviewLabel()).toBe('변경 1/2건 적용 예정');

      q('hop-ai-review-accept').click();
      expect(hidden(review())).toBe(true);
      expect(q('hop-ai-panel').classList.contains('hop-ai-reviewing')).toBe(false);
      expect(bubbleStatus()).toBe('적용 완료: 1건');
      expect(bridge.markDocumentDirty).toHaveBeenCalledTimes(1);
      // 제외·복원 때마다(drop, keep, drop = 3번) 스냅샷을 다시 읽어 재적용했고, 승인은 되돌리지 않는다.
      expect(loadDocument).toHaveBeenCalledTimes(3);
    });

    it('AC-c4f32f85: rejecting all from the review bar reverts the snapshot and hides the bar', async () => {
      const { loadDocument, snapshotBytes } = enableSnapshot();
      build({ canvas: true });
      await flush();
      await selectProvider('ollama');
      await propose();
      expect(hidden(review())).toBe(false);
      q('hop-ai-review-reject').click();
      expect(loadDocument).toHaveBeenCalledWith(snapshotBytes, 'doc.hwp');
      expect(hidden(review())).toBe(true);
      expect(q('hop-ai-panel').classList.contains('hop-ai-reviewing')).toBe(false);
      expect(bubbleStatus()).toBe('제안을 거절하여 되돌렸습니다.');
    });

    it('AC-c4f32f85: a new request while pending rolls back the proposal and hides the bar', async () => {
      const { loadDocument } = enableSnapshot();
      build({ canvas: true });
      await flush();
      await selectProvider('ollama');
      await propose();
      expect(hidden(review())).toBe(false);
      await send('다른 걸로 다시');
      expect(loadDocument).toHaveBeenCalledTimes(1);
      expect(hidden(review())).toBe(true);
      expect(bridge.aiRequestEdit).toHaveBeenCalledTimes(2);
      // 새 제안이 오면 다시 뜬다(1건).
      await ready(ONE_EDIT_SCRIPT);
      expect(hidden(review())).toBe(false);
      expect(reviewLabel()).toBe('변경 1건 검토 중');
    });

    it('AC-c4f32f85: starting a new chat while pending cancels the proposal and hides the bar', async () => {
      const { loadDocument } = enableSnapshot();
      build({ canvas: true });
      await flush();
      await selectProvider('ollama');
      await propose();
      q('hop-ai-newchat').click();
      expect(loadDocument).toHaveBeenCalledTimes(1);
      expect(hidden(review())).toBe(true);
      expect(q('hop-ai-panel').classList.contains('hop-ai-reviewing')).toBe(false);
    });

    it('AC-c4f32f85: the bar also tracks the non-snapshot (virtual preview) path', async () => {
      build();
      await flush();
      await selectProvider('ollama');
      await propose();
      expect(hidden(review())).toBe(false);
      expect(reviewLabel()).toBe('변경 2건 검토 중');
      qa('hop-ai-diff-drop')[1].click();
      expect(reviewLabel()).toBe('변경 1/2건 적용 예정');
      q('hop-ai-review-accept').click();
      expect(bridge.insertText).toHaveBeenCalledTimes(1);
      expect(bridge.insertText).toHaveBeenCalledWith(0, 0, 0, '첫째 수정');
      expect(hidden(review())).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────
  // AC-0643a456: 한 줄 변경 목록 + 요약
  // ─────────────────────────────────────────────────────────
  describe('AC-0643a456', () => {
    const RICH_CONTEXT = {
      document_metadata: { total_sections: 1 },
      content: [
        { type: 'paragraph', id: 'sec[0].p[0]', text: '가나다' },
        { type: 'paragraph', id: 'sec[0].p[1]', text: '라마' },
        { type: 'paragraph', id: 'sec[0].p[2]', text: '지울글' },
        { type: 'paragraph', id: 'sec[0].p[3].tbl[0].cell[1].p[0]', text: '5억' },
      ],
    };
    const MIXED_SCRIPT = {
      edits: [
        { command: 'REPLACE', target_id: 'sec[0].p[0]', payload: { type: 'paragraph', text: '가나다라마' } },
        { command: 'INSERT_AFTER', target_id: 'sec[0].p[1]', payload: { type: 'paragraph', text: '추가문단' } },
        { command: 'DELETE', target_id: 'sec[0].p[2]', payload: { type: 'paragraph' } },
        { command: 'REPLACE', target_id: 'sec[0].p[3].tbl[0].cell[1].p[0]', payload: { text: '10억' } },
      ],
    };

    function rowSummary(row: FakeElement) {
      const head = row.querySelector('.hop-ai-diff-head')!;
      return {
        kind: row.className.split(' ').find((c) => c.startsWith('hop-ai-diff-kind-')),
        icon: head.children[0].className,
        where: head.querySelector('.hop-ai-diff-where')?.textContent,
        snippet: head.querySelector('.hop-ai-diff-snippet')?.textContent,
        stat: head
          .querySelector('.hop-ai-diff-stat')!
          .children.map((s) => s.textContent),
        before: row.children.find((c) => c.classList.contains('hop-ai-diff-before'))?.textContent,
        after: row.children.find((c) => c.classList.contains('hop-ai-diff-after'))?.textContent,
      };
    }

    async function proposeMixed(): Promise<void> {
      bridge.aiGetDocumentContext.mockResolvedValue(RICH_CONTEXT);
      await send('정리해줘');
      await ready(MIXED_SCRIPT);
    }

    it('AC-0643a456: a "변경 N건 · 추가 a · 바꿈 b · 삭제 c" summary sits above the list', async () => {
      build({ canvas: true });
      await flush();
      await selectProvider('ollama');
      await proposeMixed();
      const diff = q('hop-ai-diff');
      const summary = diff.children[0];
      expect(summary.className).toBe('hop-ai-diff-summary');
      expect(summary.children.map((c) => [c.className, c.textContent])).toEqual([
        ['hop-ai-diff-summary-count', '변경 4건'],
        ['hop-ai-diff-plus', '추가 1'],
        ['hop-ai-diff-mod', '바꿈 2'],
        ['hop-ai-diff-minus', '삭제 1'],
      ]);
    });

    it('AC-0643a456: one row per edit with kind icon, location·kind, snippet and +added/−removed character counts', async () => {
      build({ canvas: true });
      await flush();
      await selectProvider('ollama');
      await proposeMixed();
      const rows = qa('hop-ai-diff-item');
      expect(rows).toHaveLength(4);
      expect(rows.map(rowSummary)).toEqual([
        {
          kind: 'hop-ai-diff-kind-mod',
          icon: 'hop-ai-ic hop-ai-ic-text',
          where: '본문 바꿈',
          snippet: '가나다라마',
          stat: ['+5', '−3'],
          before: '가나다',
          after: '가나다라마',
        },
        {
          kind: 'hop-ai-diff-kind-add',
          icon: 'hop-ai-ic hop-ai-ic-text',
          where: '본문 추가',
          snippet: '추가문단',
          stat: ['+4'],
          before: undefined,
          after: '추가문단',
        },
        {
          kind: 'hop-ai-diff-kind-del',
          icon: 'hop-ai-ic hop-ai-ic-text',
          where: '본문 삭제',
          snippet: '지울글',
          stat: ['−3'],
          before: '지울글',
          after: undefined,
        },
        {
          kind: 'hop-ai-diff-kind-mod',
          icon: 'hop-ai-ic hop-ai-ic-table',
          where: '표 셀 바꿈',
          snippet: '10억',
          stat: ['+3', '−2'],
          before: '5억',
          after: '10억',
        },
      ]);
      // 여러 건이면 처음엔 접혀 있다.
      expect(rows.map((r) => r.classList.contains('hop-ai-diff-open'))).toEqual([false, false, false, false]);
    });

    it('AC-0643a456: with ≥2 edits every row ends with exclude/re-include controls that toggle the row', async () => {
      build({ canvas: true });
      await flush();
      await selectProvider('ollama');
      await proposeMixed();
      const rows = qa('hop-ai-diff-item');
      for (const row of rows) {
        const head = row.querySelector('.hop-ai-diff-head')!;
        const controls = head.children[head.children.length - 1];
        expect(controls.className).toBe('hop-ai-diff-controls');
        expect(controls.children.map((c) => c.className)).toEqual(['hop-ai-diff-drop', 'hop-ai-diff-keep']);
      }
      rows[2].querySelector('.hop-ai-diff-drop')!.click();
      expect(rows.map((r) => r.classList.contains('hop-ai-diff-item-rejected'))).toEqual([false, false, true, false]);
      // 제외 버튼 클릭은 줄을 펼치지 않는다.
      expect(rows[2].classList.contains('hop-ai-diff-open')).toBe(false);
      expect(bubbleStatus()).toBe('3/4건 적용 예정 — 승인 또는 거절하세요.');
      rows[2].querySelector('.hop-ai-diff-keep')!.click();
      expect(rows[2].classList.contains('hop-ai-diff-item-rejected')).toBe(false);
      expect(bubbleStatus()).toBe('4/4건 적용 예정 — 승인 또는 거절하세요.');
    });

    it('AC-0643a456: clicking a row head toggles its before/after detail and scrolls the document to that change', async () => {
      build({ canvas: true });
      await flush();
      await selectProvider('ollama');
      await proposeMixed();
      const rows = qa('hop-ai-diff-item');
      scrollContainer.scrollToCalls = [];
      rows[1].querySelector('.hop-ai-diff-head')!.click();
      expect(rows[1].classList.contains('hop-ai-diff-open')).toBe(true);
      expect(rows.filter((r) => r.classList.contains('hop-ai-diff-open'))).toHaveLength(1);
      // sec[0].p[1] → y = 100 + 1*50 = 150 → 위 여백 80px을 두고 스크롤.
      expect(scrollContainer.scrollToCalls).toEqual([{ top: 70, behavior: 'smooth' }]);
      expect(scrollContent.querySelectorAll('.hop-ai-proofread-flash')).toHaveLength(1);
      rows[1].querySelector('.hop-ai-diff-snippet')!.click();
      expect(rows[1].classList.contains('hop-ai-diff-open')).toBe(false);

      // 펼친 줄에서만 전/후가 보이도록 CSS가 연결돼 있다.
      const rules = parseCss(css);
      expect(declsFor(rules, '.hop-ai-diff-item > .hop-ai-diff-before').get('display')).toBe('none');
      expect(declsFor(rules, '.hop-ai-diff-item > .hop-ai-diff-after').get('display')).toBe('none');
      expect(declsFor(rules, '.hop-ai-diff-item.hop-ai-diff-open > .hop-ai-diff-before').get('display')).toBe('block');
      expect(declsFor(rules, '.hop-ai-diff-item.hop-ai-diff-open > .hop-ai-diff-after').get('display')).toBe('block');
    });

    it('AC-0643a456: a single-edit proposal starts expanded and has no per-row controls', async () => {
      build();
      await flush();
      await selectProvider('ollama');
      await send('바꿔줘');
      await ready(ONE_EDIT_SCRIPT);
      const rows = qa('hop-ai-diff-item');
      expect(rows).toHaveLength(1);
      expect(rows[0].classList.contains('hop-ai-diff-open')).toBe(true);
      expect(qa('hop-ai-diff-controls')).toEqual([]);
      expect(q('hop-ai-diff-summary').children.map((c) => c.textContent)).toEqual(['변경 1건', '바꿈 1']);
      expect(rowSummary(rows[0])).toMatchObject({ before: '원문', after: '새 문단', stat: ['+4', '−2'] });
    });
  });

  // ─────────────────────────────────────────────────────────
  // AC-759eeed0: 요청 중 정지 버튼 · 경과 표시
  // ─────────────────────────────────────────────────────────
  describe('AC-759eeed0', () => {
    const thinkingLabel = () => doc.body.querySelector('.hop-ai-thinking-label')?.textContent ?? null;

    it('AC-759eeed0: while requesting the stop button replaces send and clicking it cancels the request', async () => {
      build();
      await flush();
      await selectProvider('ollama');
      expect(hidden(q('hop-ai-send'))).toBe(false);
      expect(hidden(q('hop-ai-cancel'))).toBe(true);
      await send('써줘');
      expect(hidden(q('hop-ai-send'))).toBe(true);
      expect(q('hop-ai-send').disabled).toBe(true);
      expect(hidden(q('hop-ai-cancel'))).toBe(false);
      expect(q('hop-ai-panel').classList.contains('hop-ai-requesting')).toBe(true);

      q('hop-ai-cancel').click();
      await flush();
      expect(bridge.aiCancelRequest).toHaveBeenCalledWith('req-1');
      expect(hidden(q('hop-ai-send'))).toBe(false);
      expect(hidden(q('hop-ai-cancel'))).toBe(true);
      expect(q('hop-ai-panel').classList.contains('hop-ai-requesting')).toBe(false);
      expect(bubbleStatus()).toBe('취소했습니다.');
      // 취소 후 늦게 도착한 완료는 무시된다.
      captured!.onEditReady?.({ requestId: 'req-1', actionScriptJson: JSON.stringify(ONE_EDIT_SCRIPT) });
      await flush();
      expect(qa('hop-ai-diff-item')).toEqual([]);
    });

    it('AC-759eeed0: the thinking label counts elapsed seconds every second and stops when text starts streaming', async () => {
      vi.useFakeTimers();
      build();
      await flush();
      await selectProvider('ollama');
      await send('써줘');
      expect(thinkingLabel()).toBe('생각 중');
      vi.advanceTimersByTime(999);
      expect(thinkingLabel()).toBe('생각 중');
      vi.advanceTimersByTime(1);
      expect(thinkingLabel()).toBe('생각 중 · 1초');
      vi.advanceTimersByTime(2000);
      expect(thinkingLabel()).toBe('생각 중 · 3초');

      // JSON 껍데기만 온 델타는 표시를 유지한다.
      captured!.onDelta?.({ requestId: 'req-1', partialText: '{"edits":[' });
      expect(thinkingLabel()).toBe('생각 중 · 3초');
      vi.advanceTimersByTime(1000);
      expect(thinkingLabel()).toBe('생각 중 · 4초');

      captured!.onDelta?.({
        requestId: 'req-1',
        partialText: '{"command":"REPLACE","target_id":"sec[0].p[0]","payload":{"text":"흐르는 본문"',
      });
      expect(thinkingLabel()).toBeNull();
      expect(q('hop-ai-stream').textContent).toBe('흐르는 본문 ▌');
      vi.advanceTimersByTime(1000);
      // 다음 틱에 표시가 사라진 것을 보고 타이머가 멈춘다.
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(thinkingLabel()).toBeNull();
    });

    it('AC-759eeed0: the elapsed timer stops as soon as the request completes or is cancelled', async () => {
      vi.useFakeTimers();
      build();
      await flush();
      await selectProvider('ollama');
      await send('써줘');
      expect(vi.getTimerCount()).toBe(1);
      vi.advanceTimersByTime(2000);
      expect(thinkingLabel()).toBe('생각 중 · 2초');
      captured!.onEditReady?.({ requestId: 'req-1', actionScriptJson: JSON.stringify(ONE_EDIT_SCRIPT) });
      await flush();
      expect(vi.getTimerCount()).toBe(0);
      expect(thinkingLabel()).toBeNull();

      await send('하나 더');
      expect(vi.getTimerCount()).toBe(1);
      q('hop-ai-cancel').click();
      await flush();
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────
  // AC-ee6c9340: 빈 대화 — 최근 대화 · 자주 쓰는 작업
  // ─────────────────────────────────────────────────────────
  describe('AC-ee6c9340', () => {
    const TASKS = ['보고서 초안 쓰기', '표로 정리하기', '문서 전체 교정', '문서 요약'];

    function welcomeGroups(): Array<{ group: string; items: string[] }> {
      const welcome = q('hop-ai-welcome');
      const out: Array<{ group: string; items: string[] }> = [];
      for (const child of welcome.children) {
        if (child.classList.contains('hop-ai-pop-group')) out.push({ group: child.textContent, items: [] });
        else if (child.classList.contains('hop-ai-welcome-list')) {
          out[out.length - 1].items = child.children.map(label);
        }
      }
      return out;
    }

    function item(text: string): FakeElement {
      const found = qa('hop-ai-welcome-item').find((i) => label(i) === text);
      if (!found) throw new Error(`missing welcome item ${text}`);
      return found;
    }

    function stubConversations(list: unknown[]): void {
      const data = new Map<string, string>([['hop-ai-conversations-v1', JSON.stringify(list)]]);
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, String(v)),
        removeItem: (k: string) => void data.delete(k),
      });
    }

    it('AC-ee6c9340: an empty conversation shows 자주 쓰는 작업 and no recent list when nothing is stored', async () => {
      build();
      await flush();
      expect(q('hop-ai-panel').classList.contains('hop-ai-empty')).toBe(true);
      expect(welcomeGroups()).toEqual([{ group: '자주 쓰는 작업', items: TASKS }]);
      // 대화가 시작되면 CSS가 환영 화면을 숨긴다.
      expect(declsFor(parseCss(css), '.hop-ai-panel:not(.hop-ai-empty) .hop-ai-welcome').get('display')).toBe('none');
    });

    it('AC-ee6c9340: up to 3 most recent non-empty stored conversations are listed and clicking one opens it as a tab', async () => {
      const now = Date.now();
      const msg = (role: 'user' | 'assistant', text: string) => ({ role, text, ts: now });
      stubConversations([
        { id: 'c-old', title: '오래된 대화', createdAt: now, updatedAt: now - 3 * 3_600_000, messages: [msg('user', '옛 질문')] },
        { id: 'c-empty', title: '빈 대화', createdAt: now, updatedAt: now, messages: [] },
        {
          id: 'c-new',
          title: '예산 표 정리',
          createdAt: now,
          updatedAt: now - 2 * 60_000,
          messages: [msg('user', '예산 표 정리해줘'), msg('assistant', '표를 만들었습니다.')],
        },
        { id: 'c-mid', title: '보고서 검토', createdAt: now, updatedAt: now - 30 * 60_000, messages: [msg('user', '검토')] },
        { id: 'c-oldest', title: '아주 오래된', createdAt: now, updatedAt: now - 5 * 86_400_000, messages: [msg('user', 'x')] },
      ]);
      build();
      await flush();
      expect(welcomeGroups()).toEqual([
        { group: '자주 쓰는 작업', items: TASKS },
        { group: '최근 대화', items: ['예산 표 정리', '보고서 검토', '오래된 대화'] },
      ]);
      expect(item('예산 표 정리').querySelector('.hop-ai-pop-hint')?.textContent).toBe('2분 전');

      item('예산 표 정리').click();
      const tabs = qa('hop-ai-tab');
      expect(tabs.map((t) => t.textContent)).toEqual(['새 대화', '예산 표 정리']);
      expect(tabs[1].classList.contains('hop-ai-tab-active')).toBe(true);
      expect(q('hop-ai-panel').classList.contains('hop-ai-empty')).toBe(false);
      const thread = qa('hop-ai-thread').find((t) => !hidden(t))!;
      expect(thread.querySelectorAll('.hop-ai-msg-text').map((m) => m.textContent)).toEqual([
        '예산 표 정리해줘',
        '표를 만들었습니다.',
      ]);
      expect(bridge.aiRequestEdit).not.toHaveBeenCalled();
    });

    it('AC-ee6c9340: 보고서 초안 쓰기 prefills the prompt with the cursor at the end and sends nothing', async () => {
      build();
      await flush();
      await selectProvider('ollama');
      item('보고서 초안 쓰기').click();
      await flush();
      expect(prompt().value).toBe(REPORT_PREFILL);
      expect(prompt().focusCalls).toBeGreaterThanOrEqual(1);
      expect(prompt().selectionRanges.at(-1)).toEqual([REPORT_PREFILL.length, REPORT_PREFILL.length]);
      expect(bridge.aiRequestEdit).not.toHaveBeenCalled();
      expect(bridge.aiGetDocumentContext).not.toHaveBeenCalled();
      expect(q('hop-ai-panel').classList.contains('hop-ai-empty')).toBe(true);
    });

    it('AC-ee6c9340: 문서 요약 starts the summarize task right away', async () => {
      build();
      await flush();
      await selectProvider('ollama');
      item('문서 요약').click();
      await flush();
      expect(bridge.aiRequestEdit).toHaveBeenCalledTimes(1);
      expect(bridge.aiRequestEdit.mock.calls[0][1]).toBe(`${ASK_PREFIX}${SUMMARIZE_PRESET}`);
    });

    it('AC-ee6c9340: the first message removes the empty state; a new chat brings it back', async () => {
      build();
      await flush();
      await selectProvider('ollama');
      await send('첫 지시');
      expect(q('hop-ai-panel').classList.contains('hop-ai-empty')).toBe(false);
      q('hop-ai-newchat').click();
      expect(q('hop-ai-panel').classList.contains('hop-ai-empty')).toBe(true);
      expect(welcomeGroups()[0]).toEqual({ group: '자주 쓰는 작업', items: TASKS });
    });
  });

  // ─────────────────────────────────────────────────────────
  // AC-a2df0019: 툴바 AI 버튼 · ⌘J 토글
  // ─────────────────────────────────────────────────────────
  describe('AC-a2df0019', () => {
    function addToolbarTargets(): FakeElement[] {
      const toolbarBtn = new FakeElement('button');
      toolbarBtn.className = 'tb-btn tb-ai-btn';
      toolbarBtn.setAttribute('data-cmd', 'view:ai-panel');
      toolbarBtn.setAttribute('aria-pressed', 'false');
      const menuItem = new FakeElement('div');
      menuItem.className = 'md-item';
      menuItem.setAttribute('data-cmd', 'view:ai-panel');
      const other = new FakeElement('button');
      other.className = 'tb-btn';
      other.setAttribute('data-cmd', 'view:zoom-100');
      doc.body.append(toolbarBtn, menuItem, other);
      return [toolbarBtn, menuItem, other];
    }

    it('AC-a2df0019: no floating round AI button is mounted', async () => {
      build();
      await flush();
      expect(doc.body.querySelectorAll('.hop-ai-toggle')).toEqual([]);
      expect(doc.body.children).toHaveLength(1);
      expect(doc.body.children[0].classList.contains('hop-ai-panel')).toBe(true);
      expect(doc.body.classList.contains('hop-ai-available')).toBe(true);
    });

    it('AC-a2df0019: the view:ai-panel command toggles the panel and marks every toolbar/menu target active + aria-pressed', async () => {
      const [toolbarBtn, menuItem, other] = addToolbarTargets();
      build();
      await flush();
      expect(bus.on).toHaveBeenCalledWith(AI_PANEL_TOGGLE_EVENT, expect.any(Function));
      const panel = q('hop-ai-panel');
      const command = aiCommands.find((c) => c.id === 'view:ai-panel')!;
      const services = { eventBus: bus } as unknown as Parameters<typeof command.execute>[0];

      command.execute(services);
      expect(panel.classList.contains('open')).toBe(true);
      expect(doc.body.classList.contains('hop-ai-open')).toBe(true);
      for (const target of [toolbarBtn, menuItem]) {
        expect(target.classList.contains('active')).toBe(true);
        expect(target.getAttribute('aria-pressed')).toBe('true');
      }
      expect(other.classList.contains('active')).toBe(false);
      expect(other.getAttribute('aria-pressed')).toBeNull();
      expect(prompt().focusCalls).toBe(1);

      bus.emit(AI_PANEL_TOGGLE_EVENT);
      expect(panel.classList.contains('open')).toBe(false);
      expect(doc.body.classList.contains('hop-ai-open')).toBe(false);
      for (const target of [toolbarBtn, menuItem]) {
        expect(target.classList.contains('active')).toBe(false);
        expect(target.getAttribute('aria-pressed')).toBe('false');
      }
    });

    it('AC-a2df0019: Cmd+J / Ctrl+J (key j or code KeyJ) inside the panel closes it', async () => {
      const [toolbarBtn] = addToolbarTargets();
      build();
      await flush();
      const panel = q('hop-ai-panel');
      const variants: Array<Partial<FakeEvent>> = [
        { key: 'j', metaKey: true },
        { key: 'J', ctrlKey: true },
        { key: 'ㅓ', code: 'KeyJ', metaKey: true },
      ];
      for (const init of variants) {
        bus.emit(AI_PANEL_TOGGLE_EVENT);
        expect(panel.classList.contains('open')).toBe(true);
        const ev = key(prompt(), init);
        expect(ev.defaultPrevented).toBe(true);
        expect(panel.classList.contains('open')).toBe(false);
        expect(toolbarBtn.getAttribute('aria-pressed')).toBe('false');
      }
      // 수식키 없는 j·Shift가 낀 ⌘J는 닫지 않는다.
      bus.emit(AI_PANEL_TOGGLE_EVENT);
      key(prompt(), { key: 'j' });
      key(prompt(), { key: 'J', metaKey: true, shiftKey: true });
      expect(panel.classList.contains('open')).toBe(true);
    });

    it('AC-a2df0019: dispose unsubscribes from the toggle event', async () => {
      build();
      await flush();
      sidebar!.dispose();
      sidebar = null;
      bus.emit(AI_PANEL_TOGGLE_EVENT);
      expect(doc.body.classList.contains('hop-ai-open')).toBe(false);
      expect(doc.body.classList.contains('hop-ai-available')).toBe(false);
    });

    it('AC-a2df0019: index.html has a toolbar AI button and a View-menu item for view:ai-panel, both desktop-only', () => {
      const toolbar = /<div class="tb-group" data-hop-ai-only>\s*<button class="tb-btn tb-ai-btn" data-cmd="view:ai-panel"[^>]*aria-pressed="false"/;
      expect(indexHtml).toMatch(toolbar);
      const viewStart = indexHtml.indexOf('<span class="menu-title">보기</span>');
      const viewEnd = indexHtml.indexOf('<span class="menu-title">', viewStart + 1);
      expect(viewStart).toBeGreaterThan(0);
      const viewMenu = indexHtml.slice(viewStart, viewEnd);
      expect(viewMenu).toMatch(/<div class="md-item" data-cmd="view:ai-panel" data-hop-ai-only>.*AI 편집 패널.*<\/div>/);
      // 그 밖의 메뉴에는 없다.
      expect(indexHtml.split('data-cmd="view:ai-panel"')).toHaveLength(3);
      // data-hop-ai-only는 패널이 붙은(hop-ai-available) 런타임에서만 보인다.
      expect(declsFor(parseCss(css), 'body:not(.hop-ai-available) [data-hop-ai-only]').get('display')).toBe(
        'none !important',
      );
    });
  });

  // ─────────────────────────────────────────────────────────
  // AC-62671196: 패널 단축키 ⌘⏎ / ⌘⌫ / Esc
  // ─────────────────────────────────────────────────────────
  describe('AC-62671196', () => {
    async function pending(): Promise<ReturnType<typeof enableSnapshot>> {
      const snap = enableSnapshot();
      build({ canvas: true });
      await flush();
      await selectProvider('ollama');
      await send('바꿔줘');
      await ready(TWO_EDIT_SCRIPT);
      expect(hidden(q('hop-ai-review'))).toBe(false);
      return snap;
    }

    it('AC-62671196: Cmd+Enter (and Ctrl+Enter) in the panel accepts all pending changes', async () => {
      const { loadDocument } = await pending();
      const ev = key(prompt(), { key: 'Enter', metaKey: true });
      expect(ev.defaultPrevented).toBe(true);
      expect(hidden(q('hop-ai-review'))).toBe(true);
      expect(bubbleStatus()).toBe('적용 완료: 2건');
      expect(loadDocument).not.toHaveBeenCalled();
      expect(bridge.markDocumentDirty).toHaveBeenCalledTimes(1);
      // ⌘⏎는 보내기가 아니다.
      expect(bridge.aiRequestEdit).toHaveBeenCalledTimes(1);

      await send('또 바꿔줘');
      await ready(TWO_EDIT_SCRIPT);
      key(q('hop-ai-threads'), { key: 'Enter', ctrlKey: true });
      expect(hidden(q('hop-ai-review'))).toBe(true);
      expect(bubbleStatus()).toBe('적용 완료: 2건');
    });

    it('AC-62671196: Cmd+Backspace with an empty prompt (or focus outside the prompt) rejects all', async () => {
      const { loadDocument, snapshotBytes } = await pending();
      expect(prompt().value).toBe('');
      const ev = key(prompt(), { key: 'Backspace', metaKey: true });
      expect(ev.defaultPrevented).toBe(true);
      expect(loadDocument).toHaveBeenCalledWith(snapshotBytes, 'doc.hwp');
      expect(hidden(q('hop-ai-review'))).toBe(true);
      expect(bubbleStatus()).toBe('제안을 거절하여 되돌렸습니다.');

      // 입력창에 글이 있어도 초점이 입력창 밖이면 거절한다(Ctrl 변형).
      await send('다시');
      await ready(TWO_EDIT_SCRIPT);
      prompt().value = '쓰던 글';
      key(q('hop-ai-diff'), { key: 'Backspace', ctrlKey: true });
      expect(loadDocument).toHaveBeenCalledTimes(2);
      expect(hidden(q('hop-ai-review'))).toBe(true);
    });

    it('AC-62671196: Cmd+Backspace while typing in a non-empty prompt keeps its normal meaning', async () => {
      const { loadDocument } = await pending();
      prompt().value = '쓰던 글';
      const ev = key(prompt(), { key: 'Backspace', metaKey: true });
      expect(ev.defaultPrevented).toBe(false);
      expect(loadDocument).not.toHaveBeenCalled();
      expect(hidden(q('hop-ai-review'))).toBe(false);
      expect(q('hop-ai-review-label').textContent).toBe('변경 2건 검토 중');
    });

    it('AC-62671196: the shortcuts do nothing when no proposal is pending and are not registered globally', async () => {
      const { loadDocument } = await pending();
      // 문서(에디터)에서 누른 ⌘⏎은 패널이 가로채지 않는다 — 쪽 나누기 등 기존 단축키 유지.
      const global = doc.fire('keydown', { key: 'Enter', metaKey: true });
      expect(global.defaultPrevented).toBe(false);
      expect(hidden(q('hop-ai-review'))).toBe(false);

      q('hop-ai-review-accept').click();
      const enter = key(prompt(), { key: 'Enter', metaKey: true });
      const back = key(prompt(), { key: 'Backspace', metaKey: true });
      expect(enter.defaultPrevented).toBe(false);
      expect(back.defaultPrevented).toBe(false);
      expect(loadDocument).not.toHaveBeenCalled();
      // 패널 안 키는 에디터 전역 단축키로 새지 않는다.
      expect(enter.propagationStopped).toBe(true);
    });

    it('AC-62671196: Escape during a request stops generation', async () => {
      build();
      await flush();
      await selectProvider('ollama');
      await send('써줘');
      const ev = key(prompt(), { key: 'Escape' });
      expect(ev.defaultPrevented).toBe(true);
      await flush();
      expect(bridge.aiCancelRequest).toHaveBeenCalledWith('req-1');
      expect(hidden(q('hop-ai-cancel'))).toBe(true);
      expect(bubbleStatus()).toBe('취소했습니다.');
    });

    it('AC-62671196: Escape closes an open menu first instead of cancelling the request', async () => {
      build();
      await flush();
      await selectProvider('ollama');
      await send('써줘');
      q('hop-ai-model-trigger').click();
      key(prompt(), { key: 'Escape' });
      expect(hidden(q('hop-ai-model-menu'))).toBe(true);
      expect(bridge.aiCancelRequest).not.toHaveBeenCalled();
      key(prompt(), { key: 'Escape' });
      await flush();
      expect(bridge.aiCancelRequest).toHaveBeenCalledTimes(1);
    });

    it('AC-62671196: Enter while composing Hangul (isComposing) does not send; Cmd+Enter in the prompt does not send', async () => {
      build();
      await flush();
      await selectProvider('ollama');
      prompt().value = '한글 조합 중';
      const composing = key(prompt(), { key: 'Enter', isComposing: true });
      expect(composing.defaultPrevented).toBe(false);
      key(prompt(), { key: 'Enter', metaKey: true });
      key(prompt(), { key: 'Enter', ctrlKey: true });
      await flush();
      expect(bridge.aiRequestEdit).not.toHaveBeenCalled();
      expect(prompt().value).toBe('한글 조합 중');
      // Shift+Enter는 줄바꿈(보내지 않음), 그냥 Enter는 보낸다.
      key(prompt(), { key: 'Enter', shiftKey: true });
      await flush();
      expect(bridge.aiRequestEdit).not.toHaveBeenCalled();
      key(prompt(), { key: 'Enter' });
      await flush();
      expect(bridge.aiRequestEdit).toHaveBeenCalledTimes(1);
      expect(bridge.aiRequestEdit.mock.calls[0][1]).toBe('한글 조합 중');
    });
  });
});
