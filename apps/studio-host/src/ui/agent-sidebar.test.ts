import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiEventHandlers } from '@/core/ai-bridge';

/**
 * AgentSidebar(스펙 PR4) UI 동작 검증.
 *
 * 네이티브 `hop-ai-*` 이벤트는 `listenAiEvents`를 통해 들어오므로, 그 구독을
 * 가로채(captured) 테스트가 직접 델타/완료/실패 이벤트를 흘려보낸다. 실제
 * `parseActionScript`/`interpretAiFailure`는 그대로 사용한다.
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
  textContent: string | null = '';
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
  private classes = new Set<string>();
  private attrs = new Map<string, string>();

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
  }

  get classList() {
    const self = this;
    return {
      add(cls: string) {
        self.classes.add(cls);
      },
      remove(cls: string) {
        self.classes.delete(cls);
      },
      contains(cls: string) {
        return self.classes.has(cls) || self.className.split(/\s+/).includes(cls);
      },
      toggle(cls: string, force?: boolean) {
        const next = force ?? !self.classes.has(cls);
        if (next) self.classes.add(cls);
        else self.classes.delete(cls);
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

/** 사이드바 생성자가 await하는 구독/요청 마이크로태스크를 비운다. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function createBridge() {
  return {
    aiGetDocumentContext: vi.fn(async () => CONTEXT),
    aiRequestEdit: vi.fn(async () => 'req-1'),
    aiCancelRequest: vi.fn(async () => undefined),
    aiSetApiKey: vi.fn(async () => undefined),
    aiHasApiKey: vi.fn(async () => false),
    aiDeleteApiKey: vi.fn(async () => undefined),
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
    createTable: vi.fn(() => ({ ok: true, paraIdx: 0, controlIdx: 0 })),
    getCellParagraphLengthByPath: vi.fn(() => 0),
    insertTextInCellByPath: vi.fn(() => ''),
    deleteTextInCellByPath: vi.fn(() => ''),
    splitParagraphInCellByPath: vi.fn(() => ''),
    markDocumentDirty: vi.fn(),
  };
}

describe('AgentSidebar', () => {
  let doc: FakeDocument;
  let bridge: ReturnType<typeof createBridge>;
  let emit: ReturnType<typeof vi.fn>;

  let scrollContent: FakeElement;

  function build(withCanvas = false): AgentSidebar {
    scrollContent = new FakeElement('div');
    const canvasView = {
      getVirtualScroll: () => ({ getPageOffset: () => 0 }),
      getViewportManager: () => ({ getZoom: () => 1 }),
    };
    const deps = {
      bridge,
      eventBus: { emit },
      getCanvasView: () => (withCanvas ? canvasView : null),
      scrollContent,
      scrollContainer: new FakeElement('div'),
    };
    return new AgentSidebar(deps as unknown as AgentSidebarDeps);
  }

  function find(cls: string): FakeElement {
    const node = doc.body.querySelector(`.${cls}`);
    if (!node) throw new Error(`missing element: .${cls}`);
    return node;
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

  it('mounts the toggle button and panel into the document body', async () => {
    build();
    await flush();
    expect(doc.body.children.length).toBe(2);
    expect(find('hop-ai-prompt')).toBeTruthy();
    expect(captured).not.toBeNull();
  });

  it('keeps prior conversations as tabs on new chat (does not wipe)', async () => {
    build();
    await flush();
    find('hop-ai-prompt').value = '첫 지시';
    await selectProvider('ollama');
    find('hop-ai-send').click();
    await flush();

    // 유저 버블 + 어시스턴트 버블이 스레드에 쌓인다.
    expect(doc.body.querySelectorAll('.hop-ai-msg').length).toBe(2);
    expect(doc.body.querySelector('.hop-ai-msg-text')?.textContent).toBe('첫 지시');
    expect(find('hop-ai-prompt').value).toBe('');
    // 대화 시작 → 컴포저 하단(빈 상태 클래스 제거).
    expect(doc.body.querySelector('.hop-ai-panel')?.classList.contains('hop-ai-empty')).toBe(false);

    find('hop-ai-newchat').click();
    // 기존 대화는 보존(메시지 DOM 유지) + 새 탭 추가 + 새 활성 스레드는 비어 있음.
    expect(doc.body.querySelectorAll('.hop-ai-msg').length).toBe(2); // 안 지워짐
    expect(doc.body.querySelectorAll('.hop-ai-tab').length).toBe(2); // 탭 2개
    expect(doc.body.querySelector('.hop-ai-panel')?.classList.contains('hop-ai-empty')).toBe(true);
  });

  it('refuses to send when the prompt is empty', async () => {
    build();
    await flush();
    find('hop-ai-send').click();
    await flush();
    expect(bridge.aiRequestEdit).not.toHaveBeenCalled();
    expect(find('hop-ai-status').textContent).toBe('지시를 입력하세요.');
  });

  it('refuses to send when no document is open', async () => {
    bridge.currentDocId.mockReturnValue(null);
    build();
    await flush();
    find('hop-ai-prompt').value = '요약해줘';
    find('hop-ai-send').click();
    await flush();
    expect(bridge.aiRequestEdit).not.toHaveBeenCalled();
    expect(find('hop-ai-status').textContent).toBe('먼저 문서를 여세요.');
  });

  it('streams deltas, previews the diff, and applies on accept', async () => {
    build();
    await flush();
    find('hop-ai-prompt').value = '첫 문단 바꿔줘';
    await selectProvider('ollama');
    find('hop-ai-send').click();
    await flush();

    expect(bridge.aiGetDocumentContext).toHaveBeenCalledWith('doc-1', false, null);
    expect(bridge.aiRequestEdit).toHaveBeenCalledWith(
      'doc-1',
      '첫 문단 바꿔줘',
      'ollama',
      'llama3.1',
      null,
      null,
      null,
      null,
      null,
    );

    // 부분 응답(Raw JSON)은 덤프하지 않고 진행 표시만 한다.
    captured!.onDelta?.({ requestId: 'req-1', partialText: '{"edits":' });
    captured!.onDelta?.({ requestId: 'req-1', partialText: '[...]}' });
    expect(find('hop-ai-stream').textContent).toBe('AI가 편집을 작성 중…');

    captured!.onEditReady?.({
      requestId: 'req-1',
      actionScriptJson: JSON.stringify(REPLACE_SCRIPT),
    });
    // 완료 시 진행 표시는 사라진다.
    expect(find('hop-ai-stream').textContent).toBe('');

    expect(find('hop-ai-accept').disabled).toBe(false);
    expect(find('hop-ai-diff').children.length).toBe(1);
    expect(find('hop-ai-status').textContent).toContain('제안 1건');

    find('hop-ai-accept').click();

    // REPLACE는 기존 문단을 지우고 새 텍스트를 삽입한다(ai-apply).
    expect(bridge.deleteText).toHaveBeenCalled();
    expect(bridge.insertText).toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('document-changed', 'ai-edit');
    expect(bridge.markDocumentDirty).toHaveBeenCalled();
    expect(find('hop-ai-status').textContent).toContain('적용 완료');
    expect(find('hop-ai-accept').disabled).toBe(true);
    expect(find('hop-ai-diff').children.length).toBe(0);
  });

  it('does not touch the document when every edit is skipped (model left text empty)', async () => {
    build();
    await flush();
    find('hop-ai-prompt').value = '바꿔줘';
    await selectProvider('ollama');
    find('hop-ai-send').click();
    await flush();

    // 모델이 payload.text를 채우지 않은 REPLACE → 적용 시 원문이 지워지면 안 된다.
    captured!.onEditReady?.({
      requestId: 'req-1',
      actionScriptJson: JSON.stringify({
        edits: [{ command: 'REPLACE', target_id: 'sec[0].p[0]', payload: { type: 'paragraph' } }],
      }),
    });
    find('hop-ai-accept').click();

    expect(bridge.deleteText).not.toHaveBeenCalled();
    expect(bridge.insertText).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(bridge.markDocumentDirty).not.toHaveBeenCalled();
    expect(find('hop-ai-status').textContent).toContain('적용된 편집이 없습니다');
  });

  it('shows the on-page accept/reject bar and hides the in-bubble buttons', async () => {
    build(true); // 캔버스 있음 → 인라인 오버레이 배치 가능
    await flush();
    find('hop-ai-prompt').value = '표 값 바꿔줘';
    await selectProvider('ollama');
    find('hop-ai-send').click();
    await flush();

    captured!.onEditReady?.({
      requestId: 'req-1',
      actionScriptJson: JSON.stringify({
        edits: [
          {
            command: 'REPLACE',
            target_id: 'sec[0].p[0].tbl[2].cell[0].p[4].tbl[0].cell[11].p[0]',
            payload: { text: '1,000,000,000' },
          },
        ],
      }),
    });

    // 페이지 위 인라인 바가 떴고, 버블 내 승인/거절은 숨겨진다.
    expect(scrollContent.querySelector('.hop-ai-inline-bar')).not.toBeNull();
    expect(scrollContent.querySelector('.hop-ai-inline-after')?.textContent).toBe('1,000,000,000');
    expect(find('hop-ai-decision').classList.contains('hop-ai-hidden')).toBe(true);

    // 인라인 바의 승인이 실제 적용(by-path)로 이어진다.
    scrollContent.querySelector('.hop-ai-inline-accept')!.click();
    expect(bridge.insertTextInCellByPath).toHaveBeenCalled();
  });

  it('highlights on drag-over and ignores non image/text drops', async () => {
    build();
    await flush();
    const panel = doc.body.querySelector('.hop-ai-panel')!;

    const over = {
      dataTransfer: { types: ['Files'], dropEffect: '' },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    panel.fire('dragover', over);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(panel.classList.contains('hop-ai-dragover')).toBe(true);

    const drop = {
      dataTransfer: { files: [{ type: 'application/octet-stream', name: 'a.bin' }] },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    panel.fire('drop', drop);
    await flush();
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(panel.classList.contains('hop-ai-dragover')).toBe(false);
    expect(find('hop-ai-status').textContent).toContain('지원하지 않는 형식');
  });

  it('copies a panel text selection to the clipboard on Cmd/Ctrl+C', async () => {
    const writeText = vi.fn(async () => undefined);
    const getSelection = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('window', { getSelection });

    build();
    await flush();
    const panelNode = find('hop-ai-prompt');
    // 선택이 패널 안 노드에 걸쳐 있는 상태를 흉내낸다.
    getSelection.mockReturnValue({ toString: () => '복사할 내용', anchorNode: panelNode });

    const event = {
      key: 'c',
      metaKey: true,
      ctrlKey: false,
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };
    doc.fire('keydown', event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledWith('복사할 내용');

    // 선택이 패널 밖이면 가로채지 않는다(에디터가 처리).
    getSelection.mockReturnValue({ toString: () => '문서 본문', anchorNode: new FakeElement('div') });
    const outside = { key: 'c', metaKey: true, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() };
    doc.fire('keydown', outside);
    expect(outside.preventDefault).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('optimistically applies on ready and reverts via snapshot on reject', async () => {
    // 스냅샷 가능한 브리지(export/load/getSourceFormat)를 단다.
    const snapshotBytes = new Uint8Array([1, 2, 3]);
    const exportHwp = vi.fn(() => snapshotBytes);
    const loadDocument = vi.fn();
    const extra = bridge as Record<string, unknown>;
    extra.getSourceFormat = vi.fn(() => 'hwp');
    extra.exportHwp = exportHwp;
    extra.loadDocument = loadDocument;
    extra.fileName = 'doc.hwp';

    build(true);
    await flush();
    find('hop-ai-prompt').value = '바꿔줘';
    find('hop-ai-provider').value = 'ollama';
    find('hop-ai-send').click();
    await flush();

    captured!.onEditReady?.({
      requestId: 'req-1',
      actionScriptJson: JSON.stringify(REPLACE_SCRIPT),
    });

    // ready 시점에 이미 문서에 적용된다(승인 전 미리 반영).
    expect(exportHwp).toHaveBeenCalled(); // 스냅샷 확보
    expect(bridge.deleteText).toHaveBeenCalled();
    expect(bridge.insertText).toHaveBeenCalled();
    expect(find('hop-ai-status').textContent).toContain('미리 적용');

    // 새/바뀐 줄에 초록 변경 표시줄이 그려진다.
    expect(scrollContent.querySelector('.hop-ai-inline-changebar')).not.toBeNull();

    // 거절 → 스냅샷으로 복원(loadDocument 호출).
    scrollContent.querySelector('.hop-ai-inline-reject')!.click();
    expect(loadDocument).toHaveBeenCalledWith(snapshotBytes, 'doc.hwp');
  });

  it('ignores ready events for a different request id', async () => {
    build();
    await flush();
    find('hop-ai-prompt').value = '바꿔줘';
    find('hop-ai-send').click();
    await flush();

    captured!.onEditReady?.({
      requestId: 'other-req',
      actionScriptJson: JSON.stringify(REPLACE_SCRIPT),
    });

    expect(find('hop-ai-accept').disabled).toBe(true);
    expect(find('hop-ai-diff').children.length).toBe(0);
  });

  it('clears the preview without applying on reject', async () => {
    build();
    await flush();
    find('hop-ai-prompt').value = '바꿔줘';
    find('hop-ai-send').click();
    await flush();
    captured!.onEditReady?.({
      requestId: 'req-1',
      actionScriptJson: JSON.stringify(REPLACE_SCRIPT),
    });

    find('hop-ai-reject').click();

    expect(bridge.deleteText).not.toHaveBeenCalled();
    expect(bridge.insertText).not.toHaveBeenCalled();
    expect(find('hop-ai-diff').children.length).toBe(0);
    expect(find('hop-ai-accept').disabled).toBe(true);
    expect(find('hop-ai-status').textContent).toContain('거절');
  });

  it('surfaces a Korean message when the request fails', async () => {
    build();
    await flush();
    find('hop-ai-prompt').value = '바꿔줘';
    find('hop-ai-send').click();
    await flush();

    captured!.onEditFailed?.({ requestId: 'req-1', reason: 'broken json', code: 'PARSE_ERROR' });

    expect(find('hop-ai-status').textContent).toContain('편집 변환 실패');
    expect(find('hop-ai-accept').disabled).toBe(true);
  });

  async function selectProvider(id: string): Promise<void> {
    const select = find('hop-ai-provider');
    select.value = id;
    select.fire('change');
    await flush();
  }

  it('hides the key row for keyless providers and shows it for key providers', async () => {
    bridge.aiHasApiKey.mockResolvedValue(true);
    build();
    await flush();
    // 로컬 provider(ollama)는 키가 필요 없어 키 입력줄이 숨겨진다.
    await selectProvider('ollama');
    expect(find('hop-ai-key-row').classList.contains('hop-ai-hidden')).toBe(true);

    await selectProvider('anthropic');
    expect(find('hop-ai-key-row').classList.contains('hop-ai-hidden')).toBe(false);
    expect(bridge.aiHasApiKey).toHaveBeenCalledWith('anthropic');
    expect(find('hop-ai-key-status').textContent).toBe('키 저장됨');
  });

  it('saves an api key through the bridge and clears the input', async () => {
    build();
    await flush();
    await selectProvider('openai');

    find('hop-ai-key').value = 'sk-secret';
    find('hop-ai-key-save').click();
    await flush();

    expect(bridge.aiSetApiKey).toHaveBeenCalledWith('openai', 'sk-secret');
    expect(find('hop-ai-key').value).toBe('');
  });

  it('blocks sending when the selected provider has no stored key', async () => {
    build();
    await flush();
    await selectProvider('gemini'); // aiHasApiKey 기본값 false → 키 없음
    find('hop-ai-prompt').value = '요약해줘';

    find('hop-ai-send').click();
    await flush();

    expect(bridge.aiRequestEdit).not.toHaveBeenCalled();
    expect(find('hop-ai-status').textContent).toContain('API 키를 먼저 저장하세요');
  });

  it('opens the ⋯ menu, then Agent settings modal from it', async () => {
    build();
    await flush();
    expect(find('hop-ai-menu').classList.contains('hop-ai-hidden')).toBe(true);
    expect(find('hop-ai-modal').classList.contains('hop-ai-hidden')).toBe(true);

    // ⋯ → 메뉴 열림(최근 대화 + Agent 설정).
    find('hop-ai-settings-btn').click();
    expect(find('hop-ai-menu').classList.contains('hop-ai-hidden')).toBe(false);

    // 마지막 메뉴 항목('Agent 설정') 클릭 → 모달 열림, 메뉴 닫힘.
    const items = doc.body.querySelectorAll('.hop-ai-menu-item');
    items[items.length - 1].click();
    expect(find('hop-ai-modal').classList.contains('hop-ai-hidden')).toBe(false);
    expect(find('hop-ai-menu').classList.contains('hop-ai-hidden')).toBe(true);

    find('hop-ai-modal-close').click();
    expect(find('hop-ai-modal').classList.contains('hop-ai-hidden')).toBe(true);
  });

  it('populates the model dropdown per provider and sends the selected model', async () => {
    bridge.aiHasApiKey.mockResolvedValue(true); // gemini 키 있음 → 전송 허용
    build();
    await flush();
    await selectProvider('gemini');

    expect(find('hop-ai-model-select').value).toBe('gemini-2.5-flash');
    find('hop-ai-prompt').value = '요약';
    find('hop-ai-send').click();
    await flush();

    expect(bridge.aiRequestEdit).toHaveBeenCalledWith(
      'doc-1',
      '요약',
      'gemini',
      'gemini-2.5-flash',
      null,
      null,
      null,
      null,
      null,
    );
  });

  it('lets the user type a custom model via 직접 입력', async () => {
    bridge.aiHasApiKey.mockResolvedValue(true);
    build();
    await flush();
    await selectProvider('gemini');

    const select = find('hop-ai-model-select');
    select.value = '__custom__';
    select.fire('change');
    expect(find('hop-ai-model').classList.contains('hop-ai-hidden')).toBe(false);

    find('hop-ai-model').value = 'gemini-3-flash-preview';
    find('hop-ai-prompt').value = '요약';
    find('hop-ai-send').click();
    await flush();

    expect(bridge.aiRequestEdit).toHaveBeenCalledWith(
      'doc-1',
      '요약',
      'gemini',
      'gemini-3-flash-preview',
      null,
      null,
      null,
      null,
      null,
    );
  });

  async function toggleSensitive(on: boolean): Promise<void> {
    const box = find('hop-ai-sensitive');
    box.checked = on;
    box.fire('change');
    await flush();
  }

  it('marks the document sensitive through the bridge when toggled', async () => {
    build();
    await flush();
    await toggleSensitive(true);
    expect(bridge.aiSetDocumentSensitivity).toHaveBeenCalledWith('doc-1', true);
  });

  it('blocks external providers while the document is sensitive', async () => {
    build();
    await flush();
    await toggleSensitive(true);
    await selectProvider('anthropic');
    find('hop-ai-prompt').value = '요약해줘';

    find('hop-ai-send').click();
    await flush();

    expect(bridge.aiRequestEdit).not.toHaveBeenCalled();
    expect(find('hop-ai-status').textContent).toContain('민감 문서');
  });

  it('still allows local providers (ollama) on a sensitive document', async () => {
    build();
    await flush();
    await toggleSensitive(true);
    await selectProvider('ollama');
    find('hop-ai-prompt').value = '요약해줘';

    find('hop-ai-send').click();
    await flush();

    expect(bridge.aiRequestEdit).toHaveBeenCalledWith(
      'doc-1',
      '요약해줘',
      'ollama',
      'llama3.1',
      null,
      null,
      null,
      null,
      null,
    );
    expect(bridge.aiSetDocumentSensitivity).toHaveBeenCalledWith('doc-1', true);
  });

  it('forwards the caret position as the sliding-window anchor', async () => {
    (bridge as Record<string, unknown>).getCaretPosition = vi.fn(() => ({
      sectionIndex: 0,
      paragraphIndex: 7,
    }));
    build();
    await flush();
    find('hop-ai-prompt').value = '바꿔줘';
    await selectProvider('ollama');
    find('hop-ai-send').click();
    await flush();

    expect(bridge.aiGetDocumentContext).toHaveBeenCalledWith('doc-1', false, 'sec[0].p[7]');
    expect(bridge.aiRequestEdit).toHaveBeenCalledWith(
      'doc-1',
      '바꿔줘',
      'ollama',
      'llama3.1',
      'sec[0].p[7]',
      null,
      null,
      null,
      null,
    );
  });

  it('sends via the local Claude CLI provider without an API key', async () => {
    build();
    await flush();
    await selectProvider('claude-cli');
    // CLI는 키가 필요 없어 키 입력줄이 숨겨진다.
    expect(find('hop-ai-key-row').classList.contains('hop-ai-hidden')).toBe(true);

    find('hop-ai-prompt').value = '첫 문단 바꿔줘';
    find('hop-ai-send').click();
    await flush();

    expect(bridge.aiRequestEdit).toHaveBeenCalledWith(
      'doc-1',
      '첫 문단 바꿔줘',
      'claude-cli',
      'default',
      null,
      null,
      null,
      null,
      null,
    );
  });

  it('requires a base URL for the openai-compat provider', async () => {
    build();
    await flush();
    await selectProvider('openai-compat');
    expect(find('hop-ai-custom-row').classList.contains('hop-ai-hidden')).toBe(false);
    find('hop-ai-prompt').value = '요약해줘';

    find('hop-ai-send').click();
    await flush();

    expect(bridge.aiRequestEdit).not.toHaveBeenCalled();
    expect(find('hop-ai-status').textContent).toContain('Base URL');
  });

  it('fills a preset and forwards the base URL to the request (Groq)', async () => {
    build();
    await flush();
    await selectProvider('openai-compat');

    const preset = find('hop-ai-preset');
    preset.value = 'groq';
    preset.fire('change');
    expect(find('hop-ai-base-url').value).toBe('https://api.groq.com/openai');
    expect(find('hop-ai-model').value).toBe('llama-3.1-8b-instant');

    find('hop-ai-prompt').value = '요약해줘';
    find('hop-ai-send').click();
    await flush();

    expect(bridge.aiRequestEdit).toHaveBeenCalledWith(
      'doc-1',
      '요약해줘',
      'openai-compat',
      'llama-3.1-8b-instant',
      null,
      'https://api.groq.com/openai',
      null,
      null,
      null,
    );
  });
});
