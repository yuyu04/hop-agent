/**
 * AI Agent Sidebar — Cursor IDE식 대화형 편집 패널(스펙 1·4·7장).
 *
 * 대화 스레드(유저/AI 버블) + 하단 입력 컴포저(모델 선택 · 이미지/문서 첨부)로
 * 구성된다. 지시 → `aiRequestEdit` → `hop-ai-*` 이벤트 → 어시스턴트 버블에서
 * 스트리밍/가상 Diff 미리보기 → 승인 시에만 라이브 WASM 문서에 적용한다.
 * 데스크톱(Tauri) 런타임 전용.
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
import type { AiBridgeApi, AiImageInput } from '@/core/tauri-bridge';
import {
  applyActionScript,
  parseCellTarget,
  parseParagraphTarget,
  type ApplyResult,
  type ChangedPara,
  type WasmEditing,
} from '@/core/ai-apply';
import { buildDiffModel, type DiffItem } from '@/core/ai-diff';
import { AiSessionMachine } from '@/core/ai-session';
import { clearInlineDiff, showInlineDiff, type InlineDiffEntry } from '@/ui/ai-inline-diff';
import type { CursorRect, PageInfo } from '@/core/types';

type AgentBridge = AiBridgeApi &
  WasmEditing & {
    currentDocId(): string | null;
    getCursorRect(sec: number, para: number, charOffset: number): CursorRect;
    getCursorRectByPath(sec: number, parentPara: number, pathJson: string, charOffset: number): CursorRect;
    getPageInfo(pageIndex: number): PageInfo;
    /** 현재 캐럿 위치 — Sliding Window 기준(스펙 4장). 없으면 문서 앞쪽 기준. */
    getCaretPosition?(): { sectionIndex: number; paragraphIndex: number } | null;
    /** 대량/구조 편집 후 줄·페이지 재배치를 강제한다(없으면 무시). */
    reflowLinesegs?(): number;
    markDocumentDirty?(): void;
    // 낙관적 적용(승인 전 미리 반영) + 거절 시 복원용 스냅샷.
    getSourceFormat?(): string;
    exportHwp?(): Uint8Array;
    exportHwpx?(): Uint8Array;
    loadDocument?(data: Uint8Array, fileName?: string): unknown;
    readonly fileName?: string;
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

/** 로컬 CLI 위임 — 터미널에 로그인된 CLI를 호출(키·과금 없음). 스펙 5.3장. */
const CLAUDE_CLI_PROVIDER = 'claude-cli';
const GEMINI_CLI_PROVIDER = 'gemini-cli';

/** CLI 위임 provider — 첨부를 base64 대신 파일 경로로 넘기고 키가 필요 없다. */
const CLI_PROVIDERS = new Set<string>([CLAUDE_CLI_PROVIDER, GEMINI_CLI_PROVIDER]);

const PROVIDERS = [
  'gemini',
  'openai',
  'anthropic',
  'ollama',
  CLAUDE_CLI_PROVIDER,
  GEMINI_CLI_PROVIDER,
  CUSTOM_PROVIDER,
] as const;

const PROVIDER_LABELS: Record<string, string> = {
  [CLAUDE_CLI_PROVIDER]: 'Claude Code (로컬 CLI)',
  [GEMINI_CLI_PROVIDER]: 'Gemini CLI (로컬)',
  [CUSTOM_PROVIDER]: 'OpenAI 호환 (Groq 등)',
};

/** API 키가 필수인 provider(ollama는 불필요, openai-compat은 선택). 스펙 6장. */
const KEY_PROVIDERS = new Set<string>(['openai', 'anthropic', 'gemini']);

/** 본문이 외부로 나가지 않는 로컬 provider. 민감 문서에서도 허용된다(스펙 6장). */
const LOCAL_PROVIDERS = new Set<string>(['ollama']);

/** openai-compat 프리셋 — Base URL + 추천 모델 자동 채움. */
const CUSTOM_PRESETS: Record<string, { baseUrl: string; model: string }> = {
  groq: { baseUrl: 'https://api.groq.com/openai', model: 'llama-3.1-8b-instant' },
  openrouter: { baseUrl: 'https://openrouter.ai/api', model: 'meta-llama/llama-3.1-8b-instruct:free' },
  together: { baseUrl: 'https://api.together.xyz', model: 'meta-llama/Llama-3.1-8B-Instruct-Turbo' },
};

/** 모델 드롭다운에서 "직접 입력"을 고를 때의 sentinel 값. */
const CUSTOM_MODEL = '__custom__';

/** provider별 선택 가능한 모델 목록(첫 항목이 기본 선택). 직접 입력 옵션이 항상 뒤따른다. */
const MODELS: Record<string, string[]> = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  anthropic: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-lite', 'gemini-flash-latest'],
  ollama: ['llama3.1', 'llama3.2', 'qwen2.5', 'mistral'],
  [CLAUDE_CLI_PROVIDER]: ['default', 'sonnet', 'opus', 'haiku'],
  [GEMINI_CLI_PROVIDER]: ['default', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  [CUSTOM_PROVIDER]: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'],
};

/**
 * 첨부 파일.
 *  - image: vision provider에 이미지로 전달
 *  - doc:   텍스트로 추출/읽어 프롬프트에 인라인(모든 provider; HWP/HWPX·텍스트)
 *  - file:  base64 바이너리 문서로 전달(PDF 등; 문서 지원 provider만)
 */
interface Attachment {
  id: string;
  kind: 'image' | 'doc' | 'file';
  name: string;
  mime?: string;
  dataBase64?: string;
  text?: string;
  /** 원본 로컬 경로(드래그&드롭 시). claude-cli는 base64 대신 이 경로를 넘긴다. */
  path?: string;
}

/** PDF 등 바이너리 문서 입력을 받는 provider(스펙 5장). */
const DOC_PROVIDERS = new Set<string>(['gemini', 'anthropic']);

/** 진행 중인 어시스턴트 턴의 DOM 참조. */
interface ActiveTurn {
  streamEl: HTMLElement;
  bodyEl: HTMLElement;
  decisionEl: HTMLElement;
  acceptBtn: HTMLButtonElement;
  rejectBtn: HTMLButtonElement;
  statusEl: HTMLElement;
}

