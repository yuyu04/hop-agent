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
  type Edit,
  type AiEditFailed,
  type AiEditReady,
  type AiEventUnsubscribe,
  type AiStreamDelta,
  type ContentNode,
  type DocumentContext,
} from '@/core/ai-bridge';
import type { AiBridgeApi, AiImageInput } from '@/core/tauri-bridge';
import {
  applyActionScript,
  parseCellTarget,
  parseParagraphTarget,
  type ApplyResult,
  type ChangedPara,
  type ImageForInsert,
  type WasmEditing,
} from '@/core/ai-apply';
import { buildDiffModel, type DiffItem } from '@/core/ai-diff';
import { AiSessionMachine } from '@/core/ai-session';
import {
  deleteConversation,
  loadConversations,
  upsertConversation,
  type StoredConversation,
  type StoredMessage,
} from '@/core/conversation-store';
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
  /** 에디터에서 현재 선택된 텍스트(없으면 null). 선택 영역 인식 편집용. */
  getSelectedText?(): string | null;
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
  /** 백그라운드 추출 진행 중(칩에 ⏳ 표시, 전송 시 완료 대기). */
  loading?: boolean;
}

/** PDF 등 바이너리 문서 입력을 받는 provider(스펙 5장). */
const DOC_PROVIDERS = new Set<string>(['gemini', 'anthropic']);

/** 진행 중인 어시스턴트 턴의 DOM 참조. */
interface ActiveTurn {
  streamEl: HTMLElement;
  /** AI의 대화형 요약(무엇을 했는지). */
  msgEl: HTMLElement;
  bodyEl: HTMLElement;
  decisionEl: HTMLElement;
  acceptBtn: HTMLButtonElement;
  rejectBtn: HTMLButtonElement;
  statusEl: HTMLElement;
}

/** 대화 하나(탭 + 스레드). 새 대화를 만들어도 기존이 지워지지 않는다. */
interface Conversation {
  id: string;
  tab: HTMLElement;
  thread: HTMLElement;
  hasMessages: boolean;
  title: string;
  createdAt: number;
  /** 영속 저장용 대화 기록(사용자 지시 + AI 요약). */
  messages: StoredMessage[];
}

export class AgentSidebar {
  private readonly panel: HTMLElement;
  private readonly tabBar: HTMLElement;
  private readonly threadsWrap: HTMLElement;
  private readonly conversations: Conversation[] = [];
  private activeConv!: Conversation;
  /** 활성 대화의 스레드(기존 코드 호환용 getter). */
  private get thread(): HTMLElement {
    return this.activeConv.thread;
  }
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
  private readonly settingsModal: HTMLElement;
  private readonly menu: HTMLElement;
  private readonly logPanel: HTMLElement;
  private readonly historyPanel: HTMLElement;
  /** 디버그 로그 버퍼(최근 N줄). */
  private logs: string[] = [];
  /** '로그 보기'로 연 별도 로그 창(있으면 실시간 갱신). */
  private logWindow: Window | null = null;
  /** 작업 모드: 'edit'=문서 편집, 'ask'=편집 없이 질문/요약 답변. */
  private mode: 'edit' | 'ask' = 'edit';
  /** 전송 시점에 고정한 모드(응답 처리에서 사용 — this.mode가 그새 바뀌어도 안전).
   *  'proofread'는 전체 교정 패스(응답을 적용하지 않고 이슈 목록으로 수집). */
  private requestMode: 'edit' | 'ask' | 'proofread' = 'edit';
  /** 교정 패스의 순차 루프가 기다리는 현재 구간 응답 resolver. */
  private proofreadResolve: ((script: ActionScript | null) => void) | null = null;
  private readonly modeEditBtn: HTMLButtonElement;
  private readonly modeAskBtn: HTMLButtonElement;
  private readonly quickActions: HTMLElement;
  private readonly skillSelect: HTMLSelectElement;
  /** 로드된 글쓰기 스킬 목록(문서 유형별 작성 지침). */
  private skills: { id: string; name: string; description: string; triggers: string[]; body: string }[] = [];
  /** 변형 제안 상태(대안 버튼들 + 대상 edit + 컨테이너). 변형을 고를 때 다시 적용한다. */
  private variationState: { edit: Edit; btns: HTMLButtonElement[]; container: HTMLElement } | null =
    null;
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
  /** 진행 중인 백그라운드 문서 추출(전송 시 완료를 기다린다). */
  private extractTasks: Promise<void>[] = [];
  private active: ActiveTurn | null = null;
  private unsubscribe: AiEventUnsubscribe | null = null;
  private copyHandler: ((event: KeyboardEvent) => void) | null = null;
  private requestId: string | null = null;
  private context: DocumentContext | null = null;
  private pendingScript: ActionScript | null = null;
  /** 이번 요청에 첨부된 이미지(삽입용, 첨부 순서). image_index가 이 배열을 가리킨다. */
  private pendingInsertImages: ImageForInsert[] = [];
  /** 낙관적 적용 전 문서 스냅샷(거절/롤백 시 복원). */
  private snapshot: { bytes: Uint8Array; fileName: string } | null = null;
  /** 낙관적 적용 결과(승인 메시지용). */
  private applied: ApplyResult | null = null;
  /** 개별 거절된 edit 인덱스(pendingScript.edits 기준). 승인 시 제외된다. */
  private rejectedEdits = new Set<number>();
  /** 사이드바 diff 행(개별 거절 시 시각 상태 갱신용, edit 인덱스와 1:1). */
  private diffRows: HTMLElement[] = [];

