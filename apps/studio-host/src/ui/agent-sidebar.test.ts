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
  private classes = new Set<string>();
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

const TWO_EDIT_SCRIPT = {
  edits: [
    {
      command: 'REPLACE',
      target_id: 'sec[0].p[0]',
      payload: { type: 'paragraph', text: '첫째 수정' },
    },
    {
      command: 'REPLACE',
      target_id: 'sec[0].p[1]',
      payload: { type: 'paragraph', text: '둘째 수정' },
    },
  ],
};

/** 사이드바 생성자가 await하는 구독/요청 마이크로태스크를 비운다. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
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
    mergeTableCells: vi.fn(() => ({ ok: true, cellCount: 1 })),
    getCellParagraphLength: vi.fn(() => 0),
    insertTextInCell: vi.fn(() => ''),
    deleteTextInCell: vi.fn(() => ''),
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
      'llama3.2',
      null,
      null,
      null,
      null,
      null,
    );

    // 부분 응답(Raw JSON)은 덤프하지 않고 점 애니메이션(생각 중)만 표시한다.
    captured!.onDelta?.({ requestId: 'req-1', partialText: '{"edits":' });
    captured!.onDelta?.({ requestId: 'req-1', partialText: '[...]}' });
    expect(find('hop-ai-stream').querySelector('.hop-ai-thinking')).not.toBeNull();

    captured!.onEditReady?.({
      requestId: 'req-1',
      actionScriptJson: JSON.stringify(REPLACE_SCRIPT),
    });
    // 완료 시 진행 표시(점 애니메이션)는 사라진다.
    expect(find('hop-ai-stream').textContent).toBe('');
    expect(find('hop-ai-stream').querySelector('.hop-ai-thinking')).toBeNull();

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

  it('selects all composer text on Cmd/Ctrl+A (macOS and Windows)', async () => {
    build();
    await flush();
    const prompt = find('hop-ai-prompt');

    let prevented = 0;
    prompt.fire('keydown', { key: 'a', metaKey: true, preventDefault: () => (prevented += 1) });
    expect(prompt.selectCalled).toBe(1);
    expect(prevented).toBe(1);

    // Windows: Ctrl+A.
    prompt.fire('keydown', { key: 'a', ctrlKey: true, preventDefault: () => (prevented += 1) });
    expect(prompt.selectCalled).toBe(2);

    // Enter는 여전히 전송이고 전체선택을 트리거하지 않는다.
    prompt.fire('keydown', { key: 'Enter', preventDefault: () => {} });
    expect(prompt.selectCalled).toBe(2);
  });

  it('shows the on-page accept/reject bar AND keeps the in-bubble buttons available', async () => {
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

    // 페이지 위 인라인 바가 뜨더라도, 버블 내 승인/거절은 항상 노출된다(인라인 바가
    // 안 뜨는 표 삽입 등에서도 승인 수단을 잃지 않도록).
    expect(doc.body.querySelector('.hop-ai-inline-bar')).not.toBeNull();
    expect(scrollContent.querySelector('.hop-ai-inline-after')?.textContent).toBe('1,000,000,000');
    expect(find('hop-ai-decision').classList.contains('hop-ai-hidden')).toBe(false);

    // 인라인 바의 승인이 실제 적용(by-path)로 이어진다.
    doc.body.querySelector('.hop-ai-inline-accept')!.click();
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

    // 거절 → 스냅샷으로 복원(loadDocument 호출). 바는 뷰포트 고정이라 body에 있다.
    doc.body.querySelector('.hop-ai-inline-reject')!.click();
    expect(loadDocument).toHaveBeenCalledWith(snapshotBytes, 'doc.hwp');
  });

  // ── 편집 단위별 수락/거절 (F-dc4b99) ─────────────────────────

  /** 전송 후 ready 이벤트까지 흘려보내는 공통 준비. */
  async function sendAndReady(script: unknown): Promise<void> {
    find('hop-ai-prompt').value = '바꿔줘';
    await selectProvider('ollama');
    find('hop-ai-send').click();
    await flush();
    captured!.onEditReady?.({ requestId: 'req-1', actionScriptJson: JSON.stringify(script) });
  }

  it('shows per-edit ✓/✗ controls for 2+ edits but not for a single edit (AC-8d733a)', async () => {
    build();
    await flush();
    await sendAndReady(REPLACE_SCRIPT);
    expect(doc.body.querySelectorAll('.hop-ai-diff-drop').length).toBe(0);

    find('hop-ai-reject').click();
    await sendAndReady(TWO_EDIT_SCRIPT);
    expect(doc.body.querySelectorAll('.hop-ai-diff-drop').length).toBe(2);
    expect(doc.body.querySelectorAll('.hop-ai-diff-keep').length).toBe(2);
  });

  it('excludes an individually rejected edit and applies the rest on accept (AC-491094/AC-12976a)', async () => {
    build();
    await flush();
    await sendAndReady(TWO_EDIT_SCRIPT);

    // 첫 편집만 제외 — 나머지 미리보기(diff 행)는 유지된다.
    doc.body.querySelectorAll('.hop-ai-diff-drop')[0].click();
    const rows = doc.body.querySelectorAll('.hop-ai-diff-item');
    expect(rows.length).toBe(2);
    expect(rows[0].classList.contains('hop-ai-diff-item-rejected')).toBe(true);
    expect(rows[1].classList.contains('hop-ai-diff-item-rejected')).toBe(false);
    expect(find('hop-ai-status').textContent).toContain('1/2건 적용 예정');

    find('hop-ai-accept').click();

    // 거절된 첫 편집(p[0])은 적용되지 않고 둘째(p[1])만 적용된다.
    expect(bridge.insertText).toHaveBeenCalledTimes(1);
    expect(bridge.insertText).toHaveBeenCalledWith(0, 1, 0, '둘째 수정');
    expect(emit).toHaveBeenCalledWith('document-changed', 'ai-edit');
    expect(bridge.markDocumentDirty).toHaveBeenCalled();
    expect(find('hop-ai-status').textContent).toContain('적용 완료: 1건');
  });

  it('re-includes a rejected edit when ✓ is clicked again', async () => {
    build();
    await flush();
    await sendAndReady(TWO_EDIT_SCRIPT);

    doc.body.querySelectorAll('.hop-ai-diff-drop')[0].click();
    expect(find('hop-ai-status').textContent).toContain('1/2건 적용 예정');
    doc.body.querySelectorAll('.hop-ai-diff-keep')[0].click();
    expect(find('hop-ai-status').textContent).toContain('2/2건 적용 예정');

    find('hop-ai-accept').click();
    expect(bridge.insertText).toHaveBeenCalledTimes(2);
  });

  it('reapplies only the remaining edits via snapshot on per-edit reject (optimistic path)', async () => {
    const snapshotBytes = new Uint8Array([9, 9]);
    const extra = bridge as Record<string, unknown>;
    extra.getSourceFormat = vi.fn(() => 'hwp');
    extra.exportHwp = vi.fn(() => snapshotBytes);
    const loadDocument = vi.fn();
    extra.loadDocument = loadDocument;
    extra.fileName = 'doc.hwp';

    build(true);
    await flush();
    await sendAndReady(TWO_EDIT_SCRIPT);

    // ready 시점에 두 편집 모두 미리 적용된다.
    expect(bridge.insertText).toHaveBeenCalledTimes(2);

    // 첫 편집 제외 → 스냅샷으로 되돌린 뒤 남은 편집만 재적용된다.
    doc.body.querySelectorAll('.hop-ai-diff-drop')[0].click();
    expect(loadDocument).toHaveBeenCalledWith(snapshotBytes, 'doc.hwp');
    expect(bridge.insertText).toHaveBeenCalledTimes(3);
    expect(bridge.insertText).toHaveBeenLastCalledWith(0, 1, 0, '둘째 수정');
    // 남은 편집의 하이라이트(초록 변경 표시줄)는 유지된다.
    expect(scrollContent.querySelector('.hop-ai-inline-changebar')).not.toBeNull();
    expect(find('hop-ai-status').textContent).toContain('1/2건 적용 예정');

    // 승인 — 문서엔 이미 남은 편집만 반영돼 있으므로 그대로 확정된다.
    find('hop-ai-accept').click();
    expect(bridge.insertText).toHaveBeenCalledTimes(3); // 추가 적용 없음
    expect(bridge.markDocumentDirty).toHaveBeenCalled();
    expect(find('hop-ai-status').textContent).toContain('적용 완료: 1건');
  });

  it('rolls back to the snapshot when reapply errors mid per-edit reject (AC-95b4b0)', async () => {
    const snapshotBytes = new Uint8Array([7]);
    const extra = bridge as Record<string, unknown>;
    extra.getSourceFormat = vi.fn(() => 'hwp');
    extra.exportHwp = vi.fn(() => snapshotBytes);
    const loadDocument = vi.fn();
    extra.loadDocument = loadDocument;
    extra.fileName = 'doc.hwp';

    build(true);
    await flush();
    await sendAndReady(TWO_EDIT_SCRIPT);

    // 재적용 직후의 document-changed emit(3번째 호출)에서 오류를 일으킨다.
    emit.mockImplementation(() => {
      if (emit.mock.calls.length >= 3) throw new Error('boom');
    });
    doc.body.querySelectorAll('.hop-ai-diff-drop')[0].click();

    // 부분 적용 상태로 남지 않고 스냅샷으로 전체 롤백된다(재적용 1회 + 롤백 1회).
    expect(loadDocument).toHaveBeenCalledTimes(2);
    expect(loadDocument).toHaveBeenLastCalledWith(snapshotBytes, 'doc.hwp');
    expect(find('hop-ai-status').textContent).toContain('되돌렸습니다');
    expect(find('hop-ai-accept').disabled).toBe(true);
    expect(find('hop-ai-diff').children.length).toBe(0);
  });

  // ── 문서 전체 교정 패스 (F-55a6a4) ──────────────────────────

  /** 빠른 작업 칩 클릭을 흉내낸다(위임 핸들러는 closest('[data-action]')를 쓴다). */
  function clickQuickAction(action: string): void {
    find('hop-ai-quick').fire('click', {
      target: { closest: () => ({ dataset: { action } }) },
    });
  }

  it('scans the whole document, lists issues without editing, and applies one on demand', async () => {
    bridge.aiGetDocumentContext.mockResolvedValue({
      document_metadata: { total_sections: 1 },
      content: [
        { type: 'paragraph', id: 'sec[0].p[0]', text: '사업이 시작 됬다' },
        { type: 'paragraph', id: 'sec[0].p[1]', text: '정상 문장' },
      ],
    });
    build(true);
    await flush();
    await selectProvider('ollama');
    clickQuickAction('proofread');
    await flush();

    // 전체 컨텍스트(fullDocument=true)를 받아 구간 ID들을 스코프로 요청한다.
    expect(bridge.aiGetDocumentContext).toHaveBeenCalledWith('doc-1', false, null, true);
    expect(bridge.aiRequestEdit).toHaveBeenCalledTimes(1);
    expect(bridge.aiRequestEdit.mock.calls[0][9]).toEqual(['sec[0].p[0]', 'sec[0].p[1]']);

    captured!.onEditReady?.({
      requestId: 'req-1',
      actionScriptJson: JSON.stringify({
        edits: [
          {
            command: 'REPLACE',
            target_id: 'sec[0].p[0]',
            payload: { type: 'paragraph', text: '사업이 시작됐다', reason: "맞춤법: '됬다'→'됐다'" },
          },
        ],
      }),
    });
    await flush();

    // 문서는 아직 수정되지 않고 이슈 목록만 뜬다.
    expect(bridge.insertText).not.toHaveBeenCalled();
    expect(doc.body.querySelectorAll('.hop-ai-issue').length).toBe(1);
    expect(doc.body.querySelector('.hop-ai-issue-reason')?.textContent).toContain('맞춤법');
    expect(find('hop-ai-status').textContent).toContain('이슈 1건');

    // 이슈 행 클릭 → 해당 위치로 점프하며 하이라이트가 그려진다.
    doc.body.querySelector('.hop-ai-issue')!.fire('click');
    expect(scrollContent.querySelector('.hop-ai-proofread-flash')).not.toBeNull();

    // '수정 적용' → 그 문단만 REPLACE 되고 해결 처리된다.
    doc.body.querySelector('.hop-ai-issue-apply')!.click();
    expect(bridge.deleteText).toHaveBeenCalled();
    expect(bridge.insertText).toHaveBeenCalledWith(0, 0, 0, '사업이 시작됐다');
    expect(emit).toHaveBeenCalledWith('document-changed', 'ai-edit');
    expect(bridge.markDocumentDirty).toHaveBeenCalled();
    expect(
      doc.body.querySelector('.hop-ai-issue')!.classList.contains('hop-ai-issue-resolved'),
    ).toBe(true);
  });

  it('splits a long document into chunks and scans sequentially with progress (AC4)', async () => {
    const long = '가'.repeat(8000); // 2문단 × 8000자 > 9000자 한도 → 2구간
    bridge.aiGetDocumentContext.mockResolvedValue({
      document_metadata: { total_sections: 1 },
      content: [
        { type: 'paragraph', id: 'sec[0].p[0]', text: long },
        { type: 'paragraph', id: 'sec[0].p[1]', text: long },
      ],
    });
    build();
    await flush();
    await selectProvider('ollama');
    clickQuickAction('proofread');
    await flush();

    // 1번째 구간만 먼저 요청되고 진행률이 표시된다.
    expect(bridge.aiRequestEdit).toHaveBeenCalledTimes(1);
    expect(bridge.aiRequestEdit.mock.calls[0][9]).toEqual(['sec[0].p[0]']);
    expect(find('hop-ai-status').textContent).toContain('구간 1/2');

    captured!.onEditReady?.({ requestId: 'req-1', actionScriptJson: '{"edits":[]}' });
    await flush();

    // 1구간 완료 후에야 2번째 구간이 요청된다(순차).
    expect(bridge.aiRequestEdit).toHaveBeenCalledTimes(2);
    expect(bridge.aiRequestEdit.mock.calls[1][9]).toEqual(['sec[0].p[1]']);
    expect(find('hop-ai-status').textContent).toContain('구간 2/2');

    captured!.onEditReady?.({ requestId: 'req-1', actionScriptJson: '{"edits":[]}' });
    await flush();
    expect(find('hop-ai-status').textContent).toContain('이슈 없음');
  });

  it('drops a chart edit with bad data and reports which value failed (F-d0dce3 AC4)', async () => {
    build();
    await flush();
    await sendAndReady({
      edits: [
        {
          command: 'INSERT_AFTER',
          target_id: 'sec[0].p[0]',
          payload: {
            type: 'chart',
            chart_data: {
              kind: 'bar',
              labels: ['1분기', '2분기'],
              series: [{ name: '매출', values: [120, '10억'] }],
            },
          },
        },
      ],
    });

    // 편집은 제외되고(문서 무변경) 사유가 답변으로 표시된다.
    expect(bridge.insertText).not.toHaveBeenCalled();
    const msg = doc.body.querySelectorAll('.hop-ai-msg-text');
    const lastMsg = msg[msg.length - 1];
    expect(lastMsg?.textContent).toContain('차트를 만들지 못했습니다');
    expect(lastMsg?.textContent).toContain('10억');
  });

  it('streams the generated body text into the bubble as it arrives (Cursor-style)', async () => {
    build();
    await flush();
    await selectProvider('ollama');
    find('hop-ai-prompt').value = '사업계획서 써줘';
    find('hop-ai-send').click();
    await flush();

    // 아직 본문(text)이 없는 조각 → 점 애니메이션 유지.
    captured!.onDelta?.({ requestId: 'req-1', partialText: '{"edits":[{"command":"INSERT_AFTER",' });
    expect(find('hop-ai-stream').querySelector('.hop-ai-thinking')).not.toBeNull();

    // 완성된 payload.text가 들어오면 그 본문이 말풍선에 흘러나온다.
    captured!.onDelta?.({
      requestId: 'req-1',
      partialText:
        '"target_id":"sec[0].p[0]","payload":{"type":"paragraph","text":"1. 사업 개요"}},' +
        '{"command":"INSERT_AFTER","target_id":"sec[0].p[0]","payload":{"text":"본 사업은 플라스틱 도장면을',
    });
    const streamed = find('hop-ai-stream').textContent ?? '';
    expect(streamed).toContain('1. 사업 개요');
    // 따옴표가 아직 안 닫힌 문장은 다음 델타에서 나타난다(쓰다 만 조각 미표시).
    expect(streamed).not.toContain('플라스틱');

    captured!.onDelta?.({ requestId: 'req-1', partialText: ' 검사한다."}}]}' });
    expect(find('hop-ai-stream').textContent).toContain('플라스틱 도장면을 검사한다.');
  });

  it('edits a past message in place and restarts the conversation from that line', async () => {
    build();
    await flush();
    await selectProvider('ollama');
    // 1차 대화.
    find('hop-ai-prompt').value = '첫 지시';
    find('hop-ai-send').click();
    await flush();
    captured!.onEditReady?.({
      requestId: 'req-1',
      actionScriptJson: '{"edits":[],"message":"답1"}',
    });
    // 2차 대화.
    find('hop-ai-prompt').value = '둘째 지시';
    find('hop-ai-send').click();
    await flush();
    captured!.onEditReady?.({
      requestId: 'req-1',
      actionScriptJson: '{"edits":[],"message":"답2"}',
    });
    expect(doc.body.querySelectorAll('.hop-ai-msg').length).toBe(4);

    // 첫 사용자 말풍선의 ✎ 수정 → 말풍선이 그 자리에서 입력창으로 바뀐다(Cursor식).
    doc.body.querySelectorAll('.hop-ai-msg-edit')[0].click();
    const editbox = doc.body.querySelector('.hop-ai-msg-editbox')!;
    expect(editbox.value).toBe('첫 지시');

    // 고쳐서 보내면 그 줄부터 다시 — 그 아래 대화(답1·둘째 지시·답2)는 제거된다.
    editbox.value = '고친 지시';
    doc.body.querySelector('.hop-ai-msg-edit-send')!.click();
    await flush();

    const texts = doc.body
      .querySelectorAll('.hop-ai-msg-text')
      .map((n) => n.textContent ?? '');
    expect(texts).toContain('고친 지시');
    expect(texts).not.toContain('첫 지시');
    expect(texts).not.toContain('둘째 지시');
    expect(texts).not.toContain('답2');
    // 수정된 텍스트로 재요청이 나간다.
    const last = bridge.aiRequestEdit.mock.calls.at(-1)!;
    expect(last[1]).toBe('고친 지시');
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

  /**
   * F-ec1f3481 — 모델 목록을 provider에서 조회한다. 사용자가 "claude-opus-5" 같은 정확한
   * ID를 외워 타이핑하지 않아도 되는 것이 이 기능의 전부다.
   */
  function modelOptions(): string[] {
    return find('hop-ai-model-select').children.map((node) => node.value);
  }

  it('F-ec1f3481 AC-001: 새로 고침이 provider 조회 결과로 모델 드롭다운을 채운다', async () => {
    bridge.aiListModels.mockResolvedValue([
      'claude-haiku-4-5',
      'claude-opus-6',
      'claude-sonnet-5',
    ]);
    build();
    await flush();
    await selectProvider('anthropic');

    find('hop-ai-model-refresh').click();
    await flush();

    expect(bridge.aiListModels).toHaveBeenCalledWith('anthropic', undefined);
    // 조회에만 있던 신모델도 목록에 뜬다 — 카탈로그를 손대지 않아도 최신을 고를 수 있다.
    expect(modelOptions()).toEqual([
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'claude-opus-6',
      '__custom__',
    ]);
    expect(find('hop-ai-model-select').value).toBe('claude-sonnet-5');
    expect(find('hop-ai-status').textContent).toContain('모델 3개');
  });

  it('F-ec1f3481 AC-001: openai-compat은 Base URL과 함께 조회한다', async () => {
    bridge.aiListModels.mockResolvedValue(['llama-3.3-70b-versatile']);
    build();
    await flush();
    await selectProvider('openai-compat');
    find('hop-ai-base-url').value = 'https://api.groq.com/openai';

    find('hop-ai-model-refresh').click();
    await flush();

    expect(bridge.aiListModels).toHaveBeenCalledWith(
      'openai-compat',
      'https://api.groq.com/openai',
    );
  });

  it('F-ec1f3481 AC-002: 조회 전 기본 선택이 현행 세대다', async () => {
    build();
    await flush();
    await selectProvider('anthropic');

    expect(find('hop-ai-model-select').value).toBe('claude-opus-5');
    expect(modelOptions()).not.toContain('claude-3-5-haiku-latest');
  });

  it('F-ec1f3481 AC-003: 조회가 실패하면 내장 목록을 유지하고 사유만 알린다', async () => {
    bridge.aiListModels.mockRejectedValue(new Error('API 키가 없습니다'));
    build();
    await flush();
    await selectProvider('anthropic');
    const before = modelOptions();

    find('hop-ai-model-refresh').click();
    await flush();

    expect(modelOptions()).toEqual(before);
    expect(find('hop-ai-model-select').value).toBe('claude-opus-5');
    expect(find('hop-ai-status').textContent).toContain('불러오지 못했습니다');
    // 실패가 버튼을 영구히 잠그지 않는다(키를 저장한 뒤 다시 누를 수 있어야 한다).
    expect(find('hop-ai-model-refresh').disabled).toBe(false);
  });

  it('F-ec1f3481 AC-003: 쓸 수 있는 모델이 없으면 기본 목록을 유지한다', async () => {
    bridge.aiListModels.mockResolvedValue(['whisper-1', 'dall-e-3']);
    build();
    await flush();
    await selectProvider('openai');

    find('hop-ai-model-refresh').click();
    await flush();

    expect(modelOptions()).toContain('gpt-5-mini');
    expect(find('hop-ai-status').textContent).toContain('기본 목록을 유지');
  });

  it('F-ec1f3481 AC-004: CLI 위임은 조회를 시도하지 않고 별칭을 유지한다', async () => {
    build();
    await flush();
    await selectProvider('claude-cli');

    expect(find('hop-ai-model-refresh').disabled).toBe(true);
    expect(modelOptions()).toEqual(['default', 'sonnet', 'opus', 'haiku', '__custom__']);

    find('hop-ai-model-refresh').click();
    await flush();

    expect(bridge.aiListModels).not.toHaveBeenCalled();
  });

  it('F-ec1f3481: 조회 결과는 provider별로 캐시되어 재조회 없이 복원된다', async () => {
    bridge.aiListModels.mockResolvedValue(['claude-opus-5', 'claude-opus-9']);
    build();
    await flush();
    await selectProvider('anthropic');
    find('hop-ai-model-refresh').click();
    await flush();

    await selectProvider('ollama');
    expect(modelOptions()).not.toContain('claude-opus-9');
    await selectProvider('anthropic');

    expect(modelOptions()).toContain('claude-opus-9');
    expect(bridge.aiListModels).toHaveBeenCalledTimes(1);
  });

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

    expect(find('hop-ai-model-select').value).toBe('gemini-flash-latest');
    find('hop-ai-prompt').value = '요약';
    find('hop-ai-send').click();
    await flush();

    expect(bridge.aiRequestEdit).toHaveBeenCalledWith(
      'doc-1',
      '요약',
      'gemini',
      'gemini-flash-latest',
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
      'llama3.2',
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
      'llama3.2',
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