export class AgentSidebar {
  private readonly panel: HTMLElement;
  private readonly thread: HTMLElement;
  private readonly promptInput: HTMLTextAreaElement;
  private readonly providerSelect: HTMLSelectElement;
  private readonly modelSelect: HTMLSelectElement;
  private readonly modelInput: HTMLInputElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly statusArea: HTMLElement;
  private readonly chipsArea: HTMLElement;
  private readonly imageInput: HTMLInputElement;
  private readonly docInput: HTMLInputElement;
  private readonly settingsPanel: HTMLElement;
  private readonly keyRow: HTMLElement;
  private readonly keyInput: HTMLInputElement;
  private readonly keyStatus: HTMLElement;
  private readonly keyClearBtn: HTMLButtonElement;
  private readonly sensitiveCheckbox: HTMLInputElement;
  private readonly customRow: HTMLElement;
  private readonly baseUrlInput: HTMLInputElement;
  private readonly presetSelect: HTMLSelectElement;

  private readonly session: AiSessionMachine;
  private readonly keyState = new Map<string, boolean>();
  private sensitive = false;
  private attachments: Attachment[] = [];
  private active: ActiveTurn | null = null;
  private unsubscribe: AiEventUnsubscribe | null = null;
  private copyHandler: ((event: KeyboardEvent) => void) | null = null;
  private requestId: string | null = null;
  private context: DocumentContext | null = null;
  private pendingScript: ActionScript | null = null;
  /** 낙관적 적용 전 문서 스냅샷(거절/롤백 시 복원). */
  private snapshot: { bytes: Uint8Array; fileName: string } | null = null;
  /** 낙관적 적용 결과(승인 메시지용). */
  private applied: ApplyResult | null = null;

  constructor(private readonly deps: AgentSidebarDeps) {
    this.session = new AiSessionMachine({ onRollback: () => this.revertToSnapshot() });
    const built = buildPanel();
    this.panel = built.panel;
    this.thread = built.thread;
    this.promptInput = built.promptInput;
    this.providerSelect = built.providerSelect;
    this.modelSelect = built.modelSelect;
    this.modelInput = built.modelInput;
    this.sendBtn = built.sendBtn;
    this.cancelBtn = built.cancelBtn;
    this.statusArea = built.statusArea;
    this.chipsArea = built.chipsArea;
    this.imageInput = built.imageInput;
    this.docInput = built.docInput;
    this.settingsPanel = built.settingsPanel;
    this.keyRow = built.keyRow;
    this.keyInput = built.keyInput;
    this.keyStatus = built.keyStatus;
    this.keyClearBtn = built.keyClearBtn;
    this.sensitiveCheckbox = built.sensitiveCheckbox;
    this.customRow = built.customRow;
    this.baseUrlInput = built.baseUrlInput;
    this.presetSelect = built.presetSelect;

    this.sendBtn.addEventListener('click', () => void this.send());
    this.cancelBtn.addEventListener('click', () => void this.cancel());
    built.closeBtn.addEventListener('click', () => this.toggle(false));
    built.toggleBtn.addEventListener('click', () => this.toggle());
    built.newChatBtn.addEventListener('click', () => this.newConversation());
    built.settingsBtn.addEventListener('click', () => this.toggleSettings());
    built.attachImageBtn.addEventListener('click', () => this.imageInput.click());
    built.attachDocBtn.addEventListener('click', () => this.docInput.click());
    this.imageInput.addEventListener('change', () => void this.onImagePicked());
    this.docInput.addEventListener('change', () => void this.onDocPicked());
    this.providerSelect.addEventListener('change', () => void this.onProviderChange());
    this.modelSelect.addEventListener('change', () => this.updateModelVisibility());
    built.keySaveBtn.addEventListener('click', () => void this.saveKey());
    this.keyClearBtn.addEventListener('click', () => void this.clearKey());
    this.sensitiveCheckbox.addEventListener('change', () => void this.onSensitivityToggle());
    this.presetSelect.addEventListener('change', () => this.applyPreset());
    this.promptInput.addEventListener('keydown', (event) => this.onPromptKeydown(event as KeyboardEvent));
    this.panel.addEventListener('paste', (event) => void this.onPaste(event as ClipboardEvent));
    // 드래그&드롭으로 이미지·텍스트 문서 첨부.
    this.panel.addEventListener('dragover', (event) => this.onDragOver(event as DragEvent));
    this.panel.addEventListener('dragleave', (event) => this.onDragLeave(event as DragEvent));
    this.panel.addEventListener('drop', (event) => void this.onDrop(event as DragEvent));
    // 패널 내부 키 입력(붙여넣기/전체선택 등)이 문서 전역 단축키 핸들러로
    // 전파돼 가로채이지 않도록 막는다. 버블 단계라 textarea의 Enter 처리는 유지된다.
    this.panel.addEventListener('keydown', (event) => (event as KeyboardEvent).stopPropagation());
    // 패널 안 선택 텍스트(스트림/diff 등) 복사 — 에디터가 숨은 textarea에 포커스를
    // 잡고 있어 일반 Cmd/Ctrl+C가 패널 선택을 복사하지 못한다. 캡처 단계에서
    // 선택을 직접 클립보드에 써서, 패널 선택일 때만 가로채 처리한다.
    this.copyHandler = (event) => this.onGlobalCopyKey(event);
    document.addEventListener('keydown', this.copyHandler, true);

    document.body.appendChild(built.toggleBtn);
    document.body.appendChild(this.panel);
    this.settingsPanel.classList.add('hop-ai-hidden');
    this.keyRow.classList.add('hop-ai-hidden');
    this.customRow.classList.add('hop-ai-hidden');
    this.setRequesting(false);
    this.populateModels(this.providerSelect.value);
    this.renderChips();
    void this.subscribe();
    void this.subscribeNativeDragDrop();
    void this.refreshKeyState();
  }

  private async subscribe(): Promise<void> {
    this.unsubscribe = await listenAiEvents({
      onDelta: (d) => this.onDelta(d),
      onEditReady: (r) => this.onReady(r),
      onEditFailed: (f) => this.onFailed(f),
    });
  }

