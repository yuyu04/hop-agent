/**
 * 최소 AI Agent Sidebar(스펙 1·4·7장).
 *
 * 지시 입력 → `aiRequestEdit` → `hop-ai-*` 이벤트 수신 → 가상 Diff 미리보기
 * (사이드바 목록 + 페이지 하이라이트) → 승인 시에만 라이브 WASM 문서에 적용.
 * 데스크톱(Tauri) 런타임에서만 동작한다.
 */

import '@/styles/agent-sidebar.css';
import {
  interpretAiFailure,
  listenAiEvents,
  parseActionScript,
  type ActionScript,
  type AiEditFailed,
  type AiEditReady,
  type AiEventUnsubscribe,
  type AiStreamDelta,
  type DocumentContext,
} from '@/core/ai-bridge';
import type { AiBridgeApi } from '@/core/tauri-bridge';
import { applyActionScript, parseParagraphTarget, type WasmEditing } from '@/core/ai-apply';
import { buildDiffModel, type DiffItem } from '@/core/ai-diff';
import { AiSessionMachine } from '@/core/ai-session';
import { clearHighlights, showHighlights, type HighlightTarget } from '@/ui/ai-highlight';
import type { CursorRect, PageInfo } from '@/core/types';

type AgentBridge = AiBridgeApi &
  WasmEditing & {
    currentDocId(): string | null;
    getCursorRect(sec: number, para: number, charOffset: number): CursorRect;
    getPageInfo(pageIndex: number): PageInfo;
    markDocumentDirty?(): void;
  };

interface CanvasViewLike {
  getVirtualScroll(): { getPageOffset(pageIndex: number): number };
  getViewportManager(): { getZoom(): number };
}

export interface AgentSidebarDeps {
  bridge: AgentBridge;
  eventBus: { emit(name: string, payload?: unknown): void };
  getCanvasView(): CanvasViewLike | null;
  scrollContent: HTMLElement;
  scrollContainer: HTMLElement;
}

const PROVIDERS = ['mock', 'openai', 'anthropic', 'gemini', 'ollama'] as const;

export class AgentSidebar {
  private readonly panel: HTMLElement;
  private readonly promptInput: HTMLTextAreaElement;
  private readonly providerSelect: HTMLSelectElement;
  private readonly modelInput: HTMLInputElement;
  private readonly streamArea: HTMLElement;
  private readonly diffArea: HTMLElement;
  private readonly statusArea: HTMLElement;
  private readonly acceptBtn: HTMLButtonElement;
  private readonly rejectBtn: HTMLButtonElement;

  private readonly session: AiSessionMachine;
  private unsubscribe: AiEventUnsubscribe | null = null;
  private requestId: string | null = null;
  private context: DocumentContext | null = null;
  private pendingScript: ActionScript | null = null;

  constructor(private readonly deps: AgentSidebarDeps) {
    this.session = new AiSessionMachine({ onRollback: () => this.clearPreview() });
    const built = buildPanel();
    this.panel = built.panel;
    this.promptInput = built.promptInput;
    this.providerSelect = built.providerSelect;
    this.modelInput = built.modelInput;
    this.streamArea = built.streamArea;
    this.diffArea = built.diffArea;
    this.statusArea = built.statusArea;
    this.acceptBtn = built.acceptBtn;
    this.rejectBtn = built.rejectBtn;

    built.sendBtn.addEventListener('click', () => void this.send());
    built.cancelBtn.addEventListener('click', () => void this.cancel());
    this.acceptBtn.addEventListener('click', () => this.accept());
    this.rejectBtn.addEventListener('click', () => this.reject());
    built.closeBtn.addEventListener('click', () => this.toggle(false));
    built.toggleBtn.addEventListener('click', () => this.toggle());

    document.body.appendChild(built.toggleBtn);
    document.body.appendChild(this.panel);
    this.setPreviewEnabled(false);
    void this.subscribe();
  }

  private async subscribe(): Promise<void> {
    this.unsubscribe = await listenAiEvents({
      onDelta: (d) => this.onDelta(d),
      onEditReady: (r) => this.onReady(r),
      onEditFailed: (f) => this.onFailed(f),
    });
  }

  toggle(open?: boolean): void {
    const show = open ?? !this.panel.classList.contains('open');
    this.panel.classList.toggle('open', show);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.clearPreview();
    this.panel.remove();
  }

