import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiEventHandlers } from '@/core/ai-bridge';

/**
 * F-a7b2c7ba AC-19a5d929 — 질문 모드에서 작성 요청(작성·써줘·만들어·초안)을 보내면 편집 모드로
 * 바꿔 보내고, 컴포저 상태줄에 '작성 요청이라 편집 모드로 보냈습니다'를 알린다.
 *
 * 하네스(FakeElement/FakeDocument/브리지 목)는 agent-sidebar.test.ts와 같다. 실제 buildPanel()
 * DOM을 쓴다: 모드 버튼 `.hop-ai-mode-btn`(첫째=편집, 둘째=질문, 활성은 `hop-ai-mode-active`),
 * 모드 트리거 `.hop-ai-mode-trigger`, 컴포저 상태줄은 `.hop-ai-composer`의 직속 `.hop-ai-status`
 * (답변 버블의 `.hop-ai-bubble-status`와 다르다).
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

class FakeElement {
  tagName: string;
  className = '';
  private _textContent: string | null = '';
  title = '';
  value = '';
  type = '';
  rows = 0;
  placeholder = '';
  disabled = false;
  checked = false;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  private attrs = new Map<string, string>();

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
  }

  // 실제 DOM처럼 textContent 설정 시 자식 노드를 제거한다.
  get textContent(): string | null {
    return this._textContent;
  }
  set textContent(value: string | null) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._textContent = value;
  }

  // 실제 DOM처럼 className과 classList가 한 저장소를 공유한다 — className으로 붙인 클래스
  // (편집 버튼의 초기 'hop-ai-mode-active')도 classList.toggle/remove로 떼어진다.
  get classList() {
    const self = this;
    const tokens = (): string[] => self.className.split(/\s+/).filter(Boolean);
    const set = (list: string[]) => {
      self.className = list.join(' ');
    };
    return {
      add(cls: string) {
        if (!tokens().includes(cls)) set([...tokens(), cls]);
      },
      remove(cls: string) {
        set(tokens().filter((t) => t !== cls));
      },
      contains(cls: string) {
        return tokens().includes(cls);
      },
      toggle(cls: string, force?: boolean) {
        const next = force ?? !tokens().includes(cls);
        if (next) this.add(cls);
        else this.remove(cls);
        return next;
      },
    };
  }

  setAttribute(name: string, value: string) {
    this.attrs.set(name, value);
  }

  getAttribute(name: string) {
    return this.attrs.get(name) ?? null;
  }

  appendChild(child: FakeElement): FakeElement {
    if (child.parentNode) {
      const idx = child.parentNode.children.indexOf(child);
      if (idx >= 0) child.parentNode.children.splice(idx, 1);
    }
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
    for (const node of nodes) this.appendChild(node);
  }

  remove(): void {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx >= 0) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  click(): void {
    this.fire('click');
  }

  selectCalled = 0;
  select(): void {
    this.selectCalled += 1;
  }

  fire(type: string, event: unknown = {}): void {
    this.listeners.get(type)?.forEach((fn) => fn(event));
  }

  // 인라인 오버레이가 호출하는 스크롤/레이아웃 API(테스트용 no-op).
  get clientWidth(): number {
    return 600;
  }
  scrollTo(): void {}
  scrollTop = 0;
  scrollHeight = 0;

  contains(node: unknown): boolean {
    if (node === this) return true;
    return this.allDescendants().some((n) => n === node);
  }

  querySelector(selector: string): FakeElement | null {
    return this.queryAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.queryAll(selector);
  }

  private queryAll(selector: string): FakeElement[] {
    // 테스트에는 `.class` 선택자만 필요하다(`[attr]`는 없음 → 빈 배열).
    if (!selector.startsWith('.')) return [];
    const cls = selector.slice(1);
    return this.allDescendants().filter((node) => node.classList.contains(cls));
  }

  private allDescendants(): FakeElement[] {
    const result: FakeElement[] = [];
    for (const child of this.children) {
      result.push(child);
      result.push(...child.allDescendants());
    }
    return result;
  }
}

class FakeDocument {
  body = new FakeElement('body');
  private listeners = new Map<string, Array<(event: unknown) => void>>();

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    const idx = list.indexOf(fn);
    if (idx >= 0) list.splice(idx, 1);
  }

  fire(type: string, event: unknown): void {
    this.listeners.get(type)?.forEach((fn) => fn(event));
  }
}

const REPLACE_SCRIPT = {
  edits: [
    {
      command: 'REPLACE',
      target_id: 'sec[0].p[0]',
      payload: { type: 'paragraph', text: '새 문단' },
    },
  ],
};

const CONTEXT = {
  document_metadata: { total_sections: 1 },
  content: [{ type: 'paragraph', id: 'sec[0].p[0]', text: '원문' }],
};

/**
 * 사이드바 생성자가 await하는 구독/요청 마이크로태스크를 비운다. 전송 경로는 가드에서
 * 문서 확보(비동기)까지 await하므로 여유 있게 돌린다.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
}

function createBridge() {
  return {
    aiGetDocumentContext: vi.fn(async () => CONTEXT),
    aiRequestEdit: vi.fn(async (..._args: unknown[]) => 'req-1'),
    aiCancelRequest: vi.fn(async () => undefined),
    aiSetApiKey: vi.fn(async () => undefined),
    aiHasApiKey: vi.fn(async () => false),
    aiDeleteApiKey: vi.fn(async () => undefined),
    aiListModels: vi.fn(async (_provider: string, _baseUrl?: string) => [] as string[]),
    createNewDocumentAsync: vi.fn(async () => ({
      docInfo: { pageCount: 1 },
      message: '새 문서.hwp — 1페이지',
    }) as { docInfo: unknown; message: string } | null),
    aiSetDocumentSensitivity: vi.fn(async () => undefined),
    aiExtractText: vi.fn(async () => '추출된 본문'),
    currentDocId: vi.fn(() => 'doc-1' as string | null),
    getCursorRect: vi.fn(() => ({ pageIndex: 0, x: 0, y: 0, height: 10 })),
    getCursorRectByPath: vi.fn(() => ({ pageIndex: 0, x: 20, y: 40, height: 10 })),
    getPageInfo: vi.fn(() => ({ width: 100, height: 100 })),
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

/** 질문 모드에서 붙는 접두 지시(이게 프롬프트에 있으면 '질문'으로 보낸 것). */
const ASK_PREFIX = '다음은 편집 요청이 아니라 질문입니다';
const SWITCH_NOTICE = '작성 요청이라 편집 모드로 보냈습니다';