  /**
   * Tauri 데스크톱에서는 OS 파일 드롭을 네이티브가 가로채 웹 DOM `drop`이
   * 오지 않으므로, `tauri://drag-drop` 이벤트(파일 경로 + 위치)를 구독한다.
   * 드롭 위치가 패널 위일 때만 첨부로 처리한다(문서 열기와 충돌 방지).
   */
  private async subscribeNativeDragDrop(): Promise<void> {
    let webview: { listen: (e: string, cb: (ev: { payload: unknown }) => void) => Promise<unknown> };
    try {
      const mod = await import('@tauri-apps/api/webviewWindow');
      webview = mod.getCurrentWebviewWindow();
    } catch {
      return; // 웹/테스트 런타임 — DOM drop 폴백 사용.
    }

    const overPanel = (pos: { x: number; y: number } | undefined): boolean => {
      if (!pos) return false;
      const dpr = window.devicePixelRatio || 1;
      const rect = this.panel.getBoundingClientRect();
      const x = pos.x / dpr;
      const y = pos.y / dpr;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };

    await webview.listen('tauri://drag-enter', (ev) => {
      const payload = ev.payload as { position?: { x: number; y: number } };
      this.panel.classList.toggle('hop-ai-dragover', overPanel(payload.position));
    });
    await webview.listen('tauri://drag-over', (ev) => {
      const payload = ev.payload as { position?: { x: number; y: number } };
      this.panel.classList.toggle('hop-ai-dragover', overPanel(payload.position));
    });
    await webview.listen('tauri://drag-leave', () => {
      this.panel.classList.remove('hop-ai-dragover');
    });
    await webview.listen('tauri://drag-drop', (ev) => {
      const payload = ev.payload as { paths?: string[]; position?: { x: number; y: number } };
      this.panel.classList.remove('hop-ai-dragover');
      if (!this.panel.classList.contains('open') || !overPanel(payload.position)) return;
      void this.attachPaths(payload.paths ?? []);
    });
  }