  private async send(): Promise<void> {
    const prompt = this.promptInput.value.trim();
    if (!prompt) {
      this.setStatus('지시를 입력하세요.', 'warn');
      return;
    }
    const docId = this.deps.bridge.currentDocId();
    if (!docId) {
      this.setStatus('먼저 문서를 여세요.', 'warn');
      return;
    }

    this.session.startRequest();
    this.streamArea.textContent = '';
    this.setStatus('요청 중…');
    const provider = this.providerSelect.value;
    const model = this.modelInput.value.trim() || defaultModel(provider);

    try {
      this.context = await this.deps.bridge.aiGetDocumentContext(docId, false);
      this.requestId = await this.deps.bridge.aiRequestEdit(docId, prompt, provider, model);
    } catch (error) {
      this.session.onFailed();
      this.setStatus(`요청 실패: ${String(error)}`, 'error');
    }
  }

  private async cancel(): Promise<void> {
    if (this.requestId) {
      try {
        await this.deps.bridge.aiCancelRequest(this.requestId);
      } catch {
        /* 취소 실패는 무시 */
      }
    }
    this.session.cancel();
    this.requestId = null;
    this.setStatus('취소했습니다.');
  }

  private onDelta(delta: AiStreamDelta): void {
    if (delta.requestId !== this.requestId) return;
    this.streamArea.textContent += delta.partialText;
  }

  private onReady(ready: AiEditReady): void {
    if (ready.requestId !== this.requestId) return;
    const script = parseActionScript(ready.actionScriptJson);
    if (!script) {
      this.session.onFailed();
      this.setStatus(interpretAiFailure('PARSE_ERROR'), 'error');
      return;
    }
    if (!this.session.onReady()) return;
    this.pendingScript = script;
    this.renderDiff(script);
    this.renderHighlights(script);
    this.setPreviewEnabled(true);
    this.setStatus(`제안 ${script.edits.length}건 — 승인 또는 거부하세요.`);
  }

  private onFailed(failed: AiEditFailed): void {
    if (failed.requestId !== this.requestId) return;
    this.session.onFailed();
    this.setStatus(`${interpretAiFailure(failed.code)} (${failed.reason})`, 'error');
  }

  private accept(): void {
    if (!this.pendingScript || !this.session.accept()) return;
    const result = applyActionScript(this.deps.bridge, this.pendingScript);
    this.deps.eventBus.emit('document-changed', 'ai-edit');
    this.deps.bridge.markDocumentDirty?.();
    this.clearPreview();
    const skippedNote = result.skipped.length ? `, 건너뜀 ${result.skipped.length}건` : '';
    this.setStatus(`적용 완료: ${result.applied}건${skippedNote}.`, 'ok');
  }

  private reject(): void {
    if (this.session.reject()) this.setStatus('제안을 거부했습니다.');
  }

  private renderDiff(script: ActionScript): void {
    this.diffArea.replaceChildren();
    const items = buildDiffModel(script, this.context ?? { document_metadata: { total_sections: 0 }, content: [] });
    for (const item of items) this.diffArea.appendChild(renderDiffItem(item));
  }

  private renderHighlights(script: ActionScript): void {
    const canvasView = this.deps.getCanvasView();
    if (!canvasView) return;
    const targets: HighlightTarget[] = [];
    for (const edit of script.edits) {
      const target = parseParagraphTarget(edit.target_id);
      if (!target) continue;
      const kind = edit.command.startsWith('INSERT') ? 'insert' : 'remove';
      targets.push({ kind, sec: target.sec, para: target.para });
    }
    if (!targets.length) return;
    showHighlights(
      {
        getCursorRect: (s, p, o) => this.deps.bridge.getCursorRect(s, p, o),
        getParagraphLength: (s, p) => this.deps.bridge.getParagraphLength(s, p),
        getPageInfo: (n) => this.deps.bridge.getPageInfo(n),
        getZoom: () => canvasView.getViewportManager().getZoom(),
        getPageOffset: (i) => canvasView.getVirtualScroll().getPageOffset(i),
        scrollContent: this.deps.scrollContent,
        scrollContainer: this.deps.scrollContainer,
      },
      targets,
    );
  }

  private clearPreview(): void {
    this.pendingScript = null;
    this.diffArea.replaceChildren();
    clearHighlights(this.deps.scrollContent);
    this.setPreviewEnabled(false);
  }