  constructor(private readonly deps: AgentSidebarDeps) {
    this.session = new AiSessionMachine({ onRollback: () => this.revertToSnapshot() });
    const built = buildPanel();
    this.panel = built.panel;
    this.tabBar = built.tabBar;
    this.threadsWrap = built.threadsWrap;
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
    this.settingsModal = built.settingsModal;
    this.menu = built.menu;
    this.logPanel = built.logPanel;
    this.historyPanel = built.historyPanel;
    this.modeEditBtn = built.modeEditBtn;
    this.modeAskBtn = built.modeAskBtn;
    this.quickActions = built.quickActions;
    this.skillSelect = built.skillSelect;
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
    built.historyBtn.addEventListener('click', () => this.toggleHistory());
    built.settingsBtn.addEventListener('click', () => this.toggleMenu());
    built.settingsClose.addEventListener('click', () => this.toggleSettings(false));
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
    this.modeEditBtn.addEventListener('click', () => this.setMode('edit'));
    this.modeAskBtn.addEventListener('click', () => this.setMode('ask'));
    // 빠른 작업 칩 — data-action으로 위임 처리.
    this.quickActions.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (target?.dataset.action) void this.runQuickAction(target.dataset.action);
    });
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
    this.keyRow.classList.add('hop-ai-hidden');
    this.customRow.classList.add('hop-ai-hidden');
    this.setRequesting(false);
    this.populateModels(this.providerSelect.value);
    this.renderChips();
    this.newConversation(); // 첫 대화 생성(빈 상태 → 컴포저 상단)
    void this.subscribe();
    void this.subscribeNativeDragDrop();
    void this.refreshKeyState();
    void this.loadSkills();
  }

  /** 글쓰기 스킬을 불러와 드롭다운을 채운다(자동/없음 + 각 스킬). */
  private async loadSkills(): Promise<void> {
    try {
      if (typeof this.deps.bridge.aiListSkills === 'function') {
        this.skills = await this.deps.bridge.aiListSkills();
      }
    } catch {
      this.skills = [];
    }
    const prev = this.skillSelect.value;
    this.skillSelect.replaceChildren();
    this.skillSelect.appendChild(option('auto', '스킬: 자동'));
    this.skillSelect.appendChild(option('none', '스킬: 없음'));
    for (const s of this.skills) this.skillSelect.appendChild(option(`id:${s.id}`, `스킬: ${s.name}`));
    this.skillSelect.value = prev || 'auto';
  }

  /**
   * 이번 요청에 적용할 스킬 본문을 고른다. 드롭다운이 특정 스킬이면 그것, '없음'이면 null,
   * '자동'이면 프롬프트에 트리거 키워드가 가장 많이 맞는 스킬을 고른다.
   */
  private selectedSkillBody(prompt: string): { name: string; body: string } | null {
    const v = this.skillSelect?.value ?? 'auto';
    if (v === 'none') return null;
    if (v.startsWith('id:')) {
      const s = this.skills.find((x) => x.id === v.slice(3));
      return s ? { name: s.name, body: s.body } : null;
    }
    const p = prompt.toLowerCase();
    let best: { name: string; body: string; score: number } | null = null;
    for (const s of this.skills) {
      let score = 0;
      for (const t of s.triggers) if (t && p.includes(t.toLowerCase())) score += 1;
      if (score > 0 && (!best || score > best.score)) best = { name: s.name, body: s.body, score };
    }
    return best ? { name: best.name, body: best.body } : null;
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
        } else if (/\.(pdf|hwp|hwpx|docx)$/i.test(name)) {
          // PDF·한글·워드는 네이티브로 평문 추출 → 모든 provider에 인라인(경로/샌드박스 무관).
          // 칩은 즉시 띄우고(로딩), 추출은 백그라운드로 — 기다리지 않게 한다.
          const att: Attachment = { id: uid(), kind: 'doc', name, text: '', loading: true, path };
          this.attachments.push(att);
          this.extractTasks.push(
            (async () => {
              try {
                att.text = await this.deps.bridge.aiExtractText(path);
              } catch (e) {
                att.text = '';
                this.setStatus(`첨부 분석 실패(${name}): ${String(e)}`, 'error');
              } finally {
                att.loading = false;
                this.renderChips();
              }
            })(),
          );
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

  /** 새 대화(탭)를 만든다 — 기존 대화는 지우지 않고 탭으로 보존한다. */
  private newConversation(): void {
    // 진행 중 미확정 편집은 정리(다른 대화로 넘어가므로).
    if (this.active) {
      this.session.cancel();
      this.clearPreview();
    }
    this.requestId = null;
    this.active = null;
    this.attachments = [];
    this.extractTasks = [];
    this.renderChips();
    this.setStatus('');

    const id = uid();
    const thread = el('div', 'hop-ai-thread');
    thread.classList.add('hop-ai-hidden');
    this.threadsWrap.appendChild(thread);
    const tab = el('button', 'hop-ai-tab') as HTMLButtonElement;
    tab.textContent = '새 대화';
    tab.addEventListener('click', () => this.switchConversation(id));
    this.tabBar.appendChild(tab);

    const conv: Conversation = {
      id,
      tab,
      thread,
      hasMessages: false,
      title: '새 대화',
      createdAt: Date.now(),
      messages: [],
    };
    this.conversations.push(conv);
    this.switchConversation(id);
  }

  /** 활성 대화에 메시지를 한 줄 기록하고 영속 저장소에 갱신한다. */
  private recordMessage(role: 'user' | 'assistant', text: string): void {
    const conv = this.activeConv;
    if (!conv || !text.trim()) return;
    conv.messages.push({ role, text, ts: Date.now() });
    upsertConversation({
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      updatedAt: Date.now(),
      messages: conv.messages,
    });
  }

  /** 과거 대화 기록 드로어를 토글한다(AI 패널 왼쪽). */
  private toggleHistory(open?: boolean): void {
    const show = open ?? this.historyPanel.classList.contains('hop-ai-hidden');
    if (show) this.renderHistory();
    this.historyPanel.classList.toggle('hop-ai-hidden', !show);
  }

  /** 영속 저장된 대화 목록을 그린다(최신순, 삭제 버튼 포함). */
  private renderHistory(): void {
    this.historyPanel.replaceChildren();
    const head = el('div', 'hop-ai-history-head');
    head.textContent = '과거 대화';
    const closeBtn = el('button', 'hop-ai-history-close') as HTMLButtonElement;
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', () => this.toggleHistory(false));
    head.appendChild(closeBtn);
    this.historyPanel.appendChild(head);

    const stored = loadConversations();
    if (!stored.length) {
      const empty = el('div', 'hop-ai-history-empty');
      empty.textContent = '저장된 대화가 없습니다.';
      this.historyPanel.appendChild(empty);
      return;
    }
    for (const conv of stored) {
      const item = el('div', 'hop-ai-history-item');
      const main = el('button', 'hop-ai-history-main') as HTMLButtonElement;
      const date = new Date(conv.updatedAt);
      const when = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
      const titleEl = el('div', 'hop-ai-history-title');
      titleEl.textContent = conv.title || '(제목 없음)';
      const metaEl = el('div', 'hop-ai-history-meta');
      metaEl.textContent = `${when} · ${conv.messages.length}개 메시지`;
      main.append(titleEl, metaEl);
      main.addEventListener('click', () => {
        this.openStoredConversation(conv);
        this.toggleHistory(false);
      });
      const del = el('button', 'hop-ai-history-del') as HTMLButtonElement;
      del.textContent = '🗑';
      del.title = '삭제';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteConversation(conv.id);
        this.renderHistory();
      });
      item.append(main, del);
      this.historyPanel.appendChild(item);
    }
  }

  /** 저장된 대화를 새 탭으로 열어 메시지를 다시 그린다. 이미 열려 있으면 전환만 한다. */
  private openStoredConversation(stored: StoredConversation): void {
    const existing = this.conversations.find((c) => c.id === stored.id);
    if (existing) {
      this.switchConversation(stored.id);
      return;
    }
    // 진행 중 미확정 편집 정리.
    if (this.active) {
      this.session.cancel();
      this.clearPreview();
    }
    this.requestId = null;
    this.active = null;

    const thread = el('div', 'hop-ai-thread');
    thread.classList.add('hop-ai-hidden');
    this.threadsWrap.appendChild(thread);
    const tab = el('button', 'hop-ai-tab') as HTMLButtonElement;
    tab.textContent = stored.title.length > 12 ? `${stored.title.slice(0, 12)}…` : stored.title;
    tab.addEventListener('click', () => this.switchConversation(stored.id));
    this.tabBar.appendChild(tab);

    const conv: Conversation = {
      id: stored.id,
      tab,
      thread,
      hasMessages: true,
      title: stored.title,
      createdAt: stored.createdAt,
      messages: [...stored.messages],
    };
    this.conversations.push(conv);
    this.activeConv = conv;
    // 저장된 메시지를 정적으로 다시 그린다(과거 기록 보기 — 편집 미리보기는 없음).
    for (const m of stored.messages) {
      if (m.role === 'user') this.appendUserTurn(m.text, []);
      else this.appendAssistantMessageStatic(m.text);
    }
    this.switchConversation(stored.id);
  }

  /** 과거 기록용 정적 AI 메시지 버블(승인/거절·로딩 없이 텍스트만). */
  private appendAssistantMessageStatic(text: string): void {
    const bubble = el('div', 'hop-ai-msg hop-ai-msg-assistant');
    const msgEl = el('div', 'hop-ai-msg-text');
    msgEl.textContent = text;
    bubble.appendChild(msgEl);
    this.thread.appendChild(bubble);
    this.scrollThreadToEnd();
  }

  private switchConversation(id: string): void {
    const conv = this.conversations.find((c) => c.id === id);
    if (!conv) return;
    this.activeConv = conv;
    for (const c of this.conversations) {
      c.thread.classList.toggle('hop-ai-hidden', c !== conv);
      c.tab.classList.toggle('hop-ai-tab-active', c === conv);
    }
    this.updateComposerPosition();
  }

  /** 활성 대화에 메시지가 있는지로 탭 제목·컴포저 위치를 갱신한다. */
  private markActiveHasMessages(firstUserText?: string): void {
    if (!this.activeConv.hasMessages) {
      this.activeConv.hasMessages = true;
      if (firstUserText) {
        const title = firstUserText.length > 24 ? `${firstUserText.slice(0, 24)}…` : firstUserText;
        this.activeConv.title = title;
        this.activeConv.tab.textContent =
          firstUserText.length > 12 ? `${firstUserText.slice(0, 12)}…` : firstUserText;
      }
    }
    this.updateComposerPosition();
  }

  /** 빈 새 대화면 입력창을 상단에, 대화가 시작되면 하단에 둔다(Cursor식). */
  private updateComposerPosition(): void {
    this.panel.classList.toggle('hop-ai-empty', !this.activeConv.hasMessages);
  }

  /** 작업 모드 전환(편집/질문). 질문 모드는 문서를 수정하지 않고 답변만 한다. */
  private setMode(mode: 'edit' | 'ask'): void {
    this.mode = mode;
    this.modeEditBtn.classList.toggle('hop-ai-mode-active', mode === 'edit');
    this.modeAskBtn.classList.toggle('hop-ai-mode-active', mode === 'ask');
    this.promptInput.placeholder =
      mode === 'ask'
        ? '문서에 대해 물어보세요 (예: 이 문서 핵심만 요약해줘) — 편집하지 않습니다'
        : '무엇을 바꿀까요?  (예: 표의 총 사업비를 10억으로)';
  }

  /** 빠른 작업 칩 — 프리셋 지시를 채워 바로 전송한다. 선택 영역이 있으면 그 부분이 대상. */
  private async runQuickAction(action: string): Promise<void> {
    // 전체 교정은 프리셋 전송이 아니라 전용 스캔 루프를 돈다(F-55a6a4).
    if (action === 'proofread') {
      await this.runProofread();
      return;
    }
    const presets: Record<string, { mode: 'edit' | 'ask'; text: string }> = {
      concise: { mode: 'edit', text: '선택한 부분(선택이 없으면 현재 문단)을 의미는 유지하되 더 간결하게 다듬어줘.' },
      formal: { mode: 'edit', text: '선택한 부분(선택이 없으면 현재 문단)을 더 격식 있고 정중한 문어체로 다듬어줘.' },
      expand: { mode: 'edit', text: '선택한 부분(선택이 없으면 현재 문단)을 더 자세하고 구체적으로 확장해줘.' },
      grammar: { mode: 'edit', text: '선택한 부분(선택이 없으면 현재 문단)의 맞춤법·문법·어색한 표현만 교정하고 내용은 그대로 둬.' },
      variations: {
        mode: 'edit',
        text: '선택한 부분(선택이 없으면 현재 문단)을 다시 써줘. 한 edit의 payload.variations에 서로 다른 표현의 대안을 2~3개 넣고, payload.text에는 추천안(첫 번째)을 넣어줘.',
      },
      summarize: { mode: 'ask', text: '이 문서(선택 영역이 있으면 그 부분)의 핵심을 요약해줘.' },
    };
    const preset = presets[action];
    if (!preset) return;
    this.setMode(preset.mode);
    const existing = this.promptInput.value.trim();
    this.promptInput.value = existing ? `${existing}\n${preset.text}` : preset.text;
    await this.send();
  }

  /** 전송 공통 가드(문서/민감/키/Base URL). 통과 시 요청 파라미터를, 막히면 null을 반환한다. */
  private checkSendGuards(): { docId: string; provider: string; baseUrl: string | null } | null {
    const docId = this.deps.bridge.currentDocId();
    if (!docId) {
      this.setStatus('먼저 문서를 여세요.', 'warn');
      return null;
    }
    const provider = this.providerSelect.value;
    if (this.sensitive && !LOCAL_PROVIDERS.has(provider)) {
      this.setStatus('민감 문서로 표시됨 — 로컬 모델(ollama)만 사용할 수 있습니다.', 'warn');
      return null;
    }
    if (KEY_PROVIDERS.has(provider) && this.keyState.get(provider) === false) {
      this.toggleSettings(true);
      this.setStatus('API 키를 먼저 저장하세요. (⚙ 옵션에서 입력)', 'warn');
      return null;
    }
    const baseUrl = provider === CUSTOM_PROVIDER ? this.baseUrlInput.value.trim() : null;
    if (provider === CUSTOM_PROVIDER && !baseUrl) {
      this.toggleSettings(true);
      this.setStatus('Base URL을 입력하세요 (⚙ 옵션, 예: https://api.groq.com/openai).', 'warn');
      return null;
    }
    return { docId, provider, baseUrl };
  }

  private async send(): Promise<void> {
    const prompt = this.promptInput.value.trim();
    if (!prompt) {
      this.setStatus('지시를 입력하세요.', 'warn');
      return;
    }
    const guard = this.checkSendGuards();
    if (!guard) return;
    const { docId, provider, baseUrl } = guard;

    // 첨부 문서가 아직 백그라운드 추출 중이면, 끝난 뒤에 AI에 전송한다.
    if (this.extractTasks.length) {
      this.setStatus('첨부 문서 분석이 끝나면 전송합니다…');
      await Promise.all(this.extractTasks);
      this.extractTasks = [];
    }

    // 미확정 Diff가 있으면 자동 롤백 후 진행(스펙 4장 동시성).
    const attachments = this.attachments;
    const isCli = CLI_PROVIDERS.has(provider);
    const docText = attachments
      .filter((a) => a.kind === 'doc')
      .map((a) => `[첨부 문서: ${a.name}]\n${a.text ?? ''}`)
      .join('\n\n');

    // 삽입/비전용 이미지 소스(라벨 포함): 첨부 이미지 → 프롬프트 URL → PDF 렌더 페이지.
    // 이 순서가 image_index가 되며, 아래에서 프롬프트에 인덱스 목록(매니페스트)을 넣어
    // AI가 정확한 image_index를 쓰게 한다.
    const labeled: { input: AiImageInput; label: string }[] = [];
    for (const a of attachments.filter((a) => a.kind === 'image' && a.dataBase64)) {
      labeled.push({
        input: { mimeType: a.mime ?? 'image/png', dataBase64: a.dataBase64! },
        label: `첨부 이미지: ${a.name}`,
      });
    }
    labeled.push(...(await this.fetchPromptImageUrls(prompt)));
    labeled.push(...(await this.fetchPdfAttachmentImages(attachments, prompt)));
    const allImageInputs = labeled.map((l) => l.input);
    this.log(`요청: provider=${provider}, 이미지 ${labeled.length}개`);
    if (labeled.length) {
      this.log(`이미지 인덱스:\n${labeled.map((l, i) => `  [${i}] ${l.label}`).join('\n')}`);
    }
    const imageManifest = labeled.length
      ? `사용 가능한 이미지 목록(각 줄의 번호가 image_index):\n${labeled
          .map((l, i) => `[${i}] ${l.label}`)
          .join('\n')}\n이 번호를 image_index로 사용하세요. 페이지 번호와 헷갈리지 마세요.\n\n`
      : '';

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
      images = allImageInputs;
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
    // 전송 시점의 모드를 고정(응답 처리에서 사용).
    this.requestMode = this.mode;
    // 본문에서 드래그한 선택 텍스트가 있으면 그 부분만 대상으로 삼게 한다(선택 영역 인식).
    const selectedText = this.deps.getSelectedText?.()?.trim() ?? '';
    const selPrefix = selectedText
      ? `[사용자가 선택한 텍스트]\n«${selectedText}»\n위 선택 영역만 대상으로 작업하고, 그 텍스트가 포함된 문단을 REPLACE하세요. 선택 밖 내용은 바꾸지 마세요.\n\n`
      : '';
    const askPrefix =
      this.requestMode === 'ask'
        ? '다음은 편집 요청이 아니라 질문입니다. 문서를 절대 수정하지 말고(edits는 반드시 빈 배열 []) message에만 한국어로 답하거나 요약하세요.\n\n'
        : '';
    if (selectedText) this.log(`선택 영역 ${selectedText.length}자 포함`);
    this.log(`모드: ${this.requestMode === 'ask' ? '질문/요약' : '편집'}`);
    // 글쓰기 스킬 본문을 배경 지침으로 맨 앞에 주입(자동 선택 또는 수동 지정).
    const skill = this.selectedSkillBody(prompt);
    const skillPrefix = skill
      ? `[작성 스킬: ${skill.name}]\n${skill.body}\n\n---\n\n`
      : '';
    if (skill) this.log(`스킬 적용: ${skill.name}`);
    const effectivePrompt = `${skillPrefix}${askPrefix}${selPrefix}${docText ? `${docText}\n\n` : ''}${imageManifest}${prompt}`;

    // 삽입용 이미지 디코드(원본 픽셀 크기) — image_index가 이 배열을 가리킨다.
    this.pendingInsertImages = await buildInsertImages(allImageInputs);

    this.appendUserTurn(prompt, attachments);
    this.recordMessage('user', prompt);
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

  /**
   * 첨부된 PDF에서 내장 이미지를 추출해 이미지 입력으로 반환한다. 그림/이미지 관련 요청일
   * 때만(PDF마다 이미지가 많아 매번 보내면 토큰 낭비) 추출한다.
   */
  private async fetchPdfAttachmentImages(
    attachments: Attachment[],
    prompt: string,
  ): Promise<{ input: AiImageInput; label: string }[]> {
    if (!/그림|이미지|그래프|사진|도표|차트|figure|그래픽|graph|image|picture/i.test(prompt)) {
      return [];
    }
    const pdfs = attachments.filter((a) => a.path && /\.pdf$/i.test(a.path));
    const out: { input: AiImageInput; label: string }[] = [];
    for (const a of pdfs) {
      // 요청과 관련된 PDF 페이지에서 '그림 영역만'(텍스트 제외) 잘라 받는다(구조적 분리).
      // figureOnly=true면 이미 그림만이라 crop 불필요. 못 잡은 페이지는 전체 렌더 폴백 →
      // 그 경우만 AI가 crop으로 도표 영역을 잘라낸다.
      try {
        if (typeof this.deps.bridge.aiRenderPdfFigurePages === 'function') {
          const pages = await this.deps.bridge.aiRenderPdfFigurePages(a.path!, prompt);
          for (const p of pages) {
            if (p.dataBase64) {
              const where = p.page ? `${p.page}쪽` : '';
              const label = p.figureOnly
                ? `PDF '${a.name}' ${where} 그림만 추출됨(텍스트 제외) — crop 없이 그대로 넣기`
                : `PDF '${a.name}' ${where} 페이지 렌더 — 페이지 전체 금지, crop으로 그림(도표) 영역만 잘라 넣기`;
              out.push({
                input: { mimeType: p.mime || 'image/png', dataBase64: p.dataBase64 },
                label,
              });
            }
          }
          if (pages.length) continue;
        }
        if (typeof this.deps.bridge.aiExtractPdfImages === 'function') {
          const imgs = await this.deps.bridge.aiExtractPdfImages(a.path!);
          for (const img of imgs) {
            if (img.dataBase64) {
              out.push({
                input: { mimeType: img.mime || 'image/png', dataBase64: img.dataBase64 },
                label: `PDF '${a.name}' 내장 이미지`,
              });
            }
          }
        }
      } catch {
        /* 렌더/추출 실패한 PDF는 건너뛴다 */
      }
    }
    return out;
  }

  /**
   * crop이 지정된 이미지 편집을 미리 처리한다. 지정 영역(0~1 비율)을 잘라 새 이미지를
   * pendingInsertImages에 추가하고, 편집의 image_index를 그 새 인덱스로 바꾸고 crop을 지운다.
   * 이후 applyActionScript는 잘린 이미지를 통째로 삽입한다.
   */
  private async applyImageCrops(script: ActionScript): Promise<void> {
    for (const edit of script.edits) {
      const p = edit.payload;
      if (p.type !== 'image' || !p.crop || typeof p.image_index !== 'number') continue;
      const src = this.pendingInsertImages[p.image_index];
      if (!src) continue;
      const cropped = await cropImageForInsert(src, p.crop);
      if (cropped) {
        this.pendingInsertImages.push(cropped);
        p.image_index = this.pendingInsertImages.length - 1;
      }
      delete p.crop;
    }
  }

  /** 프롬프트의 이미지 URL을 Rust로 다운로드(CORS 우회)해 라벨과 함께 반환한다. */
  private async fetchPromptImageUrls(prompt: string): Promise<{ input: AiImageInput; label: string }[]> {
    if (typeof this.deps.bridge.aiFetchImage !== 'function') return [];
    const urls = Array.from(new Set(prompt.match(URL_PATTERN) ?? []));
    const out: { input: AiImageInput; label: string }[] = [];
    for (const url of urls) {
      try {
        const { dataBase64, mime } = await this.deps.bridge.aiFetchImage(url);
        if (dataBase64) {
          out.push({ input: { mimeType: mime || 'image/png', dataBase64 }, label: `URL 이미지: ${url}` });
        }
      } catch {
        /* 이미지가 아니거나 다운로드 실패한 URL은 건너뛴다 */
      }
    }
    return out;
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
    this.resolveProofread(null);
    this.setActiveStatus('취소했습니다.');
  }

  private onDelta(delta: AiStreamDelta): void {
    if (delta.requestId !== this.requestId || !this.active) return;
    // 부분 응답은 Raw Action Script JSON이라 그대로 보여주면 혼란스럽다.
    // 사람이 읽을 결과는 diff/인라인 카드로 보여주므로, 생성 중에는 점 애니메이션만
    // 유지한다(이미 표시 중이면 그대로 둔다).
    if (!this.active.streamEl.querySelector('.hop-ai-thinking')) this.showThinking(this.active);
  }

  private async onReady(ready: AiEditReady): Promise<void> {
    if (ready.requestId !== this.requestId || !this.active) return;
    // 같은 요청의 ready 이벤트가 두 번 와도 한 번만 처리(이중 적용 방지).
    this.requestId = null;
    // 교정 패스는 구간 루프가 끝날 때까지 요청 중 상태(취소 버튼)를 유지한다.
    if (this.requestMode !== 'proofread') this.setRequesting(false);
    this.active.streamEl.textContent = '';
    const script = parseActionScript(ready.actionScriptJson);
    if (!script) {
      this.log(`응답 파싱 실패. 원문 일부: ${ready.actionScriptJson.slice(0, 300)}`);
      this.session.onFailed();
      this.setActiveStatus(interpretAiFailure('PARSE_ERROR'), 'error');
      this.resolveProofread(null);
      return;
    }
    // 교정 패스: 적용하지 않고 응답을 루프(runProofread)에 넘긴다.
    if (this.requestMode === 'proofread') {
      this.session.complete();
      this.resolveProofread(script);
      return;
    }
    // 동일한 편집(명령+대상+payload)이 중복되면 한 번만 적용한다(AI가 같은 작업을 두 번
    // 내보내는 경우 방지).
    const seenEdits = new Set<string>();
    const before = script.edits.length;
    script.edits = script.edits.filter((e) => {
      const key = `${e.command}|${e.target_id}|${JSON.stringify(e.payload)}`;
      if (seenEdits.has(key)) return false;
      seenEdits.add(key);
      return true;
    });
    if (script.edits.length < before) {
      this.log(`중복 편집 ${before - script.edits.length}건 제거`);
    }
    this.log(
      `응답: 편집 ${script.edits.length}건. ${script.edits
        .map((e) => `${e.command} ${e.target_id} [${e.payload.type ?? 'paragraph'}${e.payload.image_index !== undefined ? ` idx=${e.payload.image_index}` : ''}${e.payload.crop ? ' crop' : ''}]`)
        .join(' / ')}`,
    );
    // 질문/요약 모드이거나 편집이 없으면, 문서를 건드리지 않고 답변만 표시한다(Copilot의 'Ask').
    if (this.requestMode === 'ask' || script.edits.length === 0) {
      this.session.complete();
      const answer =
        script.message?.trim() ||
        (this.requestMode === 'ask' ? '(응답이 비어 있습니다.)' : '바꿀 내용이 없습니다.');
      if (this.active) this.active.msgEl.textContent = answer;
      this.recordMessage('assistant', answer);
      this.log(`답변 모드: 편집 없음(message ${script.message ? '있음' : '없음'})`);
      this.setActiveStatus(this.requestMode === 'ask' ? '답변 완료' : '변경 사항이 없습니다.', 'ok');
      return;
    }
    if (!this.session.onReady()) return;
    // 이미지 crop 지정(PDF 페이지에서 그림만 잘라내기)을 미리 처리: 잘린 이미지를
    // pendingInsertImages에 추가하고 해당 편집의 image_index를 그쪽으로 바꾼다.
    // crop이 없는 일반 편집은 동기 경로를 유지한다.
    if (script.edits.some((e) => e.payload.type === 'image' && e.payload.crop)) {
      await this.applyImageCrops(script);
    }
    this.pendingScript = script;
    this.rejectedEdits = new Set();
    if (this.active && script.message) this.active.msgEl.textContent = script.message;
    this.recordMessage('assistant', script.message?.trim() || `편집 ${script.edits.length}건을 제안했습니다.`);
    this.renderDiff(script);

    // 스냅샷 가능(데스크톱)하면 승인 전 "미리 적용"해 문서에 바로 반영하고, 거절 시
    // 스냅샷으로 되돌린다(Cursor/변경내용추적 방식). 불가하면 가상 미리보기로 폴백.
    if (this.snapshotDocument()) {
      const result = applyActionScript(this.deps.bridge, script, this.pendingInsertImages);
      this.log(
        `적용(미리): ${result.applied}건${result.skipped.map((s) => `\n  건너뜀 ${s.targetId}: ${s.reason}`).join('')}`,
      );
      this.reflowAndRender();
      this.applied = result;
      // 페이지 위 인라인 표시(변경 위치 좌표를 잡을 수 있을 때만 뜬다 — 표 삽입 등은
      // 좌표가 없어 안 뜰 수 있다). 인라인 바 유무와 무관하게 버블 내 승인/거절은
      // 항상 노출해 사용자가 승인/거절 수단을 잃지 않도록 한다.
      this.renderDecisionBar(script, result.changed);
      this.setPreviewEnabled(true);
      this.renderVariations(script);
      const note = this.skipNote(result);
      const tone = result.applied === 0 && result.skipped.length ? 'warn' : 'info';
      this.setActiveStatus(`미리 적용 ${result.applied}건${note} — 승인 또는 거절하세요.`, tone);
    } else {
      this.renderInlineDiff(script);
      this.setPreviewEnabled(true);
      this.setActiveStatus(`제안 ${script.edits.length}건 — 승인 또는 거부하세요.`);
    }
  }

  private onFailed(failed: AiEditFailed): void {
    if (failed.requestId !== this.requestId || !this.active) return;
    this.session.onFailed();
    this.setRequesting(false);
    this.active.streamEl.textContent = '';
    this.setActiveStatus(`${interpretAiFailure(failed.code)} (${failed.reason})`, 'error');
    this.resolveProofread(null);
  }

  /** 교정 루프가 기다리는 구간 응답을 풀어준다(완료/실패/취소 공통). */
  private resolveProofread(script: ActionScript | null): void {
    const resolve = this.proofreadResolve;
    this.proofreadResolve = null;
    resolve?.(script);
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
      const note = result ? this.skipNote(result) : '';
      const count = result?.applied ?? 0;
      const tone = count === 0 ? 'warn' : 'ok';
      this.setActiveStatus(`적용 완료: ${count}건${note}`, tone, active);
      return;
    }

    // 폴백(가상 미리보기) 경로 — 승인 시점에 적용(개별 거절된 edit은 제외).
    if (!this.pendingScript || !this.session.accept()) return;
    const result = applyActionScript(
      this.deps.bridge,
      this.filteredScript(this.pendingScript),
      this.pendingInsertImages,
    );
    this.clearPreview();
    if (result.applied === 0) {
      const reason = result.skipped[0]?.reason ?? '적용할 수 있는 편집이 없습니다.';
      this.setActiveStatus(`적용된 편집이 없습니다 — ${reason}`, 'warn', active);
      return;
    }
    this.reflowAndRender();
    this.deps.bridge.markDocumentDirty?.();
    this.setActiveStatus(`적용 완료: ${result.applied}건${this.skipNote(result)}`, 'ok', active);
  }

  private reject(): void {
    const active = this.active;
    if (!this.session.reject()) return; // rollback 콜백이 스냅샷 복원/미리보기 정리를 한다.
    this.setActiveStatus('제안을 거절하여 되돌렸습니다.', 'info', active);
  }

  // ── 문서 전체 교정 패스 (F-55a6a4) ───────────────────────────

  /**
   * 문서 전체(본문+표 셀)를 구간으로 나눠 순차 스캔하고, 발견한 이슈를 적용하지 않은 채
   * 목록으로 보여준다(Word Editor식). 항목 클릭=위치 점프, '수정 적용'=그 문단만 REPLACE.
   */
  private async runProofread(): Promise<void> {
    if (this.session.state === 'REQUESTING') return; // 이미 요청 진행 중.
    const guard = this.checkSendGuards();
    if (!guard) return;
    const { docId, provider, baseUrl } = guard;
    // 미확정 편집이 있으면 정리하고 시작한다.
    if (this.session.isPending) this.session.cancel();

    this.requestMode = 'proofread';
    this.appendUserTurn('문서 전체 교정', []);
    this.recordMessage('user', '문서 전체 교정');
    this.active = this.appendAssistantTurn();
    this.setRequesting(true);
    const model = this.currentModel();
    try {
      const context = await this.deps.bridge.aiGetDocumentContext(docId, false, null, true);
      this.context = context;
      const chunks = chunkContextNodes(context.content, PROOFREAD_CHUNK_CHARS);
      if (!chunks.length) {
        this.setActiveStatus('교정할 텍스트가 없습니다.', 'warn');
        return;
      }
      this.log(`교정 시작: ${context.content.length}개 노드 → ${chunks.length}개 구간`);
      let found = 0;
      for (let i = 0; i < chunks.length; i += 1) {
        this.setActiveStatus(
          chunks.length > 1 ? `문서 스캔 중… (구간 ${i + 1}/${chunks.length})` : '문서 스캔 중…',
        );
        const ids = chunks[i].map((node) => node.id);
        const script = await this.requestProofreadChunk(docId, provider, model, baseUrl, ids);
        if (!script) return; // 실패/취소 — 상태 표시는 onFailed/cancel이 했다.
        found += this.collectIssues(script, new Set(ids));
        this.log(`교정 구간 ${i + 1}/${chunks.length} 완료 — 누적 이슈 ${found}건`);
      }
      const summary = found
        ? `교정 스캔 완료 — 이슈 ${found}건을 찾았습니다. 항목을 클릭하면 해당 위치로 이동하고, '수정 적용'을 누르면 그 문단만 반영됩니다.`
        : '교정 스캔 완료 — 발견된 이슈가 없습니다.';
      if (this.active) this.active.msgEl.textContent = summary;
      this.recordMessage('assistant', summary);
      this.setActiveStatus(found ? `이슈 ${found}건` : '이슈 없음', 'ok');
    } catch (error) {
      this.setActiveStatus(`교정 실패: ${String(error)}`, 'error');
    } finally {
      this.setRequesting(false);
    }
  }

  /** 한 구간(ids)에 대한 교정 요청을 보내고 응답(또는 실패 시 null)을 기다린다. */
  private requestProofreadChunk(
    docId: string,
    provider: string,
    model: string,
    baseUrl: string | null,
    ids: string[],
  ): Promise<ActionScript | null> {
    return new Promise((resolve) => {
      this.proofreadResolve = resolve;
      this.session.startRequest();
      this.deps.bridge
        .aiRequestEdit(docId, PROOFREAD_PROMPT, provider, model, null, baseUrl, null, null, null, ids)
        .then((requestId) => {
          this.requestId = requestId;
        })
        .catch((error) => {
          this.session.onFailed();
          this.setActiveStatus(`요청 실패: ${String(error)}`, 'error');
          this.resolveProofread(null);
        });
    });
  }

  /** 응답에서 교정 이슈(구간 내 REPLACE)만 골라 목록에 추가한다. 반환: 추가한 개수. */
  private collectIssues(script: ActionScript, allowed: Set<string>): number {
    let count = 0;
    for (const edit of script.edits) {
      if (edit.command !== 'REPLACE' || !(edit.payload.text ?? '').trim()) continue;
      if (!allowed.has(edit.target_id)) continue;
      this.appendIssueRow(edit);
      count += 1;
    }
    return count;
  }

  /** 이슈 한 건을 버블의 목록에 그린다(분류·before/after·적용/무시, 클릭=점프). */
  private appendIssueRow(edit: Edit): void {
    const turn = this.active;
    if (!turn) return;
    const beforeMap = new Map<string, string>();
    for (const node of this.context?.content ?? []) beforeMap.set(node.id, node.text);

    const row = el('div', 'hop-ai-issue');
    row.addEventListener('click', () => this.jumpToTarget(edit.target_id));
    const reason = el('div', 'hop-ai-issue-reason');
    reason.textContent = edit.payload.reason || '교정 제안';
    row.appendChild(reason);
    const before = el('div', 'hop-ai-diff-before');
    before.textContent = clip(beforeMap.get(edit.target_id) ?? '', 90);
    row.appendChild(before);
    const after = el('div', 'hop-ai-diff-after');
    after.textContent = clip(edit.payload.text ?? '', 90);
    row.appendChild(after);

    const actions = el('div', 'hop-ai-issue-actions');
    const applyBtn = btn('hop-ai-issue-apply', '수정 적용');
    applyBtn.addEventListener('click', (event) => {
      (event as Event).stopPropagation?.();
      this.applyIssue(edit, row, applyBtn);
    });
    const ignoreBtn = btn('hop-ai-issue-ignore', '무시');
    ignoreBtn.addEventListener('click', (event) => {
      (event as Event).stopPropagation?.();
      row.classList.add('hop-ai-issue-resolved');
      applyBtn.disabled = true;
      ignoreBtn.disabled = true;
    });
    actions.append(applyBtn, ignoreBtn);
    row.appendChild(actions);
    turn.bodyEl.appendChild(row);
    this.scrollThreadToEnd();
  }

  /** 이슈 하나를 적용한다 — 해당 문단만 REPLACE(다른 이슈의 인덱스는 변하지 않는다). */
  private applyIssue(edit: Edit, row: HTMLElement, applyBtn: HTMLButtonElement): void {
    if (row.classList.contains('hop-ai-issue-resolved')) return;
    const result = applyActionScript(this.deps.bridge, { edits: [edit] }, []);
    if (result.applied === 0) {
      this.setActiveStatus(
        `적용하지 못했습니다: ${result.skipped[0]?.reason ?? '알 수 없는 이유'}`,
        'warn',
      );
      return;
    }
    this.reflowAndRender();
    this.deps.bridge.markDocumentDirty?.();
    row.classList.add('hop-ai-issue-resolved');
    applyBtn.textContent = '✓ 적용됨';
    applyBtn.disabled = true;
    this.setActiveStatus('교정 1건을 적용했습니다.', 'ok');
  }

  /** 대상 문단/셀 위치로 스크롤하고 잠깐 하이라이트한다(이슈 점프). */
  private jumpToTarget(targetId: string): void {
    const canvasView = this.deps.getCanvasView();
    const rect = this.targetRect(targetId);
    if (!canvasView || !rect) return;
    const zoom = canvasView.getViewportManager().getZoom();
    const page = this.deps.bridge.getPageInfo(rect.pageIndex);
    const pageTop = canvasView.getVirtualScroll().getPageOffset(rect.pageIndex);
    const pageWidth = page.width * zoom;
    const pageLeft = Math.max(0, (this.deps.scrollContent.clientWidth - pageWidth) / 2);
    const top = pageTop + rect.y * zoom;
    this.deps.scrollContainer.scrollTo({ top: Math.max(0, top - 80), behavior: 'smooth' });
    const flash = el('div', 'hop-ai-proofread-flash');
    flash.style.position = 'absolute';
    flash.style.left = `${pageLeft}px`;
    flash.style.top = `${top - 2}px`;
    flash.style.width = `${Math.max(80, pageWidth)}px`;
    flash.style.height = `${Math.max(14, rect.height * zoom + 4)}px`;
    flash.style.pointerEvents = 'none';
    this.deps.scrollContent.appendChild(flash);
    setTimeout(() => flash.remove(), 1600);
  }

  // ── 대화 버블 ────────────────────────────────────────────────

  private appendUserTurn(text: string, attachments: Attachment[]): void {
    // 첫 메시지면 컴포저를 하단으로 내리고 탭 제목을 갱신한다.
    this.markActiveHasMessages(text);
    const bubble = el('div', 'hop-ai-msg hop-ai-msg-user');
    const body = el('div', 'hop-ai-msg-text');
    body.textContent = text;
    bubble.appendChild(body);
    // 지난 메시지를 다시 다듬어 보낼 수 있게 '수정' 버튼 — 클릭하면 컴포저로 불러온다.
    const editBtn = el('button', 'hop-ai-msg-edit') as HTMLButtonElement;
    editBtn.type = 'button';
    editBtn.textContent = '✎ 수정';
    editBtn.title = '이 메시지를 입력창으로 불러와 수정 후 다시 보냅니다';
    editBtn.addEventListener('click', () => {
      this.promptInput.value = text;
      this.promptInput.focus();
      try {
        this.promptInput.setSelectionRange(text.length, text.length);
      } catch {
        /* 일부 환경은 setSelectionRange 미지원 */
      }
    });
    bubble.appendChild(editBtn);
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
    const msgEl = el('div', 'hop-ai-msg-text');
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
    bubble.append(streamEl, msgEl, bodyEl, decision, statusEl);
    this.thread.appendChild(bubble);
    this.scrollThreadToEnd();
    const turn: ActiveTurn = { streamEl, msgEl, bodyEl, decisionEl: decision, acceptBtn, rejectBtn, statusEl };
    this.setPreviewEnabledFor(turn, false);
    this.showThinking(turn);
    return turn;
  }

  /** 정적 "작성 중…" 텍스트 대신 Claude식 점 3개 로딩 애니메이션을 표시한다. */
  private showThinking(turn: ActiveTurn): void {
    const dots = el('span', 'hop-ai-thinking');
    dots.setAttribute('role', 'status');
    dots.setAttribute('aria-label', 'AI가 생각 중입니다');
    for (let i = 0; i < 3; i += 1) dots.appendChild(el('span', 'hop-ai-thinking-dot'));
    turn.streamEl.replaceChildren(dots);
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
    if (/\.(pdf|hwp|hwpx|docx)$/i.test(file.name) || file.type === 'application/pdf') {
      // 네이티브 텍스트 추출은 파일 경로가 필요하다 — 파일 선택엔 경로가 없다.
      this.setStatus('PDF/HWP/HWPX/DOCX는 드래그&드롭으로 첨부하세요.', 'warn');
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
      label.textContent = a.loading
        ? `⏳ ${a.name} (분석 중)`
        : `${attachmentIcon(a.kind)} ${a.name}`;
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
      return;
    }
    // Cmd/Ctrl+A → 글상자 전체 선택. 커스텀 네이티브 메뉴에 Select All 항목이 없어
    // 웹뷰 기본 동작이 불안정하므로 직접 처리한다(macOS·Windows 공통, 한글 IME의 'ㅁ' 포함).
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      (event.key === 'a' || event.key === 'A' || event.key === 'ㅁ')
    ) {
      event.preventDefault();
      this.promptInput.select();
    }
  }

  private toggleSettings(open?: boolean): void {
    const show = open ?? this.settingsModal.classList.contains('hop-ai-hidden');
    this.settingsModal.classList.toggle('hop-ai-hidden', !show);
  }

  /** "⋯" 메뉴 — 최근 대화 리스트 + Agent 설정. */
  private toggleMenu(open?: boolean): void {
    const show = open ?? this.menu.classList.contains('hop-ai-hidden');
    if (show) this.renderMenu();
    this.menu.classList.toggle('hop-ai-hidden', !show);
  }

  private renderMenu(): void {
    this.menu.replaceChildren();
    const head = el('div', 'hop-ai-menu-head');
    head.textContent = '최근 대화';
    this.menu.appendChild(head);
    // 최신 대화가 위로 오도록 역순.
    for (const conv of [...this.conversations].reverse()) {
      const item = el('button', 'hop-ai-menu-item') as HTMLButtonElement;
      item.textContent = conv.tab.textContent || '새 대화';
      if (conv === this.activeConv) item.classList.add('hop-ai-menu-item-active');
      item.addEventListener('click', () => {
        this.switchConversation(conv.id);
        this.toggleMenu(false);
      });
      this.menu.appendChild(item);
    }
    const divider = el('div', 'hop-ai-menu-divider');
    this.menu.appendChild(divider);
    const logItem = el('button', 'hop-ai-menu-item') as HTMLButtonElement;
    logItem.textContent = '🛈 로그 보기';
    logItem.addEventListener('click', () => {
      this.toggleMenu(false);
      this.openLogWindow();
    });
    this.menu.appendChild(logItem);
    const skillItem = el('button', 'hop-ai-menu-item') as HTMLButtonElement;
    skillItem.textContent = '✍ 스킬 폴더 열기';
    skillItem.addEventListener('click', () => {
      this.toggleMenu(false);
      void this.deps.bridge.aiOpenSkillsDir?.().then(() => this.loadSkills());
    });
    this.menu.appendChild(skillItem);
    const settings = el('button', 'hop-ai-menu-item') as HTMLButtonElement;
    settings.textContent = '⚙ Agent 설정';
    settings.addEventListener('click', () => {
      this.toggleMenu(false);
      this.toggleSettings(true);
    });
    this.menu.appendChild(settings);
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
    this.diffRows = [];
    const items = buildDiffModel(
      script,
      this.context ?? { document_metadata: { total_sections: 0 }, content: [] },
    );
    // 변경 블록이 2건 이상이면 행마다 개별 포함(✓)/제외(✗) 토글을 단다(1건은 전체
    // 승인/거부 버튼과 중복이라 생략). 인덱스는 pendingScript.edits와 1:1이다.
    const perEdit = script.edits.length >= 2;
    items.forEach((item, index) => {
      const row = renderDiffItem(item);
      if (perEdit) row.appendChild(this.buildEditControls(index));
      row.classList.toggle('hop-ai-diff-item-rejected', this.rejectedEdits.has(index));
      this.diffRows.push(row);
      this.active!.bodyEl.appendChild(row);
    });
  }

  /** diff 행의 개별 포함(✓)/제외(✗) 컨트롤. */
  private buildEditControls(index: number): HTMLElement {
    const wrap = el('div', 'hop-ai-diff-controls');
    const keep = el('button', 'hop-ai-diff-keep') as HTMLButtonElement;
    keep.textContent = '✓';
    keep.title = '이 편집 포함';
    keep.addEventListener('click', () => this.setEditRejected(index, false));
    const drop = el('button', 'hop-ai-diff-drop') as HTMLButtonElement;
    drop.textContent = '✗';
    drop.title = '이 편집만 제외';
    drop.addEventListener('click', () => this.setEditRejected(index, true));
    wrap.append(keep, drop);
    return wrap;
  }

  /** rejectedEdits를 제외한 적용 대상 스크립트(제외가 없으면 원본 그대로). */
  private filteredScript(script: ActionScript): ActionScript {
    if (!this.rejectedEdits.size) return script;
    return { ...script, edits: script.edits.filter((_, i) => !this.rejectedEdits.has(i)) };
  }

  /**
   * edit 하나를 적용 대상에서 제외/복원한다. 낙관적 적용 경로에선 스냅샷으로 되돌린 뒤
   * 남은 edit만 다시 적용해, 나머지 미리보기·하이라이트를 그대로 유지한다(AC-491094).
   */
  private setEditRejected(index: number, rejected: boolean): void {
    const script = this.pendingScript;
    if (!script || !this.session.isPending) return;
    if (this.rejectedEdits.has(index) === rejected) return;
    if (rejected) this.rejectedEdits.add(index);
    else this.rejectedEdits.delete(index);
    this.diffRows[index]?.classList.toggle('hop-ai-diff-item-rejected', rejected);

    const filtered = this.filteredScript(script);
    if (this.snapshot) {
      try {
        this.reloadSnapshot();
        clearInlineDiff(this.deps.scrollContent);
        const result = applyActionScript(this.deps.bridge, filtered, this.pendingInsertImages);
        this.reflowAndRender();
        this.applied = result;
        this.renderDecisionBar(filtered, result.changed);
      } catch (error) {
        // 재적용 도중 오류 — 부분 적용 상태로 남기지 않고 전체 롤백한다(AC-95b4b0).
        this.session.cancel();
        this.setActiveStatus(`적용 중 오류가 나 전체를 되돌렸습니다: ${String(error)}`, 'error');
        return;
      }
    } else {
      clearInlineDiff(this.deps.scrollContent);
      this.renderInlineDiff(filtered);
    }
    const total = script.edits.length;
    const remain = total - this.rejectedEdits.size;
    this.log(`편집 ${index + 1} ${rejected ? '제외' : '복원'} → ${remain}/${total}건 적용 예정`);
    this.setActiveStatus(
      remain === 0
        ? '모든 편집이 제외되었습니다 — 승인해도 적용되지 않습니다.'
        : `${remain}/${total}건 적용 예정 — 승인 또는 거절하세요.`,
      remain === 0 ? 'warn' : 'info',
    );
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

  /**
   * AI가 변형(variations)을 제시했으면 버블에 대안 버튼들을 그린다. 버튼을 누르면
   * 스냅샷으로 되돌린 뒤 그 대안으로 다시 적용한다(승인 전까지 자유롭게 전환).
   */
  private renderVariations(script: ActionScript): void {
    const turn = this.active;
    if (!turn) return;
    const edit = script.edits.find((e) => (e.payload.variations?.length ?? 0) >= 2);
    if (!edit?.payload.variations) return;
    const variations = edit.payload.variations;
    const container = el('div', 'hop-ai-variations');
    const label = el('div', 'hop-ai-variations-label');
    label.textContent = `대안 ${variations.length}개 — 눌러서 적용:`;
    container.appendChild(label);
    const btns: HTMLButtonElement[] = [];
    variations.forEach((text, i) => {
      const b = el('button', 'hop-ai-variation') as HTMLButtonElement;
      const preview = text.length > 70 ? `${text.slice(0, 70)}…` : text;
      b.textContent = `${i + 1}. ${preview}`;
      if (text === edit.payload.text) b.classList.add('hop-ai-variation-active');
      b.addEventListener('click', () => this.pickVariation(i));
      btns.push(b);
      container.appendChild(b);
    });
    this.variationState = { edit, btns, container };
    turn.decisionEl.before(container);
  }

  /** 변형 대안 선택 → 스냅샷 시점으로 되돌린 뒤 그 텍스트로 재적용. */
  private pickVariation(index: number): void {
    const state = this.variationState;
    const script = this.pendingScript;
    if (!state || !script || !this.snapshot) return;
    const text = state.edit.payload.variations?.[index];
    if (text === undefined) return;
    this.reloadSnapshot();
    state.edit.payload.text = text;
    clearInlineDiff(this.deps.scrollContent);
    const filtered = this.filteredScript(script);
    const result = applyActionScript(this.deps.bridge, filtered, this.pendingInsertImages);
    this.reflowAndRender();
    this.applied = result;
    this.renderDiff(script);
    this.renderDecisionBar(filtered, result.changed);
    state.btns.forEach((b, i) => b.classList.toggle('hop-ai-variation-active', i === index));
    this.setActiveStatus(`대안 ${index + 1} 적용 — 승인 또는 거절하세요.`, 'info');
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

  /** 스냅샷 바이트를 다시 로드한다(스냅샷·미리보기는 유지 — 변형 전환용). */
  private reloadSnapshot(): void {
    const b = this.deps.bridge;
    if (this.snapshot && b.loadDocument) {
      try {
        b.loadDocument(this.snapshot.bytes, this.snapshot.fileName);
        this.reflowAndRender();
      } catch {
        /* 복원 실패는 무시 */
      }
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
    this.rejectedEdits = new Set();
    this.diffRows = [];
    clearInlineDiff(this.deps.scrollContent);
    // 변형 대안 버튼 정리.
    this.variationState?.container.remove();
    this.variationState = null;
    if (this.active) {
      this.active.bodyEl.replaceChildren();
      this.setPreviewEnabledFor(this.active, false);
    }
  }

  private setPreviewEnabled(enabled: boolean): void {
    if (this.active) this.setPreviewEnabledFor(this.active, enabled);
  }

  private setPreviewEnabledFor(turn: ActiveTurn, enabled: boolean): void {
    // 제안이 대기 중이면(enabled=true) 버블 내 승인/거절을 항상 노출한다 —
    // 페이지 위 인라인 바는 보조 표시일 뿐, 좌표를 못 잡으면 안 뜰 수 있으므로
    // 버블 버튼을 유일하게 신뢰할 수 있는 승인/거절 수단으로 둔다.
    turn.decisionEl.classList.toggle('hop-ai-hidden', !enabled);
    turn.acceptBtn.disabled = !enabled;
    turn.rejectBtn.disabled = !enabled;
  }

  private setRequesting(active: boolean): void {
    this.sendBtn.disabled = active;
    this.cancelBtn.classList.toggle('hop-ai-hidden', !active);
  }

  /** 디버그 로그 한 줄 추가(시간 + 메시지). 최근 300줄만 유지. 콘솔에도 남긴다. */
  private log(msg: string): void {
    const time = new Date().toLocaleTimeString();
    this.logs.push(`[${time}] ${msg}`);
    if (this.logs.length > 300) this.logs.shift();
    // eslint-disable-next-line no-console
    console.log('[hop-ai]', msg);
    // 별도 로그 창이 열려 있으면 실시간 반영, 폴백 인라인 패널이 켜져 있으면 그쪽도 갱신.
    if (this.logWindow && !this.logWindow.closed) this.writeLogWindow();
    if (!this.logPanel.classList.contains('hop-ai-hidden')) this.renderLog();
  }

  /**
   * 로그를 별도 창으로 연다(설정 메뉴 → '로그 보기'). 새 창을 못 열면(웹뷰가 차단)
   * 인라인 패널로 폴백한다.
   */
  private openLogWindow(): void {
    if (this.logWindow && !this.logWindow.closed) {
      this.logWindow.focus();
      this.writeLogWindow();
      return;
    }
    const win = window.open('', 'hop-ai-log', 'width=680,height=520');
    if (!win) {
      // 새 창 차단 시 인라인 패널 폴백.
      this.logPanel.classList.remove('hop-ai-hidden');
      this.renderLog();
      return;
    }
    this.logWindow = win;
    this.writeLogWindow();
  }

  /** 별도 로그 창의 내용을 현재 버퍼로 다시 그린다. */
  private writeLogWindow(): void {
    const win = this.logWindow;
    if (!win || win.closed) return;
    const text = this.logs.join('\n') || '(로그 없음)';
    const doc = win.document;
    doc.open();
    doc.write(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><title>HOP AI 로그</title>` +
        `<style>body{margin:0;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;` +
        `background:#1e1e1e;color:#d4d4d4}` +
        `header{position:sticky;top:0;display:flex;gap:8px;align-items:center;` +
        `padding:8px 12px;background:#252526;border-bottom:1px solid #333}` +
        `button{font:inherit;cursor:pointer;background:#333;color:#d4d4d4;` +
        `border:1px solid #555;border-radius:4px;padding:3px 10px}` +
        `pre{margin:0;padding:12px;white-space:pre-wrap;word-break:break-all}</style></head>` +
        `<body><header><b>HOP AI 디버그 로그</b><button id="c">지우기</button>` +
        `<button id="r">새로고침</button></header><pre id="t"></pre></body></html>`,
    );
    doc.close();
    const pre = doc.getElementById('t');
    if (pre) {
      pre.textContent = text;
      win.scrollTo(0, doc.body.scrollHeight);
    }
    doc.getElementById('c')?.addEventListener('click', () => {
      this.logs = [];
      this.writeLogWindow();
    });
    doc.getElementById('r')?.addEventListener('click', () => this.writeLogWindow());
  }

  private renderLog(): void {
    this.logPanel.replaceChildren();
    const pre = el('pre', 'hop-ai-log-text');
    pre.textContent = this.logs.join('\n') || '(로그 없음)';
    const clearBtn = el('button', 'hop-ai-log-clear') as HTMLButtonElement;
    clearBtn.textContent = '로그 지우기';
    clearBtn.addEventListener('click', () => {
      this.logs = [];
      this.renderLog();
    });
    this.logPanel.append(clearBtn, pre);
    pre.scrollTop = pre.scrollHeight;
  }

  /** 건너뜀 건수 + 첫 사유를 사람이 읽을 수 있게 만든다(빈 문자열이면 건너뜀 없음). */
  private skipNote(result: ApplyResult): string {
    if (!result.skipped.length) return '';
    return ` · 건너뜀 ${result.skipped.length}건: ${result.skipped[0].reason}`;
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

/** 교정 패스 한 구간의 최대 글자 수 — 프로바이더 컨텍스트 한도를 넘지 않게 나눈다(AC4). */
const PROOFREAD_CHUNK_CHARS = 9000;

/** 교정 패스 구간 요청 프롬프트 — REPLACE만, reason 필수, 의미 변경 금지. */
const PROOFREAD_PROMPT =
  '당신에게 보이는 문단들(이 구간)을 전수 검사해 맞춤법·문법 오류, 어색한 문장, ' +
  '용어·표기 일관성 문제를 찾으세요. 문제가 있는 문단마다 REPLACE edit 하나를 만들고, ' +
  'payload.text에 교정한 전체 문단 텍스트를, payload.reason에 "분류: 무엇을 왜 고쳤는지"를 ' +
  '한국어 한 문장으로 적으세요(분류는 맞춤법/문법/어색한 표현/일관성 중 하나). ' +
  'INSERT나 DELETE는 쓰지 말고, 문제 없는 문단은 절대 건드리지 마세요. ' +
  '내용과 의미는 바꾸지 말고 표현만 교정하세요. 문제가 없으면 edits를 빈 배열로 두세요.';

/**
 * 컨텍스트 노드를 글자 수 기준 구간으로 나눈다(빈 문단 제외). 한 노드가 한도보다
 * 길어도 쪼개지 않고 단독 구간으로 보낸다(문단 중간을 자르면 교정 품질이 떨어진다).
 */
function chunkContextNodes(nodes: ContentNode[], maxChars: number): ContentNode[][] {
  const chunks: ContentNode[][] = [];
  let current: ContentNode[] = [];
  let size = 0;
  for (const node of nodes) {
    if (!node.text.trim()) continue;
    if (current.length && size + node.text.length > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(node);
    size += node.text.length;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** 표시용 — 앞 `max`자만, 길면 말줄임표. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
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
  historyBtn: HTMLButtonElement;
  historyPanel: HTMLElement;
  settingsBtn: HTMLButtonElement;
  logPanel: HTMLElement;
  menu: HTMLElement;
  settingsModal: HTMLElement;
  settingsClose: HTMLButtonElement;
  tabBar: HTMLElement;
  threadsWrap: HTMLElement;
  promptInput: HTMLTextAreaElement;
  modeEditBtn: HTMLButtonElement;
  modeAskBtn: HTMLButtonElement;
  quickActions: HTMLElement;
  skillSelect: HTMLSelectElement;
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

  // 헤더: 제목 + 새 대화(+) + 설정(⚙) + 닫기(×)
  const header = el('div', 'hop-ai-header');
  const title = el('span', 'hop-ai-title');
  title.textContent = 'AI 편집';
  const newChatBtn = el('button', 'hop-ai-newchat') as HTMLButtonElement;
  newChatBtn.textContent = '＋';
  newChatBtn.title = '새 대화';
  const historyBtn = el('button', 'hop-ai-history-btn') as HTMLButtonElement;
  historyBtn.textContent = '🕘';
  historyBtn.title = '과거 대화 기록';
  const settingsBtn = el('button', 'hop-ai-settings-btn') as HTMLButtonElement;
  settingsBtn.textContent = '⋯';
  settingsBtn.title = '메뉴 (최근 대화 · 로그 · Agent 설정)';
  const closeBtn = el('button', 'hop-ai-close') as HTMLButtonElement;
  closeBtn.textContent = '×';
  header.append(title, newChatBtn, historyBtn, settingsBtn, closeBtn);

  // 과거 대화 기록 패널(영속 저장된 대화 목록). AI 패널 왼쪽에 드로어로 뜬다. 기본 숨김.
  const historyPanel = el('div', 'hop-ai-history');
  historyPanel.classList.add('hop-ai-hidden');

  // 디버그 로그 패널(기본 숨김) — 새 창을 못 열 때의 폴백 표시용. 메뉴의 '로그 보기'로 토글.
  const logPanel = el('div', 'hop-ai-log');
  logPanel.classList.add('hop-ai-hidden');

  // "⋯" 드롭다운 메뉴(최근 대화 리스트 + Agent 설정). 기본 숨김.
  const menu = el('div', 'hop-ai-menu');
  menu.classList.add('hop-ai-hidden');

  // 대화 탭 바(여러 대화를 보존하고 전환).
  const tabBar = el('div', 'hop-ai-tabbar');

  // 대화 스레드들을 담는 래퍼(대화마다 thread 하나, 활성만 표시).
  const threadsWrap = el('div', 'hop-ai-threads');

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

  // 설정 모달(별도 창처럼) — 'Agent 설정'에서 열린다. 기본 숨김.
  const settingsModal = el('div', 'hop-ai-modal');
  settingsModal.classList.add('hop-ai-hidden');
  const settingsCard = el('div', 'hop-ai-modal-card');
  const settingsHeader = el('div', 'hop-ai-modal-header');
  const settingsTitle = el('span', 'hop-ai-modal-title');
  settingsTitle.textContent = 'Agent 설정';
  const settingsClose = el('button', 'hop-ai-modal-close') as HTMLButtonElement;
  settingsClose.textContent = '×';
  settingsHeader.append(settingsTitle, settingsClose);
  settingsCard.append(settingsHeader, settingsPanel);
  settingsModal.appendChild(settingsCard);

  // 컴포저(하단 입력)
  const chipsArea = el('div', 'hop-ai-chips');

  // 모드 토글(편집/질문) + 빠른 작업 칩.
  const modeEditBtn = btn('hop-ai-mode-btn hop-ai-mode-active', '편집');
  modeEditBtn.title = '문서를 편집합니다';
  const modeAskBtn = btn('hop-ai-mode-btn', '질문');
  modeAskBtn.title = '편집하지 않고 질문·요약에 답합니다';
  const modeToggle = el('div', 'hop-ai-mode-toggle');
  modeToggle.append(modeEditBtn, modeAskBtn);

  const quickActions = el('div', 'hop-ai-quick');
  const QUICK_ACTIONS: { action: string; label: string }[] = [
    { action: 'concise', label: '간결하게' },
    { action: 'formal', label: '격식있게' },
    { action: 'expand', label: '길게' },
    { action: 'grammar', label: '문법 교정' },
    { action: 'proofread', label: '전체 교정' },
    { action: 'variations', label: '변형 제안' },
    { action: 'summarize', label: '요약' },
  ];
  for (const q of QUICK_ACTIONS) {
    const chip = btn('hop-ai-quick-chip', q.label);
    chip.dataset.action = q.action;
    quickActions.appendChild(chip);
  }
  const quickbar = el('div', 'hop-ai-quickbar');
  // 글쓰기 스킬 선택(자동/없음/<스킬들>). 런타임에 옵션 채움.
  const skillSelect = document.createElement('select');
  skillSelect.className = 'hop-ai-skill-select';
  skillSelect.title = '글쓰기 스킬 — 문서 유형별 작성 지침';
  skillSelect.appendChild(option('auto', '스킬: 자동'));

  quickbar.append(modeToggle, skillSelect, quickActions);

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
  composer.append(chipsArea, quickbar, promptInput, composerBar, statusArea, imageInput, docInput);

  // 컴포저는 본문 영역에 두고, 빈 대화면 상단/대화 시작 시 하단으로 CSS order로 이동.
  const body = el('div', 'hop-ai-body');
  body.append(threadsWrap, composer);
  panel.append(header, menu, logPanel, historyPanel, tabBar, body, settingsModal);

  return {
    panel,
    toggleBtn,
    closeBtn,
    newChatBtn,
    historyBtn,
    historyPanel,
    settingsBtn,
    logPanel,
    menu,
    settingsModal,
    settingsClose,
    tabBar,
    threadsWrap,
    promptInput,
    modeEditBtn,
    modeAskBtn,
    quickActions,
    skillSelect,
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

/**
 * 이미지 입력(base64+MIME, 첨부+URL 순서)을 삽입용 ImageForInsert[]로 디코드한다.
 * AI에 보낸 비전 목록과 1:1로 정렬돼야 image_index가 어긋나지 않으므로 절대 드롭하지 않는다.
 */
async function buildInsertImages(inputs: AiImageInput[]): Promise<ImageForInsert[]> {
  const out: ImageForInsert[] = [];
  for (const input of inputs) {
    out.push(await normalizeForInsert(input.mimeType, input.dataBase64));
  }
  return out;
}

/**
 * HWP가 임베드할 수 있는 포맷(png/jpg)으로 정규화한다. webp·gif·bmp 등은 캔버스로
 * 디코드해 PNG로 재인코딩한다(HWP는 webp를 못 넣어 안 보이는 문제 해결). 원본 픽셀
 * 크기도 함께 잰다.
 */
async function normalizeForInsert(mime: string, base64: string): Promise<ImageForInsert> {
  const ext = extensionFromMime(mime);
  // png/jpg는 그대로(재인코딩으로 인한 용량 증가 방지).
  if (ext === 'png' || ext === 'jpg') {
    const dims = await imageDimensions(mime, base64);
    return {
      bytes: bytesFromBase64(base64),
      extension: ext,
      // 디코드 실패 시에도 드롭하지 않는다(인덱스 정렬 유지). 크기는 기본값으로.
      naturalWidthPx: dims.width || 800,
      naturalHeightPx: dims.height || 600,
    };
  }
  // 그 외(webp/gif/bmp 등) → 캔버스로 PNG 변환. 실패하면 원본 바이트로 폴백(드롭 금지).
  const png = await reencodeToPng(mime, base64);
  if (png) return png;
  return { bytes: bytesFromBase64(base64), extension: ext, naturalWidthPx: 800, naturalHeightPx: 600 };
}

/** 이미지의 지정 영역(0~1 비율)을 잘라 PNG ImageForInsert로 반환한다(캔버스). */
function cropImageForInsert(
  src: ImageForInsert,
  crop: { x: number; y: number; w: number; h: number },
): Promise<ImageForInsert | null> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const mime = src.extension === 'jpg' ? 'image/jpeg' : `image/${src.extension}`;
    const img = new Image();
    img.onload = () => {
      try {
        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        // AI가 보고 정한 crop은 픽셀 단위로 정확하지 않아 그림을 살짝 잘라먹는다.
        // 페이지의 일정 여백(M)만큼 확장한 '작업 창'을 만든 뒤, 그 안에서 비(非)백색
        // 내용 경계로 스냅한다 → 그림이 잘리지 않으면서 배경 여백은 제거된다.
        const M = 0.07;
        const x0 = Math.max(0, crop.x - M);
        const y0 = Math.max(0, crop.y - M);
        const x1 = Math.min(1, crop.x + crop.w + M);
        const y1 = Math.min(1, crop.y + crop.h + M);
        const sx = Math.round(x0 * iw);
        const sy = Math.round(y0 * ih);
        const sw = Math.max(1, Math.min(iw - sx, Math.round((x1 - x0) * iw)));
        const sh = Math.max(1, Math.min(ih - sy, Math.round((y1 - y0) * ih)));
        const work = document.createElement('canvas');
        work.width = sw;
        work.height = sh;
        const wctx = work.getContext('2d', { willReadFrequently: true });
        if (!wctx) {
          resolve(null);
          return;
        }
        wctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

        // 작업 창 안 내용 경계 상자로 스냅(여백 8px). 전부 백색이면 작업 창을 그대로.
        let canvas: HTMLCanvasElement = work;
        const box = contentBoundingBox(wctx, sw, sh);
        if (box) {
          const pad = 8;
          const bx = Math.max(0, box.minX - pad);
          const by = Math.max(0, box.minY - pad);
          const bw = Math.min(sw - bx, box.maxX - box.minX + 1 + pad * 2);
          const bh = Math.min(sh - by, box.maxY - box.minY + 1 + pad * 2);
          const out = document.createElement('canvas');
          out.width = bw;
          out.height = bh;
          const octx = out.getContext('2d');
          if (octx) {
            octx.drawImage(work, bx, by, bw, bh, 0, 0, bw, bh);
            canvas = out;
          }
        }
        const b64 = canvas.toDataURL('image/png').split(',')[1] ?? '';
        resolve({
          bytes: bytesFromBase64(b64),
          extension: 'png',
          naturalWidthPx: canvas.width,
          naturalHeightPx: canvas.height,
        });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = `data:${mime};base64,${base64FromBytes(src.bytes)}`;
  });
}

/**
 * 캔버스에서 비(非)백색 픽셀의 경계 상자를 찾는다. 모두 (거의) 백색이면 null.
 * PDF 페이지 렌더에서 그림 영역을 배경 여백과 분리하는 데 쓴다.
 */
function contentBoundingBox(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const { data } = ctx.getImageData(0, 0, w, h);
  const THRESH = 245; // 한 채널이라도 이 값 미만이면 '내용'(연한 파스텔 박스도 포함).
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    let rowBase = y * w * 4;
    for (let x = 0; x < w; x++, rowBase += 4) {
      if (data[rowBase + 3] < 16) continue; // 투명 픽셀 무시
      if (data[rowBase] < THRESH || data[rowBase + 1] < THRESH || data[rowBase + 2] < THRESH) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/** data URL → 캔버스 → PNG 바이트. 캔버스를 못 쓰는 환경에선 null. */
function reencodeToPng(mime: string, base64: string): Promise<ImageForInsert | null> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(null);
          return;
        }
        ctx.drawImage(img, 0, 0);
        const dataUrl = canvas.toDataURL('image/png');
        const b64 = dataUrl.split(',')[1] ?? '';
        resolve({
          bytes: bytesFromBase64(b64),
          extension: 'png',
          naturalWidthPx: img.naturalWidth,
          naturalHeightPx: img.naturalHeight,
        });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = `data:${mime};base64,${base64}`;
  });
}

/** 프롬프트 텍스트에서 http(s) URL을 찾아 Rust로 다운로드(CORS 우회)해 이미지만 반환한다. */
const URL_PATTERN = /https?:\/\/[^\s)>"']+/g;

/** data URL로 이미지를 로드해 원본 픽셀 크기를 잰다(실패 시 0). */
function imageDimensions(mime: string, base64: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') {
      resolve({ width: 0, height: 0 });
      return;
    }
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = `data:${mime};base64,${base64}`;
  });
}

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** MIME → rhwp insertPicture용 확장자(점 없이). */
function extensionFromMime(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('bmp')) return 'bmp';
  if (mime.includes('webp')) return 'webp';
  return 'png';
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