  /** 드롭된 파일 경로들을 읽어 첨부한다(이미지=base64, 텍스트=인라인). */
  private async attachPaths(paths: string[]): Promise<void> {
    if (!paths.length) return;
    let ignored = 0;
    for (const path of paths) {
      const name = path.split(/[\\/]/).pop() || path;
      try {
        if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) {
          const { readFile } = await import('@tauri-apps/plugin-fs');
          const bytes = await readFile(path);
          this.attachments.push({
            id: uid(),
            kind: 'image',
            name,
            mime: mimeForImage(name),
            dataBase64: base64FromBytes(bytes),
            path,
          });
        } else if (/\.pdf$/i.test(name)) {
          const { readFile } = await import('@tauri-apps/plugin-fs');
          const bytes = await readFile(path);
          this.attachments.push({
            id: uid(),
            kind: 'file',
            name,
            mime: 'application/pdf',
            dataBase64: base64FromBytes(bytes),
            path,
          });
        } else if (/\.(hwp|hwpx|docx)$/i.test(name)) {
          // 한글(HWP/HWPX)·워드(DOCX)는 네이티브로 평문 추출 → 모든 provider 인라인.
          const text = await this.deps.bridge.aiExtractText(path);
          this.attachments.push({ id: uid(), kind: 'doc', name, text });
        } else if (/\.(txt|md|markdown|csv|json|html?|xml)$/i.test(name)) {
          const { readTextFile } = await import('@tauri-apps/plugin-fs');
          const text = await readTextFile(path);
          this.attachments.push({ id: uid(), kind: 'doc', name, text });
        } else {
          ignored += 1;
          continue;
        }
        this.renderChips();
      } catch (error) {
        this.setStatus(`첨부 실패(${name}): ${String(error)}`, 'error');
      }
    }
    if (ignored) {
      this.setStatus(
        `지원하지 않는 형식이 있습니다(${ignored}개 무시). 이미지·PDF·HWP/HWPX·DOCX·텍스트만 가능합니다.`,
        'warn',
      );
    } else {
      this.setStatus('첨부했습니다. 이어서 지시를 입력하세요.', 'ok');
    }
  }

  toggle(open?: boolean): void {
    const show = open ?? !this.panel.classList.contains('open');
    this.panel.classList.toggle('open', show);
  }

  dispose(): void {
    this.unsubscribe?.();
    if (this.copyHandler) document.removeEventListener('keydown', this.copyHandler, true);
    this.clearPreview();
    this.panel.remove();
  }

  /** Cmd/Ctrl+C에서 선택이 패널 안이면 선택 텍스트를 직접 클립보드에 쓴다. */
  private onGlobalCopyKey(event: KeyboardEvent): void {
    const isCopy = (event.metaKey || event.ctrlKey) && (event.key === 'c' || event.key === 'C');
    if (!isCopy) return;
    const selection = window.getSelection?.();
    const text = selection?.toString() ?? '';
    if (!text || !selection || !this.selectionInPanel(selection)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void navigator.clipboard?.writeText(text);
  }

  private selectionInPanel(selection: Selection): boolean {
    const node = selection.anchorNode;
    return node != null && this.panel.contains(node);
  }

  /** 새 대화 — 스레드 비우고 진행 중 미리보기를 정리한다. */
  private newConversation(): void {
    this.session.cancel();
    this.clearPreview();
    this.requestId = null;
    this.active = null;
    this.thread.replaceChildren();
    this.attachments = [];
    this.renderChips();
    this.setStatus('');
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
      this.setStatus('민감 문서로 표시됨 — 로컬 모델(ollama)만 사용할 수 있습니다.', 'warn');
      return;
    }
    if (KEY_PROVIDERS.has(provider) && this.keyState.get(provider) === false) {
      this.toggleSettings(true);
      this.setStatus('API 키를 먼저 저장하세요. (⚙ 옵션에서 입력)', 'warn');
      return;
    }
    const baseUrl = provider === CUSTOM_PROVIDER ? this.baseUrlInput.value.trim() : null;
    if (provider === CUSTOM_PROVIDER && !baseUrl) {
      this.toggleSettings(true);
      this.setStatus('Base URL을 입력하세요 (⚙ 옵션, 예: https://api.groq.com/openai).', 'warn');
      return;
    }

    // 미확정 Diff가 있으면 자동 롤백 후 진행(스펙 4장 동시성).
    const attachments = this.attachments;
    const isCli = CLI_PROVIDERS.has(provider);
    const docText = attachments
      .filter((a) => a.kind === 'doc')
      .map((a) => `[첨부 문서: ${a.name}]\n${a.text ?? ''}`)
      .join('\n\n');

    // claude-cli는 로컬 파일을 직접 읽으므로 이미지·PDF는 base64 대신 경로로 넘긴다.
    let images: AiImageInput[] = [];
    let documents: AiImageInput[] = [];
    let filePaths: string[] | null = null;
    if (isCli) {
      const paths = attachments
        .filter((a) => (a.kind === 'image' || a.kind === 'file') && a.path)
        .map((a) => a.path!);
      filePaths = paths.length ? paths : null;
    } else {
      images = attachments
        .filter((a) => a.kind === 'image' && a.dataBase64)
        .map((a) => ({ mimeType: a.mime ?? 'image/png', dataBase64: a.dataBase64! }));
      documents = attachments
        .filter((a) => a.kind === 'file' && a.dataBase64)
        .map((a) => ({ mimeType: a.mime ?? 'application/pdf', dataBase64: a.dataBase64! }));
      // PDF 등 바이너리 문서는 Gemini/Anthropic만 inline으로 받는다(claude-cli는 위 경로 처리).
      if (documents.length && !DOC_PROVIDERS.has(provider)) {
        this.setStatus(
          'PDF 등 문서 첨부는 Gemini·Anthropic 또는 Claude Code(로컬 CLI)에서만 지원됩니다.',
          'warn',
        );
        return;
      }
    }
    const effectivePrompt = docText ? `${docText}\n\n${prompt}` : prompt;

    this.appendUserTurn(prompt, attachments);
    this.active = this.appendAssistantTurn();
    this.promptInput.value = '';
    this.attachments = [];
    this.renderChips();

    try {
      await this.deps.bridge.aiSetDocumentSensitivity(docId, this.sensitive);
    } catch {
      /* 동기화 실패는 무시 — 프론트 가드가 이미 외부 전송을 막았다. */
    }

    this.session.startRequest();
    this.setRequesting(true);
    this.setStatus('요청 중…');
    const model = this.currentModel();
    const cursorPath = this.currentCursorPath();
    try {
      this.context = await this.deps.bridge.aiGetDocumentContext(docId, false, cursorPath);
      this.requestId = await this.deps.bridge.aiRequestEdit(
        docId,
        effectivePrompt,
        provider,
        model,
        cursorPath,
        baseUrl,
        images.length ? images : null,
        documents.length ? documents : null,
        filePaths,
      );
    } catch (error) {
      this.session.onFailed();
      this.setRequesting(false);
      this.setActiveStatus(`요청 실패: ${String(error)}`, 'error');
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
    this.setRequesting(false);
    this.setActiveStatus('취소했습니다.');
  }

  private onDelta(delta: AiStreamDelta): void {
    if (delta.requestId !== this.requestId || !this.active) return;
    // 부분 응답은 Raw Action Script JSON이라 그대로 보여주면 혼란스럽다.
    // 사람이 읽을 결과는 diff/인라인 카드로 보여주므로, 여기선 진행 표시만 한다.
    this.active.streamEl.textContent = 'AI가 편집을 작성 중…';
  }

  private onReady(ready: AiEditReady): void {
    if (ready.requestId !== this.requestId || !this.active) return;
    this.setRequesting(false);
    this.active.streamEl.textContent = '';
    const script = parseActionScript(ready.actionScriptJson);
    if (!script) {
      this.session.onFailed();
      this.setActiveStatus(interpretAiFailure('PARSE_ERROR'), 'error');
      return;
    }
    if (!this.session.onReady()) return;
    this.pendingScript = script;
    this.renderDiff(script);

    // 스냅샷 가능(데스크톱)하면 승인 전 "미리 적용"해 문서에 바로 반영하고, 거절 시
    // 스냅샷으로 되돌린다(Cursor/변경내용추적 방식). 불가하면 가상 미리보기로 폴백.
    if (this.snapshotDocument()) {
      const result = applyActionScript(this.deps.bridge, script);
      this.reflowAndRender();
      this.applied = result;
      const placed = this.renderDecisionBar(script, result.changed);
      this.setPreviewEnabled(placed === 0);
      const skippedNote = result.skipped.length ? `, 건너뜀 ${result.skipped.length}건` : '';
      this.setActiveStatus(`미리 적용 ${result.applied}건${skippedNote} — 승인 또는 거절하세요.`);
    } else {
      const placed = this.renderInlineDiff(script);
      this.setPreviewEnabled(placed === 0);
      this.setActiveStatus(`제안 ${script.edits.length}건 — 승인 또는 거부하세요.`);
    }
  }

  private onFailed(failed: AiEditFailed): void {
    if (failed.requestId !== this.requestId || !this.active) return;
    this.session.onFailed();
    this.setRequesting(false);
    this.active.streamEl.textContent = '';
    this.setActiveStatus(`${interpretAiFailure(failed.code)} (${failed.reason})`, 'error');
  }

  private accept(): void {
    const active = this.active;
    if (this.snapshot) {
      // 낙관적 적용 경로 — 이미 문서에 반영됨. 승인 = 그대로 두고 dirty 표시.
      if (!this.session.accept()) return;
      const result = this.applied;
      this.snapshot = null;
      this.applied = null;
      this.clearPreview();
      this.deps.bridge.markDocumentDirty?.();
      const note = result && result.skipped.length ? `, 건너뜀 ${result.skipped.length}건` : '';
      const count = result?.applied ?? 0;
      this.setActiveStatus(`적용 완료: ${count}건${note}.`, 'ok', active);
      return;
    }

    // 폴백(가상 미리보기) 경로 — 승인 시점에 적용.
    if (!this.pendingScript || !this.session.accept()) return;
    const result = applyActionScript(this.deps.bridge, this.pendingScript);
    this.clearPreview();
    if (result.applied === 0) {
      const reason = result.skipped[0]?.reason ?? '적용할 수 있는 편집이 없습니다.';
      this.setActiveStatus(`적용된 편집이 없습니다 — ${reason}`, 'warn', active);
      return;
    }
    this.reflowAndRender();
    this.deps.bridge.markDocumentDirty?.();
    const skippedNote = result.skipped.length ? `, 건너뜀 ${result.skipped.length}건` : '';
    this.setActiveStatus(`적용 완료: ${result.applied}건${skippedNote}.`, 'ok', active);
  }

  private reject(): void {
    const active = this.active;
    if (!this.session.reject()) return; // rollback 콜백이 스냅샷 복원/미리보기 정리를 한다.
    this.setActiveStatus('제안을 거절하여 되돌렸습니다.', 'info', active);
  }

  // ── 대화 버블 ────────────────────────────────────────────────

  private appendUserTurn(text: string, attachments: Attachment[]): void {
    const bubble = el('div', 'hop-ai-msg hop-ai-msg-user');
    const body = el('div', 'hop-ai-msg-text');
    body.textContent = text;
    bubble.appendChild(body);
    if (attachments.length) {
      const chips = el('div', 'hop-ai-msg-chips');
      for (const a of attachments) {
        const chip = el('span', 'hop-ai-chip');
        chip.textContent = `${attachmentIcon(a.kind)} ${a.name}`;
        chips.appendChild(chip);
      }
      bubble.appendChild(chips);
    }
    this.thread.appendChild(bubble);
    this.scrollThreadToEnd();
  }

  private appendAssistantTurn(): ActiveTurn {
    const bubble = el('div', 'hop-ai-msg hop-ai-msg-assistant');
    const streamEl = el('pre', 'hop-ai-stream');
    const bodyEl = el('div', 'hop-ai-diff');
    const statusEl = el('div', 'hop-ai-status hop-ai-bubble-status');
    const acceptBtn = el('button', 'hop-ai-accept') as HTMLButtonElement;
    acceptBtn.textContent = '승인';
    const rejectBtn = el('button', 'hop-ai-reject') as HTMLButtonElement;
    rejectBtn.textContent = '거부';
    const decision = el('div', 'hop-ai-decision');
    decision.append(acceptBtn, rejectBtn);
    acceptBtn.addEventListener('click', () => this.accept());
    rejectBtn.addEventListener('click', () => this.reject());
    bubble.append(streamEl, bodyEl, decision, statusEl);
    this.thread.appendChild(bubble);
    this.scrollThreadToEnd();
    const turn: ActiveTurn = { streamEl, bodyEl, decisionEl: decision, acceptBtn, rejectBtn, statusEl };
    this.setPreviewEnabledFor(turn, false);
    return turn;
  }

  private scrollThreadToEnd(): void {
    this.thread.scrollTop = this.thread.scrollHeight;
  }

  // ── 첨부 ─────────────────────────────────────────────────────

  private async onImagePicked(): Promise<void> {
    const files = Array.from(this.imageInput.files ?? []);
    for (const file of files) await this.addImageFile(file);
    this.imageInput.value = '';
  }

  private async addPickedDoc(file: File): Promise<void> {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      await this.addBinaryFile(file, 'application/pdf');
    } else if (/\.(hwp|hwpx|docx)$/i.test(file.name)) {
      // 네이티브 텍스트 추출은 파일 경로가 필요하다 — 파일 선택엔 경로가 없다.
      this.setStatus('HWP/HWPX/DOCX는 드래그&드롭으로 첨부하세요.', 'warn');
    } else {
      await this.addDocFile(file);
    }
  }

  private async onDocPicked(): Promise<void> {
    const files = Array.from(this.docInput.files ?? []);
    for (const file of files) await this.addPickedDoc(file);
    this.docInput.value = '';
  }

  private async onPaste(event: ClipboardEvent): Promise<void> {
    const items = Array.from(event.clipboardData?.items ?? []);
    const images = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (!images.length) return;
    event.preventDefault();
    for (const item of images) {
      const file = item.getAsFile();
      if (file) await this.addImageFile(file);
    }
  }

  private onDragOver(event: DragEvent): void {
    // 파일 드래그만 받아들이고 브라우저 기본 동작(파일 열기)을 막는다.
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    this.panel.classList.add('hop-ai-dragover');
  }

  private onDragLeave(event: DragEvent): void {
    // 패널 밖으로 나갈 때만 강조 해제(자식 간 이동은 무시).
    if (event.relatedTarget && this.panel.contains(event.relatedTarget as Node)) return;
    this.panel.classList.remove('hop-ai-dragover');
  }

  private async onDrop(event: DragEvent): Promise<void> {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    this.panel.classList.remove('hop-ai-dragover');
    let ignored = 0;
    for (const file of files) {
      if (file.type.startsWith('image/')) {
        await this.addImageFile(file);
      } else if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        await this.addBinaryFile(file, 'application/pdf');
      } else if (isTextLike(file)) {
        await this.addDocFile(file);
      } else {
        ignored += 1;
      }
    }
    if (ignored) {
      this.setStatus(
        `지원하지 않는 형식이 있습니다(${ignored}개 무시). HWP/HWPX는 드래그&드롭으로 첨부하세요.`,
        'warn',
      );
    }
  }

  private async addImageFile(file: File): Promise<void> {
    try {
      const dataUrl = await readAsDataUrl(file);
      const dataBase64 = dataUrl.split(',')[1] ?? '';
      this.attachments.push({
        id: uid(),
        kind: 'image',
        name: file.name || 'image',
        mime: file.type || 'image/png',
        dataBase64,
      });
      this.renderChips();
    } catch {
      this.setStatus('이미지를 읽지 못했습니다.', 'error');
    }
  }

  /** PDF 등 바이너리 문서를 base64로 첨부(file 종류). */
  private async addBinaryFile(file: File, mime: string): Promise<void> {
    try {
      const dataUrl = await readAsDataUrl(file);
      const dataBase64 = dataUrl.split(',')[1] ?? '';
      this.attachments.push({
        id: uid(),
        kind: 'file',
        name: file.name || 'document',
        mime: file.type || mime,
        dataBase64,
      });
      this.renderChips();
    } catch {
      this.setStatus('파일을 읽지 못했습니다.', 'error');
    }
  }

  private async addDocFile(file: File): Promise<void> {
    try {
      const text = await readAsText(file);
      this.attachments.push({ id: uid(), kind: 'doc', name: file.name || 'doc', text });
      this.renderChips();
    } catch {
      this.setStatus('문서를 읽지 못했습니다.', 'error');
    }
  }

  private renderChips(): void {
    this.chipsArea.replaceChildren();
    this.chipsArea.classList.toggle('hop-ai-hidden', this.attachments.length === 0);
    for (const a of this.attachments) {
      const chip = el('span', 'hop-ai-chip');
      const label = el('span', 'hop-ai-chip-label');
      label.textContent = `${attachmentIcon(a.kind)} ${a.name}`;
      const remove = el('button', 'hop-ai-chip-remove') as HTMLButtonElement;
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        this.attachments = this.attachments.filter((x) => x.id !== a.id);
        this.renderChips();
      });
      chip.append(label, remove);
      this.chipsArea.appendChild(chip);
    }
  }

  // ── 모델 / provider / 옵션 ───────────────────────────────────

  private onPromptKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.send();
    }
  }

  private toggleSettings(open?: boolean): void {
    const show = open ?? this.settingsPanel.classList.contains('hop-ai-hidden');
    this.settingsPanel.classList.toggle('hop-ai-hidden', !show);
  }

  private async onProviderChange(): Promise<void> {
    this.populateModels(this.providerSelect.value);
    await this.refreshKeyState();
  }

  private populateModels(provider: string): void {
    const models = MODELS[provider] ?? [];
    this.modelSelect.replaceChildren();
    for (const model of models) this.modelSelect.appendChild(option(model, model));
    this.modelSelect.appendChild(option(CUSTOM_MODEL, '직접 입력…'));
    this.modelSelect.value = models[0] ?? CUSTOM_MODEL;
    this.updateModelVisibility();
  }

  private updateModelVisibility(): void {
    this.modelInput.classList.toggle('hop-ai-hidden', this.modelSelect.value !== CUSTOM_MODEL);
  }

  private currentModel(): string {
    const selected = this.modelSelect.value;
    const model = selected === CUSTOM_MODEL ? this.modelInput.value.trim() : selected;
    return model || defaultModel(this.providerSelect.value);
  }

  private currentCursorPath(): string | null {
    const pos = this.deps.bridge.getCaretPosition?.();
    if (!pos) return null;
    return `sec[${pos.sectionIndex}].p[${pos.paragraphIndex}]`;
  }

  private async refreshKeyState(): Promise<void> {
    const provider = this.providerSelect.value;
    const requiresKey = KEY_PROVIDERS.has(provider);
    const isCustom = provider === CUSTOM_PROVIDER;
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
    if (this.providerSelect.value !== provider) return;
    this.keyState.set(provider, present);
    this.keyStatus.textContent = present ? '키 저장됨' : isCustom ? '키 없음(선택)' : '키 없음';
    this.keyStatus.dataset.tone = present ? 'ok' : isCustom ? 'info' : 'warn';
    this.keyClearBtn.disabled = !present;
  }

  private applyPreset(): void {
    const preset = CUSTOM_PRESETS[this.presetSelect.value];
    if (!preset) return;
    this.baseUrlInput.value = preset.baseUrl;
    this.modelSelect.value = CUSTOM_MODEL;
    this.modelInput.value = preset.model;
    this.updateModelVisibility();
  }

  private async saveKey(): Promise<void> {
    const provider = this.providerSelect.value;
    if (!KEY_PROVIDERS.has(provider) && provider !== CUSTOM_PROVIDER) return;
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
    try {
      await this.deps.bridge.aiDeleteApiKey(provider);
      await this.refreshKeyState();
      this.setStatus(`${provider} API 키를 삭제했습니다.`);
    } catch (error) {
      this.setStatus(`키 삭제 실패: ${String(error)}`, 'error');
    }
  }

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

  // ── 미리보기(Diff/하이라이트) ────────────────────────────────

  private renderDiff(script: ActionScript): void {
    if (!this.active) return;
    this.active.bodyEl.replaceChildren();
    const items = buildDiffModel(
      script,
      this.context ?? { document_metadata: { total_sections: 0 }, content: [] },
    );
    for (const item of items) this.active.bodyEl.appendChild(renderDiffItem(item));
  }

  /**
   * 변경 위치마다 페이지 위에 before/after + 떠 있는 승인/거절 바를 그린다(Cursor식).
   * 카드는 대상(문단/셀) 위치에 좁게, 줄 아래에 둬 원문을 가리지 않는다.
   * 반환: 페이지에 배치한 카드 수(0이면 호출 측이 버블 버튼으로 폴백).
   */
  private renderInlineDiff(script: ActionScript): number {
    const canvasView = this.deps.getCanvasView();
    if (!canvasView) return 0;
    const zoom = canvasView.getViewportManager().getZoom();
    const before = new Map<string, string>();
    for (const node of this.context?.content ?? []) before.set(node.id, node.text);

    const entries: InlineDiffEntry[] = [];
    for (const edit of script.edits) {
      const rect = this.targetRect(edit.target_id);
      if (!rect) continue;
      const page = this.deps.bridge.getPageInfo(rect.pageIndex);
      const pageTop = canvasView.getVirtualScroll().getPageOffset(rect.pageIndex);
      const pageWidth = page.width * zoom;
      const pageLeft = Math.max(0, (this.deps.scrollContent.clientWidth - pageWidth) / 2);
      // 대상 셀/문단의 x에 맞춰 좁은 카드를 둔다(표 전체를 가리지 않음).
      const left = pageLeft + rect.x * zoom;
      const maxWidth = Math.max(120, pageLeft + pageWidth - left - 4);
      const isInsert = edit.command === 'INSERT_BEFORE' || edit.command === 'INSERT_AFTER';
      entries.push({
        top: pageTop + rect.y * zoom,
        lineBottom: pageTop + (rect.y + rect.height) * zoom,
        left,
        maxWidth,
        before: isInsert ? undefined : before.get(edit.target_id),
        after: edit.command === 'DELETE' ? undefined : edit.payload.text,
      });
    }
    if (!entries.length) return 0;
    return showInlineDiff(
      { scrollContent: this.deps.scrollContent, scrollContainer: this.deps.scrollContainer },
      entries,
      { onAccept: () => this.accept(), onReject: () => this.reject() },
    );
  }

  /** 편집 대상(본문/표 셀/중첩 셀)의 페이지 커서 사각형. 실패 시 null. */
  private targetRect(targetId: string): CursorRect | null {
    try {
      const cell = parseCellTarget(targetId);
      if (cell) {
        return this.deps.bridge.getCursorRectByPath(
          cell.sec,
          cell.parentPara,
          JSON.stringify(cell.path),
          0,
        );
      }
      const para = parseParagraphTarget(targetId);
      if (!para) return null;
      return this.deps.bridge.getCursorRect(para.sec, para.para, 0);
    } catch {
      return null;
    }
  }

  /**
   * 낙관적 적용 직후: 새/바뀐 본문 줄(정확한 최종 위치 changed[])에 초록 변경
   * 표시줄, 사라진 기존 내용(REPLACE/DELETE)은 빨간 카드, 변경 위치에 승인/거절 바.
   */
  private renderDecisionBar(script: ActionScript, changed: ChangedPara[]): number {
    const canvasView = this.deps.getCanvasView();
    if (!canvasView) return 0;
    const zoom = canvasView.getViewportManager().getZoom();
    const beforeById = new Map<string, string>();
    for (const node of this.context?.content ?? []) beforeById.set(node.id, node.text);

    const toEntry = (rect: CursorRect, opts: Partial<InlineDiffEntry>): InlineDiffEntry => {
      const page = this.deps.bridge.getPageInfo(rect.pageIndex);
      const pageTop = canvasView.getVirtualScroll().getPageOffset(rect.pageIndex);
      const pageWidth = page.width * zoom;
      const pageLeft = Math.max(0, (this.deps.scrollContent.clientWidth - pageWidth) / 2);
      const left = pageLeft + rect.x * zoom;
      return {
        top: pageTop + rect.y * zoom,
        lineBottom: pageTop + (rect.y + rect.height) * zoom,
        left,
        maxWidth: Math.max(120, pageLeft + pageWidth - left - 4),
        ...opts,
      };
    };

    const entries: InlineDiffEntry[] = [];
    // 초록 변경 표시줄 — 새/바뀐 본문 문단의 정확한 최종 위치.
    for (const { sec, para } of changed) {
      try {
        entries.push(toEntry(this.deps.bridge.getCursorRect(sec, para, 0), { changeBar: true }));
      } catch {
        /* 좌표 실패는 무시 */
      }
    }
    // 빨간 카드 — 사라진 기존 내용(REPLACE/DELETE).
    for (const edit of script.edits) {
      if (edit.command !== 'REPLACE' && edit.command !== 'DELETE') continue;
      const old = beforeById.get(edit.target_id);
      if (old === undefined) continue;
      const rect = this.targetRect(edit.target_id);
      if (rect) entries.push(toEntry(rect, { before: old }));
    }
    if (!entries.length) return 0;
    return showInlineDiff(
      { scrollContent: this.deps.scrollContent, scrollContainer: this.deps.scrollContainer },
      entries,
      { onAccept: () => this.accept(), onReject: () => this.reject() },
    );
  }

  /** export/load를 지원하면 현재 문서를 스냅샷으로 잡는다. 반환: 스냅샷 성공 여부. */
  private snapshotDocument(): boolean {
    const b = this.deps.bridge;
    if (!b.exportHwp || !b.loadDocument || !b.getSourceFormat) return false;
    try {
      const isHwpx = b.getSourceFormat() === 'hwpx';
      const bytes = isHwpx && b.exportHwpx ? b.exportHwpx() : b.exportHwp();
      this.snapshot = { bytes, fileName: b.fileName ?? 'document.hwp' };
      return true;
    } catch {
      this.snapshot = null;
      return false;
    }
  }

  /** 스냅샷이 있으면 문서를 그 시점으로 되돌린다(거절/롤백). */
  private revertToSnapshot(): void {
    const b = this.deps.bridge;
    if (this.snapshot && b.loadDocument) {
      try {
        b.loadDocument(this.snapshot.bytes, this.snapshot.fileName);
        this.reflowAndRender();
      } catch {
        /* 복원 실패는 무시 — 최소한 미리보기 UI는 정리한다. */
      }
    }
    this.snapshot = null;
    this.applied = null;
    this.clearPreview();
  }

  /** 줄·페이지 재배치 후 재렌더 트리거. */
  private reflowAndRender(): void {
    try {
      this.deps.bridge.reflowLinesegs?.();
    } catch {
      /* reflow 실패는 무시 */
    }
    this.deps.eventBus.emit('document-changed', 'ai-edit');
  }

  private clearPreview(): void {
    this.pendingScript = null;
    clearInlineDiff(this.deps.scrollContent);
    if (this.active) {
      this.active.bodyEl.replaceChildren();
      this.setPreviewEnabledFor(this.active, false);
    }
  }

  private setPreviewEnabled(enabled: boolean): void {
    if (this.active) this.setPreviewEnabledFor(this.active, enabled);
  }

  private setPreviewEnabledFor(turn: ActiveTurn, enabled: boolean): void {
    // 평소 버블 내 승인/거절은 숨긴다 — 페이지 위 인라인 바가 담당한다.
    // 좌표를 못 잡은 폴백(enabled=true)일 때만 버블 버튼을 노출한다.
    turn.decisionEl.classList.toggle('hop-ai-hidden', !enabled);
    turn.acceptBtn.disabled = !enabled;
    turn.rejectBtn.disabled = !enabled;
  }

  private setRequesting(active: boolean): void {
    this.sendBtn.disabled = active;
    this.cancelBtn.classList.toggle('hop-ai-hidden', !active);
  }

  /** 전역(컴포저) 상태줄 — 가드/안내용. */
  private setStatus(message: string, tone: 'info' | 'ok' | 'warn' | 'error' = 'info'): void {
    this.statusArea.textContent = message;
    this.statusArea.dataset.tone = tone;
  }

  /** 현재(또는 지정) 어시스턴트 버블의 상태줄. */
  private setActiveStatus(
    message: string,
    tone: 'info' | 'ok' | 'warn' | 'error' = 'info',
    turn: ActiveTurn | null = this.active,
  ): void {
    if (!turn) {
      this.setStatus(message, tone);
      return;
    }
    turn.statusEl.textContent = message;
    turn.statusEl.dataset.tone = tone;
  }
}