  private setPreviewEnabled(enabled: boolean): void {
    this.acceptBtn.disabled = !enabled;
    this.rejectBtn.disabled = !enabled;
  }

  private setStatus(message: string, tone: 'info' | 'ok' | 'warn' | 'error' = 'info'): void {
    this.statusArea.textContent = message;
    this.statusArea.dataset.tone = tone;
  }
}

function defaultModel(provider: string): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-3-5-haiku-latest';
    case 'gemini':
      return 'gemini-2.0-flash';
    case 'ollama':
      return 'llama3.1';
    default:
      return 'mock-1';
  }
}

function renderDiffItem(item: DiffItem): HTMLElement {
  const row = document.createElement('div');
  row.className = 'hop-ai-diff-item';

  const head = document.createElement('div');
  head.className = 'hop-ai-diff-head';
  head.textContent = `${item.command} · ${item.targetId}`;
  row.appendChild(head);

  if (item.beforeText !== undefined) {
    const before = document.createElement('div');
    before.className = 'hop-ai-diff-before';
    before.textContent = item.beforeText;
    row.appendChild(before);
  }
  if (item.afterText !== undefined) {
    const after = document.createElement('div');
    after.className = 'hop-ai-diff-after';
    after.textContent = item.afterText;
    row.appendChild(after);
  }
  return row;
}

interface PanelParts {
  panel: HTMLElement;
  toggleBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  promptInput: HTMLTextAreaElement;
  providerSelect: HTMLSelectElement;
  modelInput: HTMLInputElement;
  sendBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  streamArea: HTMLElement;
  diffArea: HTMLElement;
  statusArea: HTMLElement;
  acceptBtn: HTMLButtonElement;
  rejectBtn: HTMLButtonElement;
}

function buildPanel(): PanelParts {
  const toggleBtn = el('button', 'hop-ai-toggle');
  toggleBtn.textContent = 'AI';
  toggleBtn.title = 'AI 편집 도우미';

  const panel = el('aside', 'hop-ai-panel');

  const header = el('div', 'hop-ai-header');
  const title = el('span', 'hop-ai-title');
  title.textContent = 'AI 편집';
  const closeBtn = el('button', 'hop-ai-close') as HTMLButtonElement;
  closeBtn.textContent = '×';
  header.append(title, closeBtn);

  const providerSelect = document.createElement('select');
  providerSelect.className = 'hop-ai-provider';
  for (const id of PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    providerSelect.appendChild(opt);
  }
  const modelInput = document.createElement('input');
  modelInput.className = 'hop-ai-model';
  modelInput.type = 'text';
  modelInput.placeholder = '모델 (기본값 자동)';

  const row = el('div', 'hop-ai-row');
  row.append(providerSelect, modelInput);

  const promptInput = document.createElement('textarea');
  promptInput.className = 'hop-ai-prompt';
  promptInput.rows = 3;
  promptInput.placeholder = '예: 첫 문단 뒤에 요약 문단을 추가해줘';

  const sendBtn = el('button', 'hop-ai-send') as HTMLButtonElement;
  sendBtn.textContent = '요청';
  const cancelBtn = el('button', 'hop-ai-cancel') as HTMLButtonElement;
  cancelBtn.textContent = '취소';
  const actions = el('div', 'hop-ai-actions');
  actions.append(sendBtn, cancelBtn);

  const streamArea = el('pre', 'hop-ai-stream');
  const diffArea = el('div', 'hop-ai-diff');

  const acceptBtn = el('button', 'hop-ai-accept') as HTMLButtonElement;
  acceptBtn.textContent = '승인';
  const rejectBtn = el('button', 'hop-ai-reject') as HTMLButtonElement;
  rejectBtn.textContent = '거부';
  const decision = el('div', 'hop-ai-decision');
  decision.append(acceptBtn, rejectBtn);

  const statusArea = el('div', 'hop-ai-status');

  panel.append(header, row, promptInput, actions, statusArea, streamArea, diffArea, decision);

  return {
    panel,
    toggleBtn: toggleBtn as HTMLButtonElement,
    closeBtn,
    promptInput,
    providerSelect,
    modelInput,
    sendBtn,
    cancelBtn,
    streamArea,
    diffArea,
    statusArea,
    acceptBtn,
    rejectBtn,
  };
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
