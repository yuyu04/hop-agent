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
    /** 현재 캐럿 위치 — Sliding Window 기준(스펙 4장). 없으면 문서 앞쪽 기준. */
    getCaretPosition?(): { sectionIndex: number; paragraphIndex: number } | null;
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

/** 커스텀 OpenAI 호환 엔드포인트(Groq/OpenRouter/Together/LM Studio/게이트웨이). 스펙 5.3장. */
const CUSTOM_PROVIDER = 'openai-compat';

const PROVIDERS = ['mock', 'openai', 'anthropic', 'gemini', 'ollama', CUSTOM_PROVIDER] as const;

const PROVIDER_LABELS: Record<string, string> = {
  [CUSTOM_PROVIDER]: 'OpenAI 호환 (Groq 등)',
};

/** API 키가 필수인 provider(mock/ollama는 불필요, openai-compat은 선택). 스펙 6장. */
const KEY_PROVIDERS = new Set<string>(['openai', 'anthropic', 'gemini']);

/** 본문이 외부로 나가지 않는 로컬 provider. 민감 문서에서도 허용된다(스펙 6장). */
const LOCAL_PROVIDERS = new Set<string>(['mock', 'ollama']);

/** openai-compat 프리셋 — Base URL + 추천 모델 자동 채움. base는 `/v1/chat/completions`를 덧붙인다. */
const CUSTOM_PRESETS: Record<string, { baseUrl: string; model: string }> = {
  groq: { baseUrl: 'https://api.groq.com/openai', model: 'llama-3.1-8b-instant' },
  openrouter: { baseUrl: 'https://openrouter.ai/api', model: 'meta-llama/llama-3.1-8b-instruct:free' },
  together: { baseUrl: 'https://api.together.xyz', model: 'meta-llama/Llama-3.1-8B-Instruct-Turbo' },
};

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
  private readonly keyRow: HTMLElement;
  private readonly keyInput: HTMLInputElement;
  private readonly keyStatus: HTMLElement;
  private readonly keyClearBtn: HTMLButtonElement;
  private readonly sensitiveCheckbox: HTMLInputElement;
  private readonly customRow: HTMLElement;
  private readonly baseUrlInput: HTMLInputElement;
  private readonly presetSelect: HTMLSelectElement;

  private readonly session: AiSessionMachine;
  /** provider_id → 키 저장 여부(보안 저장소 조회 캐시). */
  private readonly keyState = new Map<string, boolean>();
  /** 민감 문서 표시 여부(스펙 6장). true면 외부 provider 전송을 막는다. */
  private sensitive = false;
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
    this.keyRow = built.keyRow;
    this.keyInput = built.keyInput;
    this.keyStatus = built.keyStatus;
    this.keyClearBtn = built.keyClearBtn;
    this.sensitiveCheckbox = built.sensitiveCheckbox;
    this.customRow = built.customRow;
    this.baseUrlInput = built.baseUrlInput;
    this.presetSelect = built.presetSelect;

    built.sendBtn.addEventListener('click', () => void this.send());
    built.cancelBtn.addEventListener('click', () => void this.cancel());
    this.acceptBtn.addEventListener('click', () => this.accept());
    this.rejectBtn.addEventListener('click', () => this.reject());
    built.closeBtn.addEventListener('click', () => this.toggle(false));
    built.toggleBtn.addEventListener('click', () => this.toggle());
    this.providerSelect.addEventListener('change', () => void this.refreshKeyState());
    built.keySaveBtn.addEventListener('click', () => void this.saveKey());
    this.keyClearBtn.addEventListener('click', () => void this.clearKey());
    this.sensitiveCheckbox.addEventListener('change', () => void this.onSensitivityToggle());
    this.presetSelect.addEventListener('change', () => this.applyPreset());

    document.body.appendChild(built.toggleBtn);
    document.body.appendChild(this.panel);
    this.setPreviewEnabled(false);
    this.keyRow.classList.add('hop-ai-hidden');
    this.customRow.classList.add('hop-ai-hidden');
    void this.subscribe();
    void this.refreshKeyState();
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

    const provider = this.providerSelect.value;
    if (this.sensitive && !LOCAL_PROVIDERS.has(provider)) {
      this.setStatus('민감 문서로 표시됨 — 로컬 모델(ollama)이나 mock만 사용할 수 있습니다.', 'warn');
      return;
    }
    if (KEY_PROVIDERS.has(provider) && this.keyState.get(provider) === false) {
      this.setStatus('API 키를 먼저 저장하세요.', 'warn');
      return;
    }
    const baseUrl = provider === CUSTOM_PROVIDER ? this.baseUrlInput.value.trim() : null;
    if (provider === CUSTOM_PROVIDER && !baseUrl) {
      this.setStatus('Base URL을 입력하세요 (예: https://api.groq.com/openai).', 'warn');
      return;
    }

    // 네이티브에 현재 문서의 민감 표시를 동기화한다(차단의 2중 방어, 스펙 6장).
    try {
      await this.deps.bridge.aiSetDocumentSensitivity(docId, this.sensitive);
    } catch {
      /* 동기화 실패는 무시 — 프론트 가드가 이미 외부 전송을 막았다. */
    }

    this.session.startRequest();
    this.streamArea.textContent = '';
    this.setStatus('요청 중…');
    const model = this.modelInput.value.trim() || defaultModel(provider);

    const cursorPath = this.currentCursorPath();
    try {
      this.context = await this.deps.bridge.aiGetDocumentContext(docId, false, cursorPath);
      this.requestId = await this.deps.bridge.aiRequestEdit(
        docId,
        prompt,
        provider,
        model,
        cursorPath,
        baseUrl,
      );
    } catch (error) {
      this.session.onFailed();
      this.setStatus(`요청 실패: ${String(error)}`, 'error');
    }
  }

  /** 캐럿 위치를 `sec[s].p[p]` 경로로 만든다(Sliding Window 기준, 스펙 4장). */
  private currentCursorPath(): string | null {
    const pos = this.deps.bridge.getCaretPosition?.();
    if (!pos) return null;
    return `sec[${pos.sectionIndex}].p[${pos.paragraphIndex}]`;
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

  /** 선택된 provider의 키 필요 여부/저장 상태로 키 입력 영역을 갱신한다(스펙 6장). */
  private async refreshKeyState(): Promise<void> {
    const provider = this.providerSelect.value;
    const requiresKey = KEY_PROVIDERS.has(provider);
    const isCustom = provider === CUSTOM_PROVIDER;
    // openai-compat은 키가 선택사항이라 입력칸은 보여주되 send를 막지는 않는다.
    const showsKey = requiresKey || isCustom;
    this.keyRow.classList.toggle('hop-ai-hidden', !showsKey);
    this.customRow.classList.toggle('hop-ai-hidden', !isCustom);
    if (!showsKey) return;

    let present = false;
    try {
      present = await this.deps.bridge.aiHasApiKey(provider);
    } catch {
      present = false;
    }
    // 조회 중 다른 provider로 바뀌었으면 늦게 도착한 응답은 버린다.
    if (this.providerSelect.value !== provider) return;
    this.keyState.set(provider, present);
    this.keyStatus.textContent = present ? '키 저장됨' : isCustom ? '키 없음(선택)' : '키 없음';
    this.keyStatus.dataset.tone = present ? 'ok' : isCustom ? 'info' : 'warn';
    this.keyClearBtn.disabled = !present;
  }

  /** openai-compat 프리셋(Groq/OpenRouter/Together)을 Base URL·모델 입력에 채운다. */
  private applyPreset(): void {
    const preset = CUSTOM_PRESETS[this.presetSelect.value];
    if (!preset) return;
    this.baseUrlInput.value = preset.baseUrl;
    this.modelInput.value = preset.model;
  }

  private async saveKey(): Promise<void> {
    const provider = this.providerSelect.value;
    if (!KEY_PROVIDERS.has(provider)) return;
    const key = this.keyInput.value.trim();
    if (!key) {
      this.setStatus('API 키를 입력하세요.', 'warn');
      return;
    }
    try {
      await this.deps.bridge.aiSetApiKey(provider, key);
      this.keyInput.value = '';
      await this.refreshKeyState();
      this.setStatus(`${provider} API 키를 저장했습니다.`, 'ok');
    } catch (error) {
      this.setStatus(`키 저장 실패: ${String(error)}`, 'error');
    }
  }

  private async clearKey(): Promise<void> {
    const provider = this.providerSelect.value;
    if (!KEY_PROVIDERS.has(provider)) return;
    try {
      await this.deps.bridge.aiDeleteApiKey(provider);
      await this.refreshKeyState();
      this.setStatus(`${provider} API 키를 삭제했습니다.`);
    } catch (error) {
      this.setStatus(`키 삭제 실패: ${String(error)}`, 'error');
    }
  }

  /** 민감 문서 토글. 열린 문서가 있으면 네이티브에도 표시를 반영한다(스펙 6장). */
  private async onSensitivityToggle(): Promise<void> {
    this.sensitive = this.sensitiveCheckbox.checked;
    const docId = this.deps.bridge.currentDocId();
    if (docId) {
      try {
        await this.deps.bridge.aiSetDocumentSensitivity(docId, this.sensitive);
      } catch {
        /* 표시 실패는 무시 — 전송 시 send()에서 다시 동기화한다. */
      }
    }
    this.setStatus(
      this.sensitive
        ? '민감 문서로 표시됨 — 외부 AI 제공자 전송이 차단됩니다.'
        : '민감 문서 표시를 해제했습니다.',
    );
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
    case CUSTOM_PROVIDER:
      return 'llama-3.1-8b-instant';
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
  keyRow: HTMLElement;
  keyInput: HTMLInputElement;
  keySaveBtn: HTMLButtonElement;
  keyClearBtn: HTMLButtonElement;
  keyStatus: HTMLElement;
  sensitiveCheckbox: HTMLInputElement;
  customRow: HTMLElement;
  baseUrlInput: HTMLInputElement;
  presetSelect: HTMLSelectElement;
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
    opt.textContent = PROVIDER_LABELS[id] ?? id;
    providerSelect.appendChild(opt);
  }
  const modelInput = document.createElement('input');
  modelInput.className = 'hop-ai-model';
  modelInput.type = 'text';
  modelInput.placeholder = '모델 (기본값 자동)';

  const row = el('div', 'hop-ai-row');
  row.append(providerSelect, modelInput);

  // API 키 입력 영역(키가 필요한 provider에서만 노출). 평문 노출을 줄이려 password 입력.
  const keyInput = document.createElement('input');
  keyInput.className = 'hop-ai-key';
  keyInput.type = 'password';
  keyInput.placeholder = 'API 키';
  keyInput.autocomplete = 'off';
  const keySaveBtn = el('button', 'hop-ai-key-save') as HTMLButtonElement;
  keySaveBtn.textContent = '키 저장';
  const keyClearBtn = el('button', 'hop-ai-key-clear') as HTMLButtonElement;
  keyClearBtn.textContent = '삭제';
  const keyStatus = el('span', 'hop-ai-key-status');
  const keyRow = el('div', 'hop-ai-key-row');
  keyRow.append(keyInput, keySaveBtn, keyClearBtn, keyStatus);

  // 커스텀 OpenAI 호환 엔드포인트(Groq 등) — 프리셋 + Base URL 입력(스펙 5.3장).
  const presetSelect = document.createElement('select');
  presetSelect.className = 'hop-ai-preset';
  for (const [value, label] of [
    ['', '프리셋'],
    ['groq', 'Groq'],
    ['openrouter', 'OpenRouter'],
    ['together', 'Together'],
  ] as const) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    presetSelect.appendChild(opt);
  }
  const baseUrlInput = document.createElement('input');
  baseUrlInput.className = 'hop-ai-base-url';
  baseUrlInput.type = 'text';
  baseUrlInput.placeholder = 'Base URL (예: https://api.groq.com/openai)';
  const customRow = el('div', 'hop-ai-custom-row');
  customRow.append(presetSelect, baseUrlInput);

  // 민감 문서 토글 — 체크 시 외부 provider 전송을 차단한다(스펙 6장, 공문서 보호).
  const sensitiveCheckbox = document.createElement('input');
  sensitiveCheckbox.className = 'hop-ai-sensitive';
  sensitiveCheckbox.type = 'checkbox';
  const sensitiveText = el('span', 'hop-ai-sensitive-text');
  sensitiveText.textContent = '민감 문서 — 외부 전송 차단';
  const sensitiveRow = el('label', 'hop-ai-sensitive-row');
  sensitiveRow.append(sensitiveCheckbox, sensitiveText);

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

  panel.append(
    header,
    row,
    customRow,
    keyRow,
    sensitiveRow,
    promptInput,
    actions,
    statusArea,
    streamArea,
    diffArea,
    decision,
  );

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
    keyRow,
    keyInput,
    keySaveBtn,
    keyClearBtn,
    keyStatus,
    sensitiveCheckbox,
    customRow,
    baseUrlInput,
    presetSelect,
  };
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