function defaultModel(provider: string): string {
  switch (provider) {
    case 'openai':
      return 'gpt-4o-mini';
    case 'anthropic':
      return 'claude-3-5-haiku-latest';
    case 'gemini':
      return 'gemini-2.5-flash';
    case 'ollama':
      return 'llama3.1';
    case CLAUDE_CLI_PROVIDER:
    case GEMINI_CLI_PROVIDER:
      return 'default';
    case CUSTOM_PROVIDER:
      return 'llama-3.1-8b-instant';
    default:
      return 'gemini-2.5-flash';
  }
}

function renderDiffItem(item: DiffItem): HTMLElement {
  const row = el('div', 'hop-ai-diff-item');
  const head = el('div', 'hop-ai-diff-head');
  head.textContent = `${item.command} · ${item.targetId}`;
  row.appendChild(head);
  if (item.beforeText !== undefined) {
    const before = el('div', 'hop-ai-diff-before');
    before.textContent = item.beforeText;
    row.appendChild(before);
  }
  if (item.afterText !== undefined) {
    const after = el('div', 'hop-ai-diff-after');
    after.textContent = item.afterText;
    row.appendChild(after);
  }
  return row;
}

interface PanelParts {
  panel: HTMLElement;
  toggleBtn: HTMLButtonElement;
  closeBtn: HTMLButtonElement;
  newChatBtn: HTMLButtonElement;
  settingsBtn: HTMLButtonElement;
  thread: HTMLElement;
  promptInput: HTMLTextAreaElement;
  providerSelect: HTMLSelectElement;
  modelSelect: HTMLSelectElement;
  modelInput: HTMLInputElement;
  sendBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  statusArea: HTMLElement;
  chipsArea: HTMLElement;
  imageInput: HTMLInputElement;
  docInput: HTMLInputElement;
  attachImageBtn: HTMLButtonElement;
  attachDocBtn: HTMLButtonElement;
  settingsPanel: HTMLElement;
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
  const toggleBtn = el('button', 'hop-ai-toggle') as HTMLButtonElement;
  toggleBtn.textContent = 'AI';
  toggleBtn.title = 'AI 편집 도우미';

