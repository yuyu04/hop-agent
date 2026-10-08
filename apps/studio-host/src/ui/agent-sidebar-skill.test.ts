// 회귀 테스트: 글쓰기 스킬은 사용자가 고르지 않는다 (F-fb6592e9).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiEventHandlers } from '@/core/ai-bridge';

/**
 * F-fb6592e9 — 글쓰기 스킬은 사용자가 고르지 않는다. AI가 요청에 맞는 지침을 의미로 골라
 * 따르고, 무엇을 골랐는지 답변에 보인다.
 *
 * - AC-fe6c5691: 답변에 '지침: <이름> · AI 선택'(직접 고른 경우 '· 직접 선택') 표시. 응답의
 *   skill이 알려진 스킬 이름이 아니면 표시하지 않고, 표시를 누르면 입력창 글을 지우지 않고
 *   스킬을 바꿀 수 있는 '/' 메뉴를 연다.
 * - AC-f4d79af6: 스킬 선택 상자의 기본값은 '스킬: 자동(AI 선택)'.
 * - 전송되는 프롬프트(자동이면 작성 지침 목록, 직접 고르면 그 지침 하나, 없음·질문 모드면 없음)도
 *   사이드바 경로 그대로 확인한다(AC-cee73e04의 사이드바 쪽).
 *
 * DOM은 agent-sidebar-layout.test.ts의 FakeElement(className↔classList 동기화, textContent는
 * 자손 글자 합, 이벤트 버블링, closest/matches, select.value)를 그대로 옮겨 쓴다.
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

interface TestSkill {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  body: string;
  mode?: string;
}

/** 앱 스킬 폴더에서 읽혀 온 것처럼 — 보고서는 id와 이름이 다르다(선택 값은 id, 표시는 이름). */
const SKILLS: TestSkill[] = [
  {
    id: '공문',
    name: '공문',
    description: '기관 간 공문을 행정 공문서 형식으로',
    triggers: ['공문', '기안문', '협조 요청'],
    body: '[공문 지침] 시행문 형식으로 짧게 쓴다.',
  },
  {
    id: 'report',
    name: '보고서',
    description: '결론 우선 보고서',
    triggers: ['보고서', '보고'],
    body: '[보고서 지침] 결론을 먼저 쓴다.',
  },
  {
    id: '문서-문체',
    name: '문서 문체',
    description: '일반 문체 지침',
    triggers: ['작성', '문체'],
    body: '[문체 지침] 문장을 짧게 쓴다.',
  },
  {
    id: '한글-문서-편집',
    name: '한글 문서 편집',
    description: '기존 문서를 최소한으로 수정',
    triggers: ['수정', '정리'],
    body: '[편집 지침] 바꿀 곳만 고친다.',
    mode: 'edit',
  },
];

const ASK_PREFIX =
  '다음은 편집 요청이 아니라 질문입니다. 문서를 절대 수정하지 말고(edits는 반드시 빈 배열 []) message에만 한국어로 답하거나 요약하세요.\n\n';

const ONE_EDIT_SCRIPT = {
  edits: [{ command: 'REPLACE', target_id: 'sec[0].p[0]', payload: { type: 'paragraph', text: '새 문단' } }],
};

/** 편집 없는 답변(편집 모드에서도 '바꿀 내용 없음' 경로) — skill만 바꿔 가며 쓴다. */
function answer(skill?: string): Record<string, unknown> {
  return { edits: [], message: '작성했습니다.', ...(skill !== undefined ? { skill } : {}) };
}

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

function createSkillBridge() {
  return { ...createBridge(), aiListSkills: vi.fn(async (): Promise<TestSkill[]> => SKILLS) };
}

// ── 테스트 ─────────────────────────────────────────────────────