describe('F-a7b2c7ba AC-19a5d929: 질문 모드의 작성 요청은 편집 모드로 보낸다', () => {
  let doc: FakeDocument;
  let bridge: ReturnType<typeof createBridge>;
  let emit: ReturnType<typeof vi.fn>;

  function build(): AgentSidebar {
    const deps = {
      bridge,
      eventBus: { emit },
      getCanvasView: () => null,
      scrollContent: new FakeElement('div'),
      scrollContainer: new FakeElement('div'),
    };
    return new AgentSidebar(deps as unknown as AgentSidebarDeps);
  }

  function find(cls: string): FakeElement {
    const node = doc.body.querySelector(`.${cls}`);
    if (!node) throw new Error(`missing element: .${cls}`);
    return node;
  }

  function modeButtons(): { edit: FakeElement; ask: FakeElement } {
    const buttons = doc.body.querySelectorAll('.hop-ai-mode-btn');
    if (buttons.length !== 2) throw new Error(`mode buttons: ${buttons.length}`);
    return { edit: buttons[0], ask: buttons[1] };
  }

  function activeMode(): 'edit' | 'ask' | 'both' | 'none' {
    const { edit, ask } = modeButtons();
    const e = edit.classList.contains('hop-ai-mode-active');
    const a = ask.classList.contains('hop-ai-mode-active');
    return e && a ? 'both' : e ? 'edit' : a ? 'ask' : 'none';
  }

  function modeTriggerLabel(): string {
    return find('hop-ai-mode-trigger').querySelector('.hop-ai-dd-label')?.textContent ?? '';
  }

  /** 컴포저 아래 공용 상태줄(답변 버블 상태줄이 아님). */
  function composerStatus(): string {
    const composer = find('hop-ai-composer');
    const status = composer.children.filter(
      (c) => c.classList.contains('hop-ai-status') && !c.classList.contains('hop-ai-bubble-status'),
    );
    if (status.length !== 1) throw new Error(`composer status: ${status.length}`);
    return status[0].textContent ?? '';
  }

  /** 마지막 답변 버블의 상태줄. */
  function bubbleStatus(): string {
    const all = doc.body.querySelectorAll('.hop-ai-bubble-status');
    return all[all.length - 1]?.textContent ?? '';
  }

  async function selectProvider(id: string): Promise<void> {
    const select = find('hop-ai-provider');
    select.value = id;
    select.fire('change');
    await flush();
  }

  /** 새 사이드바를 띄우고 질문 모드로 바꾼다(키가 필요 없는 로컬 provider). */
  async function openInAskMode(): Promise<void> {
    build();
    await flush();
    await selectProvider('ollama');
    modeButtons().ask.click();
    expect(activeMode()).toBe('ask');
    expect(modeTriggerLabel()).toBe('질문');
  }

  async function send(prompt: string): Promise<void> {
    find('hop-ai-prompt').value = prompt;
    find('hop-ai-send').click();
    await flush();
  }

  /** aiRequestEdit로 실제 보낸 프롬프트(두 번째 인자). */
  function sentPrompt(): string {
    expect(bridge.aiRequestEdit).toHaveBeenCalledTimes(1);
    return String(bridge.aiRequestEdit.mock.calls[0][1]);
  }

  beforeEach(() => {
    captured = null;
    doc = new FakeDocument();
    (globalThis as Record<string, unknown>).document = doc;
    bridge = createBridge();
    emit = vi.fn();
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).document;
  });

  it("AC-19a5d929: 질문 모드에서 '보고서 초안 작성해줘'를 보내면 편집 모드로 바꾸고 질문 접두 없이 보내며 상태줄에 알린다", async () => {
    await openInAskMode();

    await send('보고서 초안 작성해줘');

    expect(activeMode()).toBe('edit');
    expect(modeTriggerLabel()).toBe('편집');
    const prompt = sentPrompt();
    expect(prompt).toContain('보고서 초안 작성해줘');
    expect(prompt).not.toContain(ASK_PREFIX);
    expect(composerStatus()).toContain(SWITCH_NOTICE);
  });

  it('AC-19a5d929: 전환해 보낸 요청의 응답 편집은 질문 답변으로 버려지지 않고 편집 제안으로 미리보기된다', async () => {
    await openInAskMode();
    await send('사업계획서 작성해줘');

    captured!.onEditReady?.({ requestId: 'req-1', actionScriptJson: JSON.stringify(REPLACE_SCRIPT) });
    await flush();

    expect(bubbleStatus()).toContain('제안 1건');
    expect(bubbleStatus()).not.toContain('답변 완료');
    expect(find('hop-ai-accept').disabled).toBe(false);
  });

  it("AC-19a5d929: 작성 요청이 아닌 '이 문서 요약해줘'는 질문 모드 그대로(질문 접두 포함, 전환 안내 없음) 보낸다", async () => {
    await openInAskMode();

    await send('이 문서 요약해줘');

    expect(activeMode()).toBe('ask');
    expect(modeTriggerLabel()).toBe('질문');
    expect(sentPrompt()).toContain(ASK_PREFIX);
    expect(composerStatus()).not.toContain(SWITCH_NOTICE);

    captured!.onEditReady?.({
      requestId: 'req-1',
      actionScriptJson: JSON.stringify({ edits: [], message: '요약입니다.' }),
    });
    await flush();
    expect(bubbleStatus()).toContain('답변 완료');
  });

  for (const prompt of ['회의록 써줘', '안내문 써 줘', '발표 자료 만들어줘', '기획안 초안 잡아줘', '결과 보고서를 작성해 주세요']) {
    it(`AC-19a5d929: 작성 동사 — 질문 모드의 '${prompt}'도 편집 모드로 보낸다`, async () => {
      await openInAskMode();

      await send(prompt);

      expect(activeMode()).toBe('edit');
      expect(sentPrompt()).not.toContain(ASK_PREFIX);
      expect(composerStatus()).toContain(SWITCH_NOTICE);
    });
  }

  it('AC-19a5d929: 이미 편집 모드면 작성 요청이어도 전환 안내를 띄우지 않는다', async () => {
    build();
    await flush();
    await selectProvider('ollama');
    expect(activeMode()).toBe('edit');

    await send('보고서 작성해줘');

    expect(activeMode()).toBe('edit');
    expect(sentPrompt()).not.toContain(ASK_PREFIX);
    expect(composerStatus()).not.toContain(SWITCH_NOTICE);
  });
});