  const panel = el('aside', 'hop-ai-panel');

  // 헤더
  const header = el('div', 'hop-ai-header');
  const title = el('span', 'hop-ai-title');
  title.textContent = 'AI 편집';
  const newChatBtn = el('button', 'hop-ai-newchat') as HTMLButtonElement;
  newChatBtn.textContent = '＋';
  newChatBtn.title = '새 대화';
  const settingsBtn = el('button', 'hop-ai-settings-btn') as HTMLButtonElement;
  settingsBtn.textContent = '⚙';
  settingsBtn.title = '옵션 (API 키·엔드포인트·민감 문서)';
  const closeBtn = el('button', 'hop-ai-close') as HTMLButtonElement;
  closeBtn.textContent = '×';
  header.append(title, newChatBtn, settingsBtn, closeBtn);

  // 대화 스레드
  const thread = el('div', 'hop-ai-thread');

  // 옵션 패널(⚙)
  const keyInput = inputEl('hop-ai-key', 'password', 'API 키');
  keyInput.autocomplete = 'off';
  const keySaveBtn = btn('hop-ai-key-save', '키 저장');
  const keyClearBtn = btn('hop-ai-key-clear', '삭제');
  const keyStatus = el('span', 'hop-ai-key-status');
  const keyRow = el('div', 'hop-ai-key-row');
  keyRow.append(keyInput, keySaveBtn, keyClearBtn, keyStatus);