describe('F-fb6592e9: 스킬 자동 선택 표시(AI 패널)', () => {
  let doc: FakeDocument;
  let bridge: ReturnType<typeof createSkillBridge>;
  let bus: ReturnType<typeof createBus>;
  let sidebar: AgentSidebar | null;

  function build(): AgentSidebar {
    const deps = {
      bridge,
      eventBus: bus,
      getCanvasView: () => null,
      scrollContent: new FakeElement('div'),
      scrollContainer: new FakeElement('div'),
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

  const prompt = () => q('hop-ai-prompt');
  const skillSelect = () => q('hop-ai-skill-select');
  const slash = () => q('hop-ai-slash');
  const quickItems = () => qa('hop-ai-quick-chip');

  async function selectProvider(id: string): Promise<void> {
    const select = q('hop-ai-provider');
    select.value = id;
    select.dispatch('change');
    await flush();
  }

  /** 패널을 만들고 스킬 목록을 불러온 뒤 키가 필요 없는 로컬 모델을 고른다. */
  async function start(): Promise<void> {
    build();
    await flush();
    await selectProvider('ollama');
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

  /** i번째 요청에서 브리지로 넘긴 프롬프트. */
  function sentPrompt(i = 0): string {
    const call = bridge.aiRequestEdit.mock.calls[i];
    if (!call) throw new Error(`aiRequestEdit 호출 ${i}번이 없다`);
    return String(call[1]);
  }

  /** 마지막 답변 버블의 지침 표시 자리. */
  function skillArea(): FakeElement {
    const bubbles = qa('hop-ai-msg-assistant');
    const last = bubbles[bubbles.length - 1];
    if (!last) throw new Error('답변 버블이 없다');
    const area = last.querySelector('.hop-ai-skill');
    if (!area) throw new Error('답변 버블에 .hop-ai-skill이 없다');
    return area;
  }

  const chips = () => skillArea().querySelectorAll('.hop-ai-skill-chip');
  const chipLabels = () => chips().map((c) => c.querySelector('.hop-ai-skill-chip-label')?.textContent ?? '');

  function optionPairs(select: FakeElement): [string, string][] {
    return select.children.filter((c) => c.tagName === 'OPTION').map((o) => [o.value, o.textContent]);
  }

  beforeEach(() => {
    captured = null;
    sidebar = null;
    doc = new FakeDocument();
    (globalThis as Record<string, unknown>).document = doc;
    bridge = createSkillBridge();
    bus = createBus();
  });

  afterEach(() => {
    sidebar?.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).document;
  });

  // ─────────────────────────────────────────────────────────
  // AC-fe6c5691: 답변의 '지침: 이름 · AI 선택/직접 선택' 표시
  // ─────────────────────────────────────────────────────────
  describe('AC-fe6c5691', () => {
    it("AC-fe6c5691: 자동(기본) — 모든 스킬을 담은 작성 지침 목록을 요청 앞에 싣고, 응답 skill '공문'이면 '지침: 공문 · AI 선택'", async () => {
      await start();
      await send('협조 요청 공문 작성해줘');
      expect(bridge.aiRequestEdit).toHaveBeenCalledTimes(1);
      const sent = sentPrompt();
      expect(sent.startsWith('[작성 지침 목록]')).toBe(true);
      for (const s of SKILLS) {
        expect(sent, s.name).toContain(`### ${s.name}`);
        expect(sent, s.name).toContain(s.body);
      }
      expect(sent).toContain('(낱말 기준 추천: 공문 — ');
      expect(sent).toContain('### 한글 문서 편집 (기존 문서 편집 전용');
      expect(sent.endsWith('\n\n---\n\n협조 요청 공문 작성해줘')).toBe(true);
      // 응답 전에는 표시가 없다.
      expect(chips()).toEqual([]);

      await ready(answer('공문'));
      expect(chipLabels()).toEqual(['지침: 공문 · AI 선택']);
      const chip = chips()[0];
      expect(chip.tagName).toBe('BUTTON');
      expect(chip.textContent).toBe('지침: 공문 · AI 선택');
    });

    it("AC-fe6c5691: 낱말이 겹치지 않는 요청('관계기관에 보낼 문서')도 AI가 고른 '공문'을 표시한다", async () => {
      await start();
      await send('회의 결과를 관계기관에 보낼 문서로 만들어줘');
      const sent = sentPrompt();
      expect(sent.startsWith('[작성 지침 목록]')).toBe(true);
      // 낱말 기준 추천은 없지만 목록에는 모든 스킬이 실린다 — 최종 선택은 AI.
      expect(sent).not.toContain('낱말 기준 추천');
      for (const s of SKILLS) expect(sent, s.name).toContain(s.body);
      await ready(answer('공문'));
      expect(chipLabels()).toEqual(['지침: 공문 · AI 선택']);
    });

    it("AC-fe6c5691: 편집이 있는 응답에도 '지침: 보고서 · AI 선택' 표시가 붙는다", async () => {
      await start();
      await send('분기 보고서 작성해줘');
      await ready({ ...ONE_EDIT_SCRIPT, skill: '보고서' });
      expect(chipLabels()).toEqual(['지침: 보고서 · AI 선택']);
    });

    it.each([
      ['공 문', '공문'],
      ['문서문체', '문서 문체'],
      ['  보고서 ', '보고서'],
      ['한글문서 편집', '한글 문서 편집'],
    ])("AC-fe6c5691: 응답 skill '%s'는 띄어쓰기를 무시하고 알려진 이름 '%s'로 표시한다", async (reported, known) => {
      await start();
      await send('문서 작성해줘');
      await ready(answer(reported));
      expect(chipLabels()).toEqual([`지침: ${known} · AI 선택`]);
    });

    it.each([
      ['알 수 없는 이름', '없는지침'],
      ['빈 문자열', ''],
      ['공백만', '   '],
      ['skill 없음', undefined],
    ])('AC-fe6c5691: 응답 skill이 %s이면 표시하지 않는다', async (_label, reported) => {
      await start();
      await send('협조 요청 공문 작성해줘');
      expect(sentPrompt().startsWith('[작성 지침 목록]')).toBe(true);
      await ready(answer(reported));
      expect(skillArea().children).toEqual([]);
      expect(qa('hop-ai-skill-chip')).toEqual([]);
    });

    it.each([
      ['skill 없음', undefined],
      ['다른 스킬', '공문'],
      ['모르는 이름', '없는지침'],
    ])("AC-fe6c5691: 직접 고른 스킬 — 지침 하나만 싣고, 응답이 %s이어도 '지침: 보고서 · 직접 선택'", async (_label, reported) => {
      await start();
      skillSelect().value = 'id:report';
      skillSelect().dispatch('change');
      await send('분기 실적 정리해줘');
      const sent = sentPrompt();
      expect(sent.startsWith('[작성 스킬: 보고서]\n[보고서 지침] 결론을 먼저 쓴다.')).toBe(true);
      expect(sent).not.toContain('[작성 지침 목록]');
      for (const other of SKILLS.filter((s) => s.id !== 'report')) expect(sent, other.name).not.toContain(other.body);
      expect(sent.endsWith('분기 실적 정리해줘')).toBe(true);

      await ready(answer(reported));
      expect(chipLabels()).toEqual(['지침: 보고서 · 직접 선택']);
    });

    it("AC-fe6c5691: '스킬: 없음'이면 지침을 싣지 않고 응답에 skill이 있어도 표시하지 않는다", async () => {
      await start();
      skillSelect().value = 'none';
      skillSelect().dispatch('change');
      await send('협조 요청 공문 작성해줘');
      expect(sentPrompt()).toBe('협조 요청 공문 작성해줘');
      await ready(answer('공문'));
      expect(skillArea().children).toEqual([]);
    });

    it('AC-fe6c5691: 질문 모드는 작성 지침 목록을 싣지 않고 표시도 하지 않는다(AC-cee73e04 질문 모드 제외)', async () => {
      await start();
      qa('hop-ai-mode-btn')[1].click();
      await send('이 문서 요약해줘');
      const sent = sentPrompt();
      expect(sent).toBe(`${ASK_PREFIX}이 문서 요약해줘`);
      expect(sent).not.toContain('[작성 지침 목록]');
      for (const s of SKILLS) expect(sent, s.name).not.toContain(s.body);
      await ready(answer('공문'));
      expect(skillArea().children).toEqual([]);
    });

    it('AC-fe6c5691: 질문 모드에서도 작성 요청이면 편집 모드로 보내므로 목록을 싣고 표시한다', async () => {
      await start();
      qa('hop-ai-mode-btn')[1].click();
      await send('협조 요청 공문 작성해줘');
      const sent = sentPrompt();
      expect(sent.startsWith('[작성 지침 목록]')).toBe(true);
      expect(sent).not.toContain(ASK_PREFIX.trim());
      await ready(answer('공문'));
      expect(chipLabels()).toEqual(['지침: 공문 · AI 선택']);
    });

    it("AC-fe6c5691: 표시를 누르면 입력창 글은 그대로 두고 '/' 메뉴(스킬 선택 포함)를 걸러짐 없이 연다", async () => {
      await start();
      await send('협조 요청 공문 작성해줘');
      await ready(answer('공문'));

      // '/교정'으로 걸러 본 뒤 다른 글을 써서 메뉴가 닫힌 상태 — 숨은 항목·걸러보기 표시가 남아 있다.
      prompt().value = '/교정';
      prompt().dispatch('input');
      expect(slash().classList.contains('hop-ai-slash-filtered')).toBe(true);
      expect(quickItems().some((c) => hidden(c))).toBe(true);
      prompt().value = '쓰던 글';
      prompt().dispatch('input');
      expect(hidden(slash())).toBe(true);

      const chip = chips()[0];
      chip.dispatch('mousedown');
      chip.click();

      expect(hidden(slash())).toBe(false);
      expect(quickItems()).toHaveLength(8);
      expect(quickItems().filter((c) => hidden(c))).toEqual([]);
      expect(slash().classList.contains('hop-ai-slash-filtered')).toBe(false);
      expect(prompt().value).toBe('쓰던 글');
      expect(slash().contains(skillSelect())).toBe(true);
      expect(skillSelect().closest('.hop-ai-slash-foot')).not.toBeNull();
    });

    it("AC-fe6c5691: 표시로 연 '/' 메뉴는 메뉴 안을 누르면 유지되고, 밖(답변)을 누르면 닫힌다", async () => {
      await start();
      await send('협조 요청 공문 작성해줘');
      await ready(answer('공문'));
      prompt().value = '쓰던 글';

      const chip = chips()[0];
      chip.dispatch('mousedown');
      chip.click();
      expect(hidden(slash())).toBe(false);

      // 메뉴 안(스킬 선택 상자) — 그대로 열려 있다.
      skillSelect().dispatch('mousedown');
      expect(hidden(slash())).toBe(false);
      // 표시 자체를 다시 눌러도 닫히지 않는다.
      chip.dispatch('mousedown');
      expect(hidden(slash())).toBe(false);

      // 메뉴 밖(답변 본문) — 닫힌다. 입력창 글은 그대로.
      const bubbles = qa('hop-ai-msg-assistant');
      const msgText = bubbles[bubbles.length - 1].querySelector('.hop-ai-msg-text');
      if (!msgText) throw new Error('답변 본문이 없다');
      msgText.dispatch('mousedown');
      expect(hidden(slash())).toBe(true);
      expect(prompt().value).toBe('쓰던 글');
    });

    it('AC-fe6c5691: 표시로 연 메뉴에서 스킬을 바꾸면 다음 요청은 그 지침을 직접 선택으로 쓴다', async () => {
      await start();
      await send('협조 요청 공문 작성해줘');
      await ready(answer('공문'));
      chips()[0].click();
      skillSelect().value = 'id:report';
      skillSelect().dispatch('change');
      await send('결과 정리해줘');
      expect(bridge.aiRequestEdit).toHaveBeenCalledTimes(2);
      expect(sentPrompt(1).startsWith('[작성 스킬: 보고서]\n')).toBe(true);
      await ready(answer('공문'));
      expect(chipLabels()).toEqual(['지침: 보고서 · 직접 선택']);
    });
  });

  // ─────────────────────────────────────────────────────────
  // AC-f4d79af6: 스킬 선택 상자의 기본값 '스킬: 자동(AI 선택)'
  // ─────────────────────────────────────────────────────────
  describe('AC-f4d79af6', () => {
    it("AC-f4d79af6: 스킬을 불러오기 전에도, 불러온 뒤에도 첫 항목은 'auto' — '스킬: 자동(AI 선택)'이고 기본값이다", async () => {
      let release: (skills: TestSkill[]) => void = () => undefined;
      bridge.aiListSkills.mockImplementation(
        () =>
          new Promise<TestSkill[]>((resolve) => {
            release = resolve;
          }),
      );
      build();
      await flush();
      const select = skillSelect();
      expect(bridge.aiListSkills).toHaveBeenCalledTimes(1);
      expect(optionPairs(select)).toEqual([['auto', '스킬: 자동(AI 선택)']]);
      expect(select.value).toBe('auto');

      release(SKILLS);
      await flush();
      expect(optionPairs(select)).toEqual([
        ['auto', '스킬: 자동(AI 선택)'],
        ['none', '스킬: 없음'],
        ['id:공문', '스킬: 공문'],
        ['id:report', '스킬: 보고서'],
        ['id:문서-문체', '스킬: 문서 문체'],
        ['id:한글-문서-편집', '스킬: 한글 문서 편집'],
      ]);
      expect(select.value).toBe('auto');
    });

    it('AC-f4d79af6: 스킬을 불러오지 못해도 자동이 기본값이다', async () => {
      bridge.aiListSkills.mockImplementation(async () => {
        throw new Error('스킬 폴더 없음');
      });
      build();
      await flush();
      expect(optionPairs(skillSelect())).toEqual([
        ['auto', '스킬: 자동(AI 선택)'],
        ['none', '스킬: 없음'],
      ]);
      expect(skillSelect().value).toBe('auto');
    });

    it('AC-f4d79af6: 설명(title)은 평소엔 자동이고 지침을 강제하거나 끌 때만 바꾸는 설정임을 알린다', async () => {
      build();
      await flush();
      const title = skillSelect().title;
      expect(title).toContain('평소엔 자동');
      expect(title).toContain('AI가 요청에 맞는 지침을 고름');
      expect(title).toContain('강제하거나 끌 때만 바꾸세요');
    });

    it("AC-f4d79af6: 고급 설정이라 입력창 바에는 없고 '/' 메뉴 아래쪽에만 있다", async () => {
      build();
      await flush();
      expect(skillSelect().closest('.hop-ai-slash-foot')).not.toBeNull();
      expect(q('hop-ai-composer-bar').querySelectorAll('.hop-ai-skill-select')).toEqual([]);
      expect(qa('hop-ai-skill-select')).toHaveLength(1);
    });

    it('AC-f4d79af6: 아무것도 건드리지 않고 보내면 자동(작성 지침 목록)으로 보낸다', async () => {
      await start();
      await send('보고서 작성해줘');
      expect(sentPrompt().startsWith('[작성 지침 목록]')).toBe(true);
      expect(sentPrompt()).not.toContain('[작성 스킬:');
    });
  });
});
