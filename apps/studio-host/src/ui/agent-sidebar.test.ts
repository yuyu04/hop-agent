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

  fire(type: string): void {
    this.listeners.get(type)?.forEach((fn) => fn({}));
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

  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
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
    currentDocId: vi.fn(() => 'doc-1' as string | null),
    getCursorRect: vi.fn(() => ({ pageIndex: 0, x: 0, y: 0, height: 10 })),
    getPageInfo: vi.fn(() => ({ width: 100, height: 100 })),
    getParagraphLength: vi.fn(() => 2),
    insertText: vi.fn(() => ''),
    deleteText: vi.fn(() => ''),
    splitParagraph: vi.fn(() => ''),
    mergeParagraph: vi.fn(() => ''),
    markDocumentDirty: vi.fn(),
  };
}

describe('AgentSidebar', () => {
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
    find('hop-ai-provider').value = 'mock';
    find('hop-ai-send').click();
    await flush();

    expect(bridge.aiGetDocumentContext).toHaveBeenCalledWith('doc-1', false, null);
    expect(bridge.aiRequestEdit).toHaveBeenCalledWith(
      'doc-1',
      '첫 문단 바꿔줘',
      'mock',
      'mock-1',
      null,
      null,
    );

    captured!.onDelta?.({ requestId: 'req-1', partialText: '부분 ' });
    captured!.onDelta?.({ requestId: 'req-1', partialText: '응답' });
    expect(find('hop-ai-stream').textContent).toBe('부분 응답');

    captured!.onEditReady?.({
      requestId: 'req-1',
      actionScriptJson: JSON.stringify(REPLACE_SCRIPT),
    });

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
    find('hop-ai-provider').value = 'mock';
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
    expect(find('hop-ai-status').textContent).toBe('제안을 거부했습니다.');
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
    // 기본 provider(mock)는 키가 필요 없다.
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

  it('opens the options panel only when the ⚙ button is pressed', async () => {
    build();
    await flush();
    expect(find('hop-ai-settings').classList.contains('hop-ai-hidden')).toBe(true);

    find('hop-ai-settings-btn').click();
    expect(find('hop-ai-settings').classList.contains('hop-ai-hidden')).toBe(false);

    find('hop-ai-settings-btn').click();
    expect(find('hop-ai-settings').classList.contains('hop-ai-hidden')).toBe(true);
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
    find('hop-ai-provider').value = 'mock';
    find('hop-ai-send').click();
    await flush();

    expect(bridge.aiGetDocumentContext).toHaveBeenCalledWith('doc-1', false, 'sec[0].p[7]');
    expect(bridge.aiRequestEdit).toHaveBeenCalledWith(
      'doc-1',
      '바꿔줘',
      'mock',
      'mock-1',
      'sec[0].p[7]',
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
    );
  });
});