  const presetSelect = document.createElement('select');
  presetSelect.className = 'hop-ai-preset';
  for (const [value, label] of [
    ['', '프리셋'],
    ['groq', 'Groq'],
    ['openrouter', 'OpenRouter'],
    ['together', 'Together'],
  ] as const) {
    presetSelect.appendChild(option(value, label));
  }
  const baseUrlInput = inputEl('hop-ai-base-url', 'text', 'Base URL (예: https://api.groq.com/openai)');
  const customRow = el('div', 'hop-ai-custom-row');
  customRow.append(presetSelect, baseUrlInput);

  const sensitiveCheckbox = document.createElement('input');
  sensitiveCheckbox.className = 'hop-ai-sensitive';
  sensitiveCheckbox.type = 'checkbox';
  const sensitiveText = el('span', 'hop-ai-sensitive-text');
  sensitiveText.textContent = '민감 문서 — 외부 전송 차단';
  const sensitiveRow = el('label', 'hop-ai-sensitive-row');
  sensitiveRow.append(sensitiveCheckbox, sensitiveText);

  const settingsPanel = el('div', 'hop-ai-settings');
  settingsPanel.append(customRow, keyRow, sensitiveRow);

  // 컴포저(하단 입력)
  const chipsArea = el('div', 'hop-ai-chips');
  const promptInput = document.createElement('textarea');
  promptInput.className = 'hop-ai-prompt';
  promptInput.rows = 3;
  promptInput.placeholder = '무엇을 바꿀까요?  (예: 표의 총 사업비를 10억으로)';

  const imageInput = inputEl('hop-ai-image-input hop-ai-hidden', 'file', '');
  imageInput.accept = 'image/*';
  imageInput.multiple = true;
  const docInput = inputEl('hop-ai-doc-input hop-ai-hidden', 'file', '');
  docInput.accept = '.pdf,.txt,.md,.markdown,.csv,.json,.html,.xml';
  docInput.multiple = true;

  const attachImageBtn = btn('hop-ai-attach-image', '🖼');
  attachImageBtn.title = '이미지 첨부';
  const attachDocBtn = btn('hop-ai-attach-doc', '📎');
  attachDocBtn.title = '문서 첨부 (텍스트)';
  const composerLeft = el('div', 'hop-ai-composer-left');
  composerLeft.append(attachDocBtn, attachImageBtn);

  const providerSelect = document.createElement('select');
  providerSelect.className = 'hop-ai-provider';
  for (const id of PROVIDERS) providerSelect.appendChild(option(id, PROVIDER_LABELS[id] ?? id));
  const modelSelect = document.createElement('select');
  modelSelect.className = 'hop-ai-model-select';
  const modelInput = inputEl('hop-ai-model', 'text', '모델 ID 직접 입력');
  const sendBtn = btn('hop-ai-send', '↑');
  sendBtn.title = '전송 (Enter)';
  const cancelBtn = btn('hop-ai-cancel', '취소');
  const composerRight = el('div', 'hop-ai-composer-right');
  composerRight.append(providerSelect, modelSelect, modelInput, cancelBtn, sendBtn);

  const composerBar = el('div', 'hop-ai-composer-bar');
  composerBar.append(composerLeft, composerRight);

  const statusArea = el('div', 'hop-ai-status');
  const composer = el('div', 'hop-ai-composer');
  composer.append(chipsArea, promptInput, composerBar, statusArea, imageInput, docInput);

  panel.append(header, thread, settingsPanel, composer);

  return {
    panel,
    toggleBtn,
    closeBtn,
    newChatBtn,
    settingsBtn,
    thread,
    promptInput,
    providerSelect,
    modelSelect,
    modelInput,
    sendBtn,
    cancelBtn,
    statusArea,
    chipsArea,
    imageInput,
    docInput,
    attachImageBtn,
    attachDocBtn,
    settingsPanel,
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

function btn(className: string, text: string): HTMLButtonElement {
  const node = el('button', className) as HTMLButtonElement;
  node.textContent = text;
  return node;
}

function inputEl(className: string, type: string, placeholder: string): HTMLInputElement {
  const node = document.createElement('input');
  node.className = className;
  node.type = type;
  if (placeholder) node.placeholder = placeholder;
  return node;
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option') as HTMLOptionElement;
  node.value = value;
  node.textContent = label;
  return node;
}

function uid(): string {
  return Math.random().toString(36).slice(2);
}

/** 텍스트로 읽어 인라인할 수 있는 문서인지(드롭 시 바이너리 첨부 방지). */
function isTextLike(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  return /\.(txt|md|markdown|csv|json|html?|xml)$/i.test(file.name);
}

function attachmentIcon(kind: Attachment['kind']): string {
  if (kind === 'image') return '🖼';
  if (kind === 'file') return '📄';
  return '📎';
}

function mimeForImage(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'bmp') return 'image/bmp';
  return 'image/png';
}

/** 바이트 배열을 base64로(큰 이미지에서 호출 스택 폭주를 피하려 청크 처리). */
function base64FromBytes(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
