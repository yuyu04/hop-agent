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
  parseFormFillResponse,
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
  applyCoverFill,
  buildFormFillEdits,
  buildTocRegenEdits,
  entryRecordToFormFillEntry,
  parseEntrySelection,
  wantsResearchNote,
  parseCellTarget,
  parseParagraphTarget,
  pickCoverHeaderTable,
  pickCoverTable,
  attachmentDocText,
  createEntryFormTable,
  pickEntryFormTable,
  pickTocTable,
  resolveBodyCell,
  shouldAutoCreateDocument,
  type ApplyResult,
  type CreatedEntryForm,
  type ChangedPara,
  type FormSourceTable,
  type ImageForInsert,
  type WasmEditing,
} from '@/core/ai-apply';
import { buildDiffModel, type DiffItem } from '@/core/ai-diff';
import {
  CUSTOM_MODEL,
  builtinModels,
  defaultModel,
  mergeModelList,
  supportsModelListing,
} from '@/core/model-catalog';
import { AiSessionMachine } from '@/core/ai-session';
import {
  deleteConversation,
  loadConversations,
  upsertConversation,
  type StoredConversation,
  type StoredMessage,
} from '@/core/conversation-store';
import { renderChartToPng, validateChartData } from '@/core/chart-render';
import {
  compileTheme,
  DEFAULT_COMPILED_THEME,
  type CompiledTheme,
  type DocTheme,
} from '@/core/doc-theme';
import { clearInlineDiff, showInlineDiff, type InlineDiffEntry } from '@/ui/ai-inline-diff';
import { AI_PANEL_TOGGLE_EVENT } from '@/command/commands/ai';
import { buildSkillCatalog, isAuthoringRequest } from '@/core/skill-select';
import type { CursorRect, PageInfo } from '@/upstream/core';

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
    /** 새 빈 문서 생성(데스크톱 런타임). 문서 없이 들어온 요구를 위해 사이드바가 직접 호출한다. */
    createNewDocumentAsync?(): Promise<{ docInfo: unknown; message: string } | null>;
    readonly fileName?: string;
  };

interface CanvasViewLike {
  getVirtualScroll(): { getPageOffset(pageIndex: number): number };
  getViewportManager(): { getZoom(): number };
}

export interface AgentSidebarDeps {
  bridge: AgentBridge;
  eventBus: {
    emit(name: string, payload?: unknown): void;
    /** 있으면 view:ai-panel(툴바·메뉴·⌘J) 토글 이벤트를 구독한다. */
    on?(name: string, handler: (...args: unknown[]) => void): () => void;
  };
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
const AGY_CLI_PROVIDER = 'agy-cli';

/** CLI 위임 provider — 첨부를 base64 대신 파일 경로로 넘기고 키가 필요 없다. */
const CLI_PROVIDERS = new Set<string>([CLAUDE_CLI_PROVIDER, AGY_CLI_PROVIDER]);

const PROVIDERS = [
  'gemini',
  'openai',
  'anthropic',
  'ollama',
  CLAUDE_CLI_PROVIDER,
  AGY_CLI_PROVIDER,
  CUSTOM_PROVIDER,
] as const;

const PROVIDER_LABELS: Record<string, string> = {
  [CLAUDE_CLI_PROVIDER]: 'Claude Code (로컬 CLI)',
  [AGY_CLI_PROVIDER]: 'agy CLI (로컬)',
  [CUSTOM_PROVIDER]: 'OpenAI 호환 (Groq 등)',
};

/** 모델 메뉴 제공자 칩의 표시 이름(키 라벨 등 기존 문구는 PROVIDER_LABELS를 그대로 쓴다). */
function providerDisplayName(id: string): string {
  const names: Record<string, string> = {
    gemini: 'Gemini',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    ollama: 'Ollama',
  };
  return names[id] ?? PROVIDER_LABELS[id] ?? id;
}

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

/**
 * 모델 목록·기본값은 `core/model-catalog`가 소유한다(F-ec1f3481) — 내장 목록은 폴백이고,
 * "새로 고침"이 provider API에서 받은 실제 목록으로 교체한다.
 */

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
  /** 이번 답변이 따른 글쓰기 지침 표시('지침: 공문 · AI 선택'). */
  skillEl: HTMLElement;
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

/**
 * 드롭 위치가 패널(rect, CSS 픽셀)에 들어오는지 — 물리/논리 픽셀 해석 모두에 관대하게 본다
 * (F-157aa77d). Tauri v2 drag-drop의 position이 버전에 따라 물리(PhysicalPosition)일 수도
 * 논리일 수도 있어, 원본 좌표와 dpr로 나눈 좌표 중 하나라도 rect에 들면 참으로 본다 —
 * dpr=2(Retina)에서 좌표가 절반으로 계산돼 드롭이 무시되던 문제를 없앤다.
 */
export function dropPointOverRect(
  pos: { x: number; y: number } | undefined,
  rect: { left: number; right: number; top: number; bottom: number },
  dpr: number,
): boolean {
  if (!pos) return false;
  const d = dpr > 0 ? dpr : 1;
  const inRect = (x: number, y: number): boolean =>
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  return inRect(pos.x, pos.y) || inRect(pos.x / d, pos.y / d);
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
  private readonly modelRefreshBtn: HTMLButtonElement;
  /** provider API에서 조회한 모델 목록(provider별 캐시). 없으면 내장 목록을 쓴다. */
  private readonly fetchedModels = new Map<string, string[]>();
  private readonly sendBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly statusArea: HTMLElement;
  private readonly chipsArea: HTMLElement;
  private readonly fileInput: HTMLInputElement;
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
   *  'proofread'는 전체 교정 패스(응답을 적용하지 않고 이슈 목록으로 수집).
   *  'form_fill'은 양식 이어쓰기(AI는 항목 내용만, 앱이 표를 결정적 복제 — F-ae778890). */
  private requestMode: 'edit' | 'ask' | 'proofread' | 'form_fill' = 'edit';
  /** 교정 패스의 순차 루프가 기다리는 현재 구간 응답 resolver. */
  private proofreadResolve: ((script: ActionScript | null) => void) | null = null;
  /** 양식 이어쓰기 루프가 기다리는 form-fill 응답(원문 JSON) resolver. */
  private formFillResolve: ((rawJson: string | null) => void) | null = null;
  private readonly modeEditBtn: HTMLButtonElement;
  private readonly modeAskBtn: HTMLButtonElement;
  private readonly modeTrigger: HTMLButtonElement;
  private readonly modeMenu: HTMLElement;
  private readonly modelTrigger: HTMLButtonElement;
  private readonly modelMenu: HTMLElement;
  private readonly modelProviders: HTMLElement;
  private readonly modelList: HTMLElement;
  private readonly quickActions: HTMLElement;
  /** 입력창 맨 앞 '/'로 여는 빠른 작업 메뉴. */
  private readonly slashMenu: HTMLElement;
  /** '/' 메뉴에서 키보드로 고른 항목 위치(보이는 항목 기준). */
  private slashIndex = 0;
  /** 승인 대기 중 입력창 위에 고정되는 검토 바(모두 승인/거절). */
  private readonly reviewBar: HTMLElement;
  private readonly reviewLabel: HTMLElement;
  private readonly reviewAcceptBtn: HTMLButtonElement;
  private readonly reviewRejectBtn: HTMLButtonElement;
  /** 빈 대화 화면(최근 대화 · 자주 쓰는 작업). */
  private readonly welcome: HTMLElement;
  /** '생각 중 · N초' 경과 표시 타이머. */
  private thinkingTimer: ReturnType<typeof setInterval> | null = null;
  private readonly skillSelect: HTMLSelectElement;
  private readonly themeSelect: HTMLSelectElement;
  /** 이번 요청에 지침을 실었는지, 사용자가 직접 고른 지침 이름(자동이면 null). */
  private requestSkill: { offered: boolean; forced: string | null } = { offered: false, forced: null };
  /** 로드된 글쓰기 스킬 목록(문서 유형별 작성 지침). */
  private skills: {
    id: string;
    name: string;
    description: string;
    triggers: string[];
    body: string;
    mode?: string;
  }[] = [];
  /** 로드된 디자인 테마 목록(간격·크기·색 수치). */
  private themes: DocTheme[] = [];
  /** 적용에 쓸 컴파일된 테마(선택 변경 시 갱신). */
  private compiledTheme: CompiledTheme = DEFAULT_COMPILED_THEME;
  /** 변형 제안 상태(대안 버튼들 + 대상 edit + 컨테이너). 변형을 고를 때 다시 적용한다. */
  private variationState: { edit: Edit; btns: HTMLButtonElement[]; container: HTMLElement } | null =
    null;
  private readonly keyRow: HTMLElement;
  private readonly keyLabel: HTMLElement;
  private readonly keylessHint: HTMLElement;
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
  /** view:ai-panel 명령(툴바·메뉴·⌘J) 구독 해제. */
  private offTogglePanel: (() => void) | null = null;
  private requestId: string | null = null;
  /** 스트리밍 중 누적되는 Raw 응답(여기서 생성 본문 text를 실시간 추출해 보여준다). */
  private streamBuffer = '';
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
  /** 문서 위 미니 ✓로 개별 승인(검토 끝)한 edit 인덱스 — 표시만 빠지고 적용은 유지된다. */
  private resolvedEdits = new Set<number>();
  /** 문서 위 검토 바가 가리키는 변경 위치(다시 그려도 이어 간다). */
  private inlineFocus = 0;

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
    this.modelRefreshBtn = built.modelRefreshBtn;
    this.sendBtn = built.sendBtn;
    this.cancelBtn = built.cancelBtn;
    this.statusArea = built.statusArea;
    this.chipsArea = built.chipsArea;
    this.fileInput = built.fileInput;
    this.settingsPanel = built.settingsPanel;
    this.settingsModal = built.settingsModal;
    this.menu = built.menu;
    this.logPanel = built.logPanel;
    this.historyPanel = built.historyPanel;
    this.modeEditBtn = built.modeEditBtn;
    this.modeAskBtn = built.modeAskBtn;
    this.modeTrigger = built.modeTrigger;
    this.modeMenu = built.modeMenu;
    this.modelTrigger = built.modelTrigger;
    this.modelMenu = built.modelMenu;
    this.modelProviders = built.modelProviders;
    this.modelList = built.modelList;
    this.quickActions = built.quickActions;
    this.slashMenu = built.slashMenu;
    this.reviewBar = built.reviewBar;
    this.reviewLabel = built.reviewLabel;
    this.reviewAcceptBtn = built.reviewAcceptBtn;
    this.reviewRejectBtn = built.reviewRejectBtn;
    this.welcome = built.welcome;
    this.skillSelect = built.skillSelect;
    this.themeSelect = built.themeSelect;
    this.keyRow = built.keyRow;
    this.keyLabel = built.keyLabel;
    this.keylessHint = built.keylessHint;
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
    built.attachBtn.addEventListener('click', () => void this.pickFilesViaDialog());
    this.fileInput.addEventListener('change', () => void this.onFilesPicked());
    this.providerSelect.addEventListener('change', () => void this.onProviderChange());
    this.modelSelect.addEventListener('change', () => this.updateModelVisibility());
    this.modelRefreshBtn.addEventListener('click', () => void this.refreshModels());
    this.modelInput.addEventListener('input', () => this.updateModelTrigger());
    this.modelInput.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Enter') this.closePopovers();
    });
    built.keySaveBtn.addEventListener('click', () => void this.saveKey());
    built.keylessBtn.addEventListener('click', () => void this.switchToLocalCli());
    this.keyClearBtn.addEventListener('click', () => void this.clearKey());
    this.sensitiveCheckbox.addEventListener('change', () => void this.onSensitivityToggle());
    this.presetSelect.addEventListener('change', () => this.applyPreset());
    this.promptInput.addEventListener('keydown', (event) => this.onPromptKeydown(event as KeyboardEvent));
    this.modeEditBtn.addEventListener('click', () => this.setMode('edit'));
    this.modeAskBtn.addEventListener('click', () => this.setMode('ask'));
    this.modeTrigger.addEventListener('click', () => this.togglePopover(this.modeMenu));
    this.modelTrigger.addEventListener('click', () => {
      if (this.modelMenu.classList.contains('hop-ai-hidden')) this.renderModelMenu();
      this.togglePopover(this.modelMenu);
    });
    built.modelKeyBtn.addEventListener('click', () => {
      this.closePopovers();
      this.toggleSettings(true);
    });
    this.reviewAcceptBtn.addEventListener('click', () => this.accept());
    this.reviewRejectBtn.addEventListener('click', () => this.reject());
    // 빠른 작업 — data-action으로 위임 처리. 입력창의 '/명령' 글자는 지우고 실행한다.
    this.quickActions.addEventListener('click', (event) => {
      const target = (event.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (!target?.dataset.action) return;
      this.closeSlashMenu(true);
      void this.runQuickAction(target.dataset.action);
    });
    this.promptInput.addEventListener('input', () => this.updateSlashMenu());
    // 팝오버 밖을 누르면 닫는다(메뉴 안 클릭은 각 핸들러가 처리).
    this.panel.addEventListener('mousedown', (event) => {
      const target = event.target as HTMLElement | null;
      // '/' 메뉴는 그 안·입력창·지침 표시를 누를 때 말고는 닫는다.
      if (!target?.closest?.('.hop-ai-slash, .hop-ai-prompt, .hop-ai-skill-chip')) this.closeSlashMenu();
      if (target?.closest?.('.hop-ai-pop, .hop-ai-dd, .hop-ai-settings-btn')) return;
      this.closePopovers();
      if (!this.menu.classList.contains('hop-ai-hidden')) this.toggleMenu(false);
    });
    this.panel.addEventListener('paste', (event) => void this.onPaste(event as ClipboardEvent));
    // 드래그&드롭으로 이미지·텍스트 문서 첨부.
    this.panel.addEventListener('dragover', (event) => this.onDragOver(event as DragEvent));
    this.panel.addEventListener('dragleave', (event) => this.onDragLeave(event as DragEvent));
    this.panel.addEventListener('drop', (event) => void this.onDrop(event as DragEvent));
    // 패널 내부 키 입력(붙여넣기/전체선택 등)이 문서 전역 단축키 핸들러로
    // 전파돼 가로채이지 않도록 막는다. 버블 단계라 textarea의 Enter 처리는 유지된다.
    this.panel.addEventListener('keydown', (event) => {
      this.onPanelKeydown(event as KeyboardEvent);
      (event as KeyboardEvent).stopPropagation();
    });
    // 패널 안 선택 텍스트(스트림/diff 등) 복사 — 에디터가 숨은 textarea에 포커스를
    // 잡고 있어 일반 Cmd/Ctrl+C가 패널 선택을 복사하지 못한다. 캡처 단계에서
    // 선택을 직접 클립보드에 써서, 패널 선택일 때만 가로채 처리한다.
    this.copyHandler = (event) => this.onGlobalCopyKey(event);
    document.addEventListener('keydown', this.copyHandler, true);

    // 둥근 떠 있는 AI 버튼은 두지 않는다 — 툴바 'AI 편집' 버튼·보기 메뉴·⌘J(view:ai-panel)가 연다.
    document.body.appendChild(this.panel);
    document.body.classList.add('hop-ai-available');
    this.offTogglePanel = this.deps.eventBus.on?.(AI_PANEL_TOGGLE_EVENT, () => this.toggle()) ?? null;
    this.keyRow.classList.add('hop-ai-hidden');
    this.customRow.classList.add('hop-ai-hidden');
    this.setRequesting(false);
    this.updateReviewBar(false);
    this.setMode('edit');
    this.populateModels(this.providerSelect.value);
    this.renderChips();
    this.newConversation(); // 첫 대화 생성(빈 상태 → 컴포저 상단)
    void this.subscribe();
    void this.subscribeNativeDragDrop();
    void this.refreshKeyState();
    void this.loadSkills();
    void this.loadThemes();
    this.themeSelect.addEventListener('change', () => this.onThemeChange());
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
    this.skillSelect.appendChild(option('auto', '스킬: 자동(AI 선택)'));
    this.skillSelect.appendChild(option('none', '스킬: 없음'));
    for (const s of this.skills) this.skillSelect.appendChild(option(`id:${s.id}`, `스킬: ${s.name}`));
    this.skillSelect.value = prev || 'auto';
  }

  /** 디자인 테마를 불러와 드롭다운을 채우고 저장된 선택을 복원한다. */
  private async loadThemes(): Promise<void> {
    try {
      if (typeof this.deps.bridge.aiListThemes === 'function') {
        this.themes = await this.deps.bridge.aiListThemes();
      }
    } catch {
      this.themes = [];
    }
    const saved =
      (typeof localStorage !== 'undefined' && localStorage.getItem('hop-ai-theme-id')) || '';
    this.themeSelect.replaceChildren();
    for (const t of this.themes) {
      this.themeSelect.appendChild(option(t.id ?? '', `테마: ${t.name ?? t.id ?? ''}`));
    }
    if (!this.themes.length) this.themeSelect.appendChild(option('', '테마: 기본'));
    const ids = this.themes.map((t) => t.id ?? '');
    this.themeSelect.value = ids.includes(saved) ? saved : (ids[0] ?? '');
    this.onThemeChange(false);
  }

  /** 테마 선택 변경 — 컴파일해 적용 경로(ai-apply)에 쓸 수 있게 한다. */
  private onThemeChange(persist = true): void {
    const id = this.themeSelect.value;
    const raw = this.themes.find((t) => t.id === id) ?? null;
    this.compiledTheme = compileTheme(raw);
    if (persist) {
      if (typeof localStorage !== 'undefined') localStorage.setItem('hop-ai-theme-id', id);
      this.log(`테마 변경: ${this.compiledTheme.name}`);
    }
  }

  /**
   * 이번 요청 앞에 붙일 글쓰기 지침. '자동'(기본)이면 모든 스킬을 '작성 지침 목록'으로 실어
   * AI가 요청 내용과 문서 상태를 보고 의미로 골라 따르게 하고(F-fb6592e9), 직접 고른 스킬이면
   * 그 지침 하나만, '없음'이면 싣지 않는다.
   */
  private skillPrefixFor(prompt: string): { prefix: string; offered: boolean; forced: string | null } {
    const v = this.skillSelect?.value ?? 'auto';
    if (v === 'none' || !this.skills.length) return { prefix: '', offered: false, forced: null };
    if (v.startsWith('id:')) {
      const s = this.skills.find((x) => x.id === v.slice(3));
      if (!s) return { prefix: '', offered: false, forced: null };
      return { prefix: `[작성 스킬: ${s.name}]\n${s.body}\n\n---\n\n`, offered: true, forced: s.name };
    }
    return { prefix: `${buildSkillCatalog(prompt, this.skills)}\n\n---\n\n`, offered: true, forced: null };
  }

  /** 답변에 '지침: 이름 · AI 선택/직접 선택'을 단다. 응답의 skill이 모르는 이름이면 달지 않는다. */
  private renderSkillChip(turn: ActiveTurn, reported: string | undefined): void {
    turn.skillEl.replaceChildren();
    const { offered, forced } = this.requestSkill;
    if (!offered) return;
    const wanted = (forced ?? reported ?? '').trim();
    if (!wanted) {
      this.log('AI가 따른 지침: 없음');
      return;
    }
    const squash = (t: string) => t.replace(/\s+/g, '');
    const known = this.skills.find((s) => s.name === wanted) ?? this.skills.find((s) => squash(s.name) === squash(wanted));
    if (!known) {
      this.log(`AI가 알 수 없는 지침 이름을 보냄: ${wanted}`);
      return;
    }
    this.log(`따른 지침: ${known.name}${forced ? '(직접 선택)' : '(AI 선택)'}`);
    const chip = el('button', 'hop-ai-skill-chip') as HTMLButtonElement;
    chip.type = 'button';
    chip.title = '입력창의 / 메뉴에서 다른 지침을 고르거나 끌 수 있습니다';
    chip.append(icon('sparkle'), textSpan('hop-ai-skill-chip-label', `지침: ${known.name} · ${forced ? '직접 선택' : 'AI 선택'}`));
    chip.addEventListener('click', () => this.openSkillPicker());
    turn.skillEl.appendChild(chip);
  }

  /** 입력창의 글은 그대로 두고 '/' 메뉴(스킬·테마 선택 포함)를 연다. */
  private openSkillPicker(): void {
    this.closePopovers();
    for (const item of Array.from(this.slashItems())) item.classList.remove('hop-ai-hidden');
    this.slashMenu.classList.remove('hop-ai-slash-filtered');
    this.slashMenu.classList.remove('hop-ai-hidden');
    this.slashIndex = 0;
    this.highlightSlash();
    this.skillSelect.focus?.();
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

    const overPanel = (pos: { x: number; y: number } | undefined): boolean =>
      dropPointOverRect(pos, this.panel.getBoundingClientRect(), window.devicePixelRatio || 1);

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
    // 패널은 fixed 오버레이(right:0, --hop-ai-width)라 열리면 문서 스크롤바를 가린다. 본문 영역
    // (#studio-root)을 패널 폭만큼 줄여 스크롤바가 패널 왼쪽에 보이게 한다.
    document.body.classList.toggle('hop-ai-open', show);
    // 툴바·메뉴의 'AI 편집' 항목에 열림 상태를 반영한다.
    for (const node of Array.from(document.querySelectorAll?.('[data-cmd="view:ai-panel"]') ?? [])) {
      (node as HTMLElement).classList.toggle('active', show);
      (node as HTMLElement).setAttribute('aria-pressed', String(show));
    }
    if (show) {
      this.promptInput.focus?.();
    } else {
      this.closePopovers();
      this.closeSlashMenu();
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.offTogglePanel?.();
    this.stopThinkingTimer();
    document.body.classList.remove('hop-ai-available');
    if (this.copyHandler) document.removeEventListener('keydown', this.copyHandler, true);
    document.body.classList.remove('hop-ai-open');
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
    const closeBtn = iconButton('hop-ai-history-close', 'x', '닫기');
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
      const del = iconButton('hop-ai-history-del', 'trash', '이 대화 삭제');
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
    const empty = !this.activeConv.hasMessages;
    this.panel.classList.toggle('hop-ai-empty', empty);
    if (empty) this.renderWelcome();
  }

  /**
   * 빈 대화 화면 — 자주 쓰는 작업(눌러서 시작)과 최근 대화. 작성형 작업은 지시 첫머리만
   * 채워 두고 사용자가 주제를 이어 쓰게 한다(바로 보내지 않음).
   */
  private renderWelcome(): void {
    this.welcome.replaceChildren();
    const tasks: { icon: IconName; label: string; run: () => void }[] = [
      { icon: 'file', label: '보고서 초안 쓰기', run: () => this.prefillPrompt('다음 주제로 보고서 초안을 써줘 — 제목, 개요, 본문(소제목별), 결론 순서로: ') },
      { icon: 'table', label: '표로 정리하기', run: () => this.prefillPrompt('다음 내용을 표로 정리해줘(첫 행은 머리글): ') },
      { icon: 'check', label: '문서 전체 교정', run: () => void this.runQuickAction('proofread') },
      { icon: 'list', label: '문서 요약', run: () => void this.runQuickAction('summarize') },
    ];
    const taskList = el('div', 'hop-ai-welcome-list');
    for (const task of tasks) {
      const button = el('button', 'hop-ai-welcome-item hop-ai-pop-item') as HTMLButtonElement;
      button.type = 'button';
      button.append(icon(task.icon), textSpan('hop-ai-pop-label', task.label));
      button.addEventListener('click', task.run);
      taskList.appendChild(button);
    }
    this.welcome.append(popGroupLabel('자주 쓰는 작업'), taskList);

    const recent = loadConversations().filter((c) => c.messages.length > 0).slice(0, 3);
    if (recent.length) {
      const recentList = el('div', 'hop-ai-welcome-list');
      for (const conv of recent) {
        const button = el('button', 'hop-ai-welcome-item hop-ai-pop-item') as HTMLButtonElement;
        button.type = 'button';
        button.append(
          icon('chat'),
          textSpan('hop-ai-pop-label', conv.title || '(제목 없음)'),
          textSpan('hop-ai-pop-hint', relativeTime(conv.updatedAt)),
        );
        button.addEventListener('click', () => this.openStoredConversation(conv));
        recentList.appendChild(button);
      }
      this.welcome.append(popGroupLabel('최근 대화'), recentList);
    }
    const hints = el('div', 'hop-ai-welcome-hints');
    for (const [key, label] of [
      ['Enter', '보내기'],
      ['Shift+Enter', '줄바꿈'],
      ['/', '빠른 작업'],
      [modKey('J'), '패널 닫기'],
    ]) {
      const hint = el('span', 'hop-ai-welcome-hint');
      hint.append(kbdSpan(key), textSpan('', label));
      hints.appendChild(hint);
    }
    this.welcome.appendChild(hints);
  }

  /** 입력창에 지시 첫머리를 채우고 커서를 끝에 둔다. */
  private prefillPrompt(text: string): void {
    this.promptInput.value = text;
    this.promptInput.focus?.();
    this.promptInput.setSelectionRange?.(text.length, text.length);
  }

  /** 작업 모드 전환(편집/질문). 질문 모드는 문서를 수정하지 않고 답변만 한다. */
  private setMode(mode: 'edit' | 'ask'): void {
    this.mode = mode;
    this.modeEditBtn.classList.toggle('hop-ai-mode-active', mode === 'edit');
    this.modeAskBtn.classList.toggle('hop-ai-mode-active', mode === 'ask');
    this.modeEditBtn.setAttribute('aria-checked', String(mode === 'edit'));
    this.modeAskBtn.setAttribute('aria-checked', String(mode === 'ask'));
    this.modeTrigger.replaceChildren(
      icon(mode === 'ask' ? 'chat' : 'pencil'),
      textSpan('hop-ai-dd-label', mode === 'ask' ? '질문' : '편집'),
      icon('down'),
    );
    this.panel.dataset.mode = mode;
    this.promptInput.placeholder = PROMPT_PLACEHOLDER[mode];
    this.closePopovers();
  }

  // ── 팝오버(모드·모델) / '/' 메뉴 ───────────────────────────────

  /** 입력창 아래 팝오버 하나를 연다/닫는다(다른 팝오버·'/' 메뉴는 닫는다). */
  private togglePopover(menu: HTMLElement): void {
    const show = menu.classList.contains('hop-ai-hidden');
    this.closePopovers();
    this.closeSlashMenu();
    menu.classList.toggle('hop-ai-hidden', !show);
    const trigger = menu === this.modeMenu ? this.modeTrigger : this.modelTrigger;
    trigger.setAttribute('aria-expanded', String(show));
    trigger.classList.toggle('hop-ai-dd-open', show);
  }

  private closePopovers(): void {
    for (const [menu, trigger] of [
      [this.modeMenu, this.modeTrigger],
      [this.modelMenu, this.modelTrigger],
    ] as const) {
      menu.classList.add('hop-ai-hidden');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.classList.remove('hop-ai-dd-open');
    }
  }

  private isPopoverOpen(): boolean {
    return (
      !this.modeMenu.classList.contains('hop-ai-hidden') ||
      !this.modelMenu.classList.contains('hop-ai-hidden')
    );
  }

  /** 모델 팝오버 — 제공자 칩 + 모델 목록(현재 선택에 체크). 값은 숨은 select에 둔다. */
  private renderModelMenu(): void {
    const provider = this.providerSelect.value;
    this.modelProviders.replaceChildren();
    for (const id of PROVIDERS) {
      const chip = el('button', 'hop-ai-provider-chip') as HTMLButtonElement;
      chip.type = 'button';
      chip.textContent = providerDisplayName(id);
      chip.classList.toggle('hop-ai-provider-chip-active', id === provider);
      chip.setAttribute('aria-pressed', String(id === provider));
      chip.addEventListener('click', () => {
        if (this.providerSelect.value === id) return;
        this.providerSelect.value = id;
        void this.onProviderChange();
      });
      this.modelProviders.appendChild(chip);
    }
    this.modelList.replaceChildren();
    const current = this.modelSelect.value;
    for (const opt of Array.from(this.modelSelect.children) as HTMLOptionElement[]) {
      const value = opt.value;
      const active = value === current;
      const item = el('button', 'hop-ai-model-item hop-ai-pop-item') as HTMLButtonElement;
      item.type = 'button';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(active));
      item.classList.toggle('hop-ai-pop-item-active', active);
      item.append(
        textSpan('hop-ai-pop-label', opt.textContent || value),
        active ? icon('check') : el('span', 'hop-ai-ic'),
      );
      item.addEventListener('click', () => {
        this.modelSelect.value = value;
        this.updateModelVisibility();
        if (value === CUSTOM_MODEL) {
          this.renderModelMenu();
          this.modelInput.focus?.();
          return;
        }
        this.closePopovers();
      });
      this.modelList.appendChild(item);
    }
  }

  /** 입력창 아래 '모델명 ▾' 표시를 현재 선택으로 맞춘다. */
  private updateModelTrigger(): void {
    const provider = this.providerSelect.value;
    const model = this.currentModel();
    this.modelTrigger.replaceChildren(textSpan('hop-ai-dd-label', model), icon('down'));
    this.modelTrigger.title = `모델: ${providerDisplayName(provider)} · ${model}`;
  }

  private slashItems(): HTMLElement[] {
    return this.quickActions.querySelectorAll('.hop-ai-quick-chip') as unknown as HTMLElement[];
  }

  private visibleSlashItems(): HTMLElement[] {
    return Array.from(this.slashItems()).filter((item) => !item.classList.contains('hop-ai-hidden'));
  }

  private isSlashOpen(): boolean {
    return !this.slashMenu.classList.contains('hop-ai-hidden');
  }

  /** 입력창이 '/검색어' 한 단어일 때 빠른 작업 메뉴를 걸러 보여준다. */
  private updateSlashMenu(): void {
    const match = /^\/(\S*)$/.exec(this.promptInput.value);
    if (!match) {
      this.closeSlashMenu();
      return;
    }
    const query = match[1];
    for (const item of Array.from(this.slashItems())) {
      const hit =
        !query ||
        (item.dataset.alias ?? '').startsWith(query) ||
        (item.textContent ?? '').includes(query);
      item.classList.toggle('hop-ai-hidden', !hit);
    }
    // 걸러 볼 때는 묶음 제목을 숨긴다(제목만 남는 빈 묶음 방지).
    this.slashMenu.classList.toggle('hop-ai-slash-filtered', query.length > 0);
    this.closePopovers();
    this.slashMenu.classList.remove('hop-ai-hidden');
    this.slashIndex = 0;
    this.highlightSlash();
  }

  private highlightSlash(): void {
    this.visibleSlashItems().forEach((item, i) => {
      item.classList.toggle('hop-ai-pop-item-active', i === this.slashIndex);
    });
  }

  /** '/' 메뉴를 닫는다. clearText면 입력창의 '/명령' 글자도 지운다. */
  private closeSlashMenu(clearText = false): void {
    this.slashMenu.classList.add('hop-ai-hidden');
    if (clearText && /^\/\S*$/.test(this.promptInput.value)) this.promptInput.value = '';
  }

  /**
   * 패널 안 단축키(커서식). 패널 keydown은 전역 단축키로 전파되지 않으므로 ⌘J도 여기서 받는다.
   * ⌘⏎ 모두 승인 · ⌘⌫ 모두 거절(승인 대기 중) · Esc 메뉴 닫기 → 생성 중지.
   */
  private onPanelKeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && !event.altKey && !event.shiftKey && (event.key === 'j' || event.key === 'J' || event.code === 'KeyJ')) {
      event.preventDefault();
      this.toggle(false);
      return;
    }
    if (mod && !event.altKey && !event.shiftKey && this.session.isPending && this.pendingScript) {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.accept();
        return;
      }
      // 입력창에 쓰던 글이 있으면 ⌘⌫는 원래대로(줄 지우기) 둔다.
      const typing = event.target === this.promptInput && this.promptInput.value.length > 0;
      if (event.key === 'Backspace' && !typing) {
        event.preventDefault();
        this.reject();
        return;
      }
    }
    if (event.key === 'Escape') {
      if (this.isSlashOpen()) this.closeSlashMenu();
      else if (this.isPopoverOpen()) this.closePopovers();
      else if (!this.menu.classList.contains('hop-ai-hidden')) this.toggleMenu(false);
      else if (!this.settingsModal.classList.contains('hop-ai-hidden')) this.toggleSettings(false);
      else if (!this.historyPanel.classList.contains('hop-ai-hidden')) this.toggleHistory(false);
      else if (this.session.state === 'REQUESTING') void this.cancel();
      else return;
      event.preventDefault();
    }
  }

  /** 빠른 작업 칩 — 프리셋 지시를 채워 바로 전송한다. 선택 영역이 있으면 그 부분이 대상. */
  private async runQuickAction(action: string): Promise<void> {
    // 전체 교정은 프리셋 전송이 아니라 전용 스캔 루프를 돈다(F-55a6a4).
    if (action === 'proofread') {
      await this.runProofread();
      return;
    }
    // 양식 이어쓰기 — AI는 항목 내용만, 앱이 표를 결정적 복제(F-ae778890).
    if (action === 'form_fill') {
      await this.runFormFill();
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

  /**
   * 요청에 쓸 문서 ID를 확보한다(F-d448f667). 열린 문서가 없으면 — 그 요구가 빈 문서에서
   * 의미가 있는 경우에 한해 — 새 문서를 만들어 진행한다. 막을 때는 사유를 남긴다.
   */
  private async resolveDocId(allowCreate: boolean): Promise<string | null> {
    const existing = this.deps.bridge.currentDocId();
    if (existing) return existing;
    if (!allowCreate || !shouldAutoCreateDocument(this.mode, this.attachments.length > 0)) {
      this.setStatus('먼저 문서를 여세요.', 'warn');
      return null;
    }
    return this.createBlankDocument();
  }

  /**
   * 빈 문서를 만들고 에디터를 그 문서로 초기화한다. 생성은 브리지가, 폰트·캔버스·툴바
   * 초기화는 main.ts의 `desktop-document-loaded` 핸들러가 담당한다 — 사이드바가 로드
   * 시퀀스를 재구현하지 않는다.
   */
  private async createBlankDocument(): Promise<string | null> {
    const create = this.deps.bridge.createNewDocumentAsync;
    if (!create) {
      this.setStatus('먼저 문서를 여세요.', 'warn');
      return null;
    }
    this.setStatus('열린 문서가 없어 새 문서를 만듭니다…', 'info');
    this.log('열린 문서 없음 — 새 문서를 만들고 요구를 진행합니다.');
    try {
      const payload = await create.call(this.deps.bridge);
      if (!payload) {
        // 직전 문서 저장 확인을 사용자가 취소한 경우 — 요구를 진행하지 않는다.
        this.setStatus('새 문서 생성이 취소되었습니다.', 'warn');
        return null;
      }
      this.deps.eventBus.emit('desktop-document-loaded', payload);
    } catch (error) {
      this.setStatus(`새 문서를 만들지 못했습니다: ${String(error)}`, 'error');
      return null;
    }
    const docId = this.deps.bridge.currentDocId();
    if (!docId) {
      this.setStatus('새 문서를 만들지 못했습니다 — 문서를 먼저 여세요.', 'warn');
      return null;
    }
    return docId;
  }

  /**
   * 전송 공통 가드(문서/민감/키/Base URL). 통과 시 요청 파라미터를, 막히면 null을 반환한다.
   *
   * `autoCreateDoc: false`는 빈 문서로는 뜻이 없는 요구(문서 전수 교정)에서 쓴다.
   */
  private async checkSendGuards(
    opts: { autoCreateDoc?: boolean } = {},
  ): Promise<{ docId: string; provider: string; baseUrl: string | null } | null> {
    const docId = await this.resolveDocId(opts.autoCreateDoc !== false);
    if (!docId) return null;
    const provider = this.providerSelect.value;
    if (this.sensitive && !LOCAL_PROVIDERS.has(provider)) {
      this.setStatus('민감 문서로 표시됨 — 로컬 모델(ollama)만 사용할 수 있습니다.', 'warn');
      return null;
    }
    if (KEY_PROVIDERS.has(provider) && this.keyState.get(provider) === false) {
      this.toggleSettings(true);
      this.setStatus('API 키를 먼저 저장하세요. (입력창 아래 모델 메뉴 → API 키·Agent 설정)', 'warn');
      return null;
    }
    const baseUrl = provider === CUSTOM_PROVIDER ? this.baseUrlInput.value.trim() : null;
    if (provider === CUSTOM_PROVIDER && !baseUrl) {
      this.toggleSettings(true);
      this.setStatus('Base URL을 입력하세요 (모델 메뉴 → API 키·Agent 설정, 예: https://api.groq.com/openai).', 'warn');
      return null;
    }
    return { docId, provider, baseUrl };
  }

  /** 첨부 문서의 백그라운드 텍스트 추출이 남아 있으면 끝날 때까지 기다린다. */
  private async awaitAttachmentExtraction(): Promise<void> {
    if (!this.extractTasks.length) return;
    this.setStatus('첨부 문서 분석이 끝나면 전송합니다…');
    // 기다리는 동안 새로 붙은 첨부의 추출도 놓치지 않도록, 목록을 비우고 받은 것만 기다리기를
    // 남은 작업이 없을 때까지 반복한다(대기 중 push된 작업을 초기화로 날리지 않는다).
    while (this.extractTasks.length) {
      const pending = this.extractTasks;
      this.extractTasks = [];
      await Promise.all(pending);
    }
  }

  private async send(): Promise<void> {
    const prompt = this.promptInput.value.trim();
    if (!prompt) {
      this.setStatus('지시를 입력하세요.', 'warn');
      return;
    }
    // 자동 라우팅(F-4bdf23a4): 연구노트형 docx가 첨부돼 있으면 자연어 명령이어도 LLM 대신
    // 결정적 양식 변환 경로로 보낸다('양식 항목 추가' 칩을 몰라도 됨). 연구노트 구조가 아니면
    // runDocxFormFill이 false를 반환하고 아래 기존 LLM 편집 경로로 폴백한다(일반 편집 영향 없음).
    // 첨부 문서가 아직 백그라운드 추출 중이면 끝날 때까지 기다린다 — 아래 연구노트
    // 라우팅(runFormFill)도 추출 본문을 LLM에 넘기므로, 기다리지 않으면 PDF 내용 없이
    // 지시문만 가서 모델이 항목을 지어낸다.
    await this.awaitAttachmentExtraction();
    if (this.session.state !== 'REQUESTING') {
      const docxAtt = this.attachments.find((a) => a.path && /\.(docx|pdf)$/i.test(a.path));
      // 문서가 없으면 만들어서라도 이 경로를 탄다(F-86317c64 AC-119ff14f) — currentDocId()만
      // 보고 건너뛰면 "문서 안 열고 PDF+연구노트"가 일반 편집 경로로 새서 실패한다.
      const docId0 = docxAtt?.path ? await this.resolveDocId(true) : null;
      if (docxAtt?.path && docId0) {
        const handled = await this.runDocxFormFill(docId0, docxAtt.path);
        if (handled) return;
        // 구조 파싱이 실패했다(연구노트 포맷이 아니다). 사용자가 '연구노트'를 만들어
        // 달라고 한 경우라면 일반 편집이 아니라 LLM 양식 채움으로 보낸다 — 그래야 임의
        // PDF·docx도 항목으로 정리된다(F-5e9c6033). 의도 키워드가 없으면 아래 일반
        // 경로로 폴백해 요약·질문·일반 편집 요구를 가로채지 않는다.
        if (wantsResearchNote(prompt)) {
          this.log('연구노트 의도 감지 — 구조 파싱 실패분을 LLM 양식 채움으로 라우팅');
          await this.runFormFill(true);
          return;
        }
      }
    }
    const guard = await this.checkSendGuards();
    if (!guard) return;
    const { docId, provider, baseUrl } = guard;

    // 위에서 기다렸지만, 가드 대기 중 새로 붙은 첨부가 있을 수 있다.
    await this.awaitAttachmentExtraction();

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
    // 질문 모드는 문서를 고치지 못한다 — '작성해줘' 같은 요청이면 편집 모드로 바꿔 보낸다.
    let modeNote = '';
    if (this.mode === 'ask' && isAuthoringRequest(prompt)) {
      this.setMode('edit');
      modeNote = '작성 요청이라 편집 모드로 보냈습니다.';
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
    const skillPart =
      this.requestMode === 'ask'
        ? { prefix: '', offered: false, forced: null }
        : this.skillPrefixFor(prompt);
    this.requestSkill = { offered: skillPart.offered, forced: skillPart.forced };
    const skillPrefix = skillPart.prefix;
    if (skillPart.forced) this.log(`스킬 적용(직접 선택): ${skillPart.forced}`);
    else if (skillPart.offered) this.log(`작성 지침 목록 ${this.skills.length}개 전달 — AI가 고름`);
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

    this.streamBuffer = '';
    this.session.startRequest();
    this.setRequesting(true);
    // 진행 상태는 이 요청의 답변 버블에 적는다 — 컴포저 아래 공용 상태줄에 쓰면 응답이 와도
    // 아무도 지우지 않아 '요청 중…'이 계속 남았다. 이전 안내(첨부 완료 등)도 함께 비운다.
    this.setStatus(modeNote, 'info');
    this.setActiveStatus('요청 중…');
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

  /**
   * 차트 생성 액션(payload.type="chart")을 검증·렌더해 이미지 삽입 액션으로 바꾼다.
   * 렌더된 PNG는 pendingInsertImages에 추가되고 edit은 type="image"+image_index가 된다.
   * 실패한 편집은 script에서 제외하고 {targetId, reason}으로 반환한다(AC4).
   */
  private materializeCharts(script: ActionScript): { targetId: string; reason: string }[] {
    if (!script.edits.some((e) => e.payload.type === 'chart')) return [];
    const failures: { targetId: string; reason: string }[] = [];
    const kept: Edit[] = [];
    for (const edit of script.edits) {
      const chart = edit.payload.chart_data;
      if (edit.payload.type !== 'chart' || !chart) {
        kept.push(edit);
        continue;
      }
      const error = validateChartData(chart);
      if (error) {
        failures.push({ targetId: edit.target_id, reason: error });
        continue;
      }
      const image = renderChartToPng(chart);
      if (!image) {
        failures.push({
          targetId: edit.target_id,
          reason: '이 환경에서는 차트 캔버스 렌더를 사용할 수 없습니다.',
        });
        continue;
      }
      this.pendingInsertImages.push(image);
      edit.payload.type = 'image';
      edit.payload.image_index = this.pendingInsertImages.length - 1;
      delete edit.payload.chart_data;
      kept.push(edit);
    }
    script.edits = kept;
    return failures;
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
    this.resolveFormFill(null);
    this.setActiveStatus('취소했습니다.');
  }

  private onDelta(delta: AiStreamDelta): void {
    if (delta.requestId !== this.requestId || !this.active) return;
    // Raw 응답(Action Script JSON)을 그대로 보여주면 혼란스럽지만, 그 안의
    // payload.text들은 곧 'AI가 쓰고 있는 본문'이다 — Cursor처럼 완성된 문장부터
    // 실시간으로 흘려보여준다. 아직 본문이 없으면 점 애니메이션을 유지한다.
    this.streamBuffer += delta.partialText;
    const texts = extractGeneratedTexts(this.streamBuffer);
    if (!texts.length) {
      if (!this.active.streamEl.querySelector('.hop-ai-thinking')) this.showThinking(this.active);
      return;
    }
    this.active.streamEl.textContent = `${texts.join('\n\n')} ▌`;
    this.scrollThreadToEnd();
  }

  private async onReady(ready: AiEditReady): Promise<void> {
    if (ready.requestId !== this.requestId || !this.active) return;
    // 같은 요청의 ready 이벤트가 두 번 와도 한 번만 처리(이중 적용 방지).
    this.requestId = null;
    // 양식 이어쓰기: 응답은 Action Script가 아니라 form-fill JSON({entries})이다 — 파싱·적용은
    // runFormFill 루프가 한다(앱이 표를 결정적 복제). 원문을 그대로 넘긴다.
    if (this.requestMode === 'form_fill') {
      this.active.streamEl.textContent = '';
      this.session.complete();
      this.resolveFormFill(ready.actionScriptJson);
      return;
    }
    // 교정 패스는 구간 루프가 끝날 때까지 요청 중 상태(취소 버튼)를 유지한다.
    if (this.requestMode !== 'proofread') this.setRequesting(false);
    this.active.streamEl.textContent = '';
    const script = parseActionScript(ready.actionScriptJson);
    if (!script) {
      this.log(`응답 파싱 실패. 원문 일부: ${ready.actionScriptJson.slice(0, 300)}`);
      this.session.onFailed();
      this.setActiveStatus(interpretAiFailure('PARSE_ERROR'), 'error');
      this.resolveProofread(null);
      this.resolveFormFill(null);
      return;
    }
    // 교정 패스: 적용하지 않고 응답을 루프(runProofread)에 넘긴다.
    if (this.requestMode === 'proofread') {
      this.session.complete();
      this.resolveProofread(script);
      return;
    }
    // AI가 따른 글쓰기 지침을 답변에 표시한다(F-fb6592e9).
    this.renderSkillChip(this.active, script.skill);
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
    // 차트 생성 액션 → 캔버스로 PNG 렌더 후 이미지 삽입 액션으로 변환(F-d0dce3).
    // 데이터가 숫자가 아니거나 렌더 불가면 해당 편집을 제외하고 사유를 알린다.
    const chartIssues = this.materializeCharts(script);
    if (chartIssues.length) {
      this.log(
        `차트 변환 실패 ${chartIssues.length}건: ${chartIssues.map((c) => c.reason).join(' / ')}`,
      );
    }
    // 질문/요약 모드이거나 편집이 없으면, 문서를 건드리지 않고 답변만 표시한다(Copilot의 'Ask').
    if (this.requestMode === 'ask' || script.edits.length === 0) {
      this.session.complete();
      const answer =
        script.message?.trim() ||
        (this.requestMode === 'ask'
          ? '(응답이 비어 있습니다.)'
          : chartIssues.length
            ? `차트를 만들지 못했습니다 — ${chartIssues[0].reason}`
            : '바꿀 내용이 없습니다.');
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
    this.resolvedEdits = new Set();
    this.inlineFocus = 0;
    if (this.active && script.message) this.active.msgEl.textContent = script.message;
    this.recordMessage('assistant', script.message?.trim() || `편집 ${script.edits.length}건을 제안했습니다.`);
    this.renderDiff(script);

    // 스냅샷 가능(데스크톱)하면 승인 전 "미리 적용"해 문서에 바로 반영하고, 거절 시
    // 스냅샷으로 되돌린다(Cursor/변경내용추적 방식). 불가하면 가상 미리보기로 폴백.
    if (this.snapshotDocument()) {
      const result = applyActionScript(this.deps.bridge, script, this.pendingInsertImages, this.compiledTheme);
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
    this.resolveFormFill(null);
  }

  /** 교정 루프가 기다리는 구간 응답을 풀어준다(완료/실패/취소 공통). */
  private resolveProofread(script: ActionScript | null): void {
    const resolve = this.proofreadResolve;
    this.proofreadResolve = null;
    resolve?.(script);
  }

  /** 양식 이어쓰기 루프가 기다리는 form-fill 응답(원문 JSON)을 풀어준다. */
  private resolveFormFill(rawJson: string | null): void {
    const resolve = this.formFillResolve;
    this.formFillResolve = null;
    resolve?.(rawJson);
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
      this.compiledTheme,
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
    // 교정은 기존 본문을 대상으로 한다 — 문서가 없으면 새로 만들지 않고 안내한다(F-d448f667).
    const guard = await this.checkSendGuards({ autoCreateDoc: false });
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

  // ── 양식 이어쓰기 (F-ae778890) ───────────────────────────────
  //
  // 핵심: AI는 표 구조를 절대 결정하지 않는다. 앱이 항목마다 소스 양식 표를 결정적으로
  // 복제(cloneTableAt)하고, AI가 준 라벨→값 내용으로 값칸만 채운다. 소스 양식 표가 없으면
  // compose 폴백 없이 거부한다(AC-0d49695d).

  /**
   * 양식 이어쓰기 오케스트레이터(runProofread 패턴):
   *  1) 소스 양식 표를 form_tables에서 식별. 없으면 거부(문서 변경 없음, no compose).
   *  2) AI에 '항목 내용 리스트'만 요청(form-fill 모드 — 응답 스키마에 표/compose 없음).
   *  3) 항목마다 소스 표를 결정적 복제하고 라벨→값칸 매핑으로 값칸을 채운다.
   */
  /**
   * 양식 이어쓰기(LLM이 내용만 만들고 표 구조는 앱이 복제).
   *
   * `skipStructured`: 호출 측이 이미 결정적 구조 변환을 시도해 실패한 경우 true —
   * 같은 파싱을 두 번 돌리지 않는다(F-5e9c6033 라우팅 경로).
   */
  private async runFormFill(skipStructured = false): Promise<void> {
    if (this.session.state === 'REQUESTING') return;
    // 연구노트형 docx 첨부가 있으면 LLM 없는 결정적 일괄 변환 경로(F-beb35fbb). 구조가
    // 연구노트가 아니면 runDocxFormFill이 false를 반환하고 아래 기존 AI 경로로 폴백한다.
    const docxAtt = skipStructured
      ? undefined
      : this.attachments.find((a) => a.path && /\.(docx|pdf)$/i.test(a.path));
    if (docxAtt?.path) {
      // 첨부를 넣고 눌렀으니 담을 문서가 없으면 만들어 준다(F-d448f667).
      const docId0 = await this.resolveDocId(true);
      if (!docId0) return;
      const handled = await this.runDocxFormFill(docId0, docxAtt.path);
      if (handled) return;
    }
    const guard = await this.checkSendGuards();
    if (!guard) return;
    const { docId, provider, baseUrl } = guard;
    if (this.session.isPending) this.session.cancel();
    // 칩 버튼으로 바로 들어와도 첨부 본문이 준비된 뒤에 보낸다.
    await this.awaitAttachmentExtraction();
    // 이 요청이 첨부를 소비한다 — 남겨 두면 다음 메시지가 같은 PDF로 다시 라우팅된다.
    const attachments = this.attachments;

    this.requestMode = 'form_fill';
    const userText = this.promptInput.value.trim() || '이 양식의 항목을 하나 더 추가해줘';
    this.appendUserTurn(userText, attachments);
    this.attachments = [];
    this.renderChips();
    this.recordMessage('user', userText);
    this.active = this.appendAssistantTurn();
    this.promptInput.value = '';
    this.setRequesting(true);
    const model = this.currentModel();
    /** 앱이 만든 양식이면 그 표 — 복제 뒤 제거할 대상(사용자 문서의 표는 건드리지 않는다). */
    let createdForm: CreatedEntryForm | null = null;
    /** 미리보기(승인/거절 대기)까지 갔는가. 아니면 앱이 만든 양식을 되돌린다. */
    let previewReady = false;
    try {
      let context = await this.deps.bridge.aiGetDocumentContext(docId, false, null, true);
      this.context = context;
      let source = this.pickSourceFormTable(context);
      if (!source) {
        // 복제할 양식 표가 없으면 앱이 기본 연구노트 양식을 만들어 소스로 쓴다(F-403700d8).
        // AC-0d49695d의 'compose 폴백 금지'는 LLM에게 표 구조를 맡기지 말라는 뜻이고,
        // 여기서 만드는 기하는 코드에 고정돼 결정적이다 — LLM은 여전히 내용만 만든다.
        const seedAt = ((): { sec: number; para: number } | null => {
          const seed = lastBodyParagraphId(context);
          return seed ? parseParagraphTarget(seed) : null;
        })();
        if (!seedAt) {
          const reason = '양식을 만들 본문 문단을 찾지 못했습니다 — 문서를 변경하지 않았습니다.';
          if (this.active) this.active.msgEl.textContent = reason;
          this.recordMessage('assistant', reason);
          this.setActiveStatus('양식 없음 — 추가하지 않았습니다.', 'warn');
          return;
        }
        // 양식을 그리기 '전'에 스냅샷을 잡는다 — 거절·실패 시 앱이 만든 빈 양식까지 되돌린다.
        if (!this.snapshotDocument()) {
          this.setActiveStatus('이 환경에서는 양식 이어쓰기를 미리 적용할 수 없습니다.', 'warn');
          return;
        }
        try {
          const created = createEntryFormTable(
            this.deps.bridge as unknown as WasmEditing,
            seedAt.sec,
            seedAt.para,
          );
          createdForm = created;
          this.log(
            `양식 표가 없어 기본 연구노트 양식을 생성했습니다 ` +
              `(sec${created.section}.p${created.paragraph}.tbl${created.controlIndex})`,
          );
          // 네이티브 컨텍스트(ai_get_document_context)는 방금 WASM에 그린 표를 모른다 —
          // 다시 읽어도 이 표는 안 보이고, 그 컨텍스트의 앵커는 표 '앞'을 가리킨다. 표 앞에
          // 삽입하면 문단 분할이 원본 좌표를 밀어 복제가 전부 실패한다(2026-08-11 실측).
          // 우리가 만든 표이니 좌표도 우리가 쥔다.
          source = created.table;
        } catch (error) {
          // 표 생성이 중간(병합·라벨 단계)에 실패해도 반쯤 그린 표를 남기지 않는다 —
          // createdForm이 아직 비어 있어 finally의 되돌리기가 동작하지 않으므로 여기서 되돌린다.
          this.revertToSnapshot();
          const reason = `기본 연구노트 양식을 만들지 못했습니다: ${String(error)}`;
          if (this.active) this.active.msgEl.textContent = reason;
          this.recordMessage('assistant', reason);
          this.setActiveStatus('양식 생성 실패 — 추가하지 않았습니다.', 'warn');
          return;
        }
      }
      const labels = formTableLabels(source);
      this.log(`양식 이어쓰기: 소스 표 sec[${source.section}].p[${source.paragraph}].tbl[${source.control_index}] (${source.rows}×${source.cols}), 라벨 ${labels.length}개`);
      this.setActiveStatus('항목 내용 생성 중…');
      // 첨부 문서의 추출 본문을 함께 넘긴다 — 지시문만 보내면 LLM이 PDF 내용을 못 봐서
      // 항목을 만들 수 없다(F-5e9c6033). 일반 전송 경로와 같은 형식으로 앞에 붙인다.
      const docText = attachmentDocText(attachments);
      // 라벨 없는 '본문 통칸'은 라벨 목록에 안 실려 LLM이 존재를 모른다 — 있으면 본문을
      // 명시적으로 요구한다. 없으면 요구하지 않는다(F-86317c64 AC-fcef045d).
      const bodyAsk = resolveBodyCell(source, new Set())
        ? '\n\n이 양식에는 라벨 없는 본문 통칸이 있습니다. 각 항목의 body 배열에 그 칸에 들어갈 ' +
          '본문 단락들을 채우세요(원소 1개 = 문단 1개). 제목·날짜 칸만 채우고 본문을 비우지 마세요.'
        : '';
      const promptWithDoc = (docText ? `${docText}\n\n${userText}` : userText) + bodyAsk;
      const rawJson = await this.requestFormFillContent(
        docId,
        provider,
        model,
        baseUrl,
        promptWithDoc,
        labels,
      );
      if (rawJson == null) return; // 실패/취소 — 상태 표시는 onFailed/cancel이 했다.

      const parsed = parseFormFillResponse(rawJson);
      const entries = parsed?.entries ?? [];
      if (!entries.length) {
        const msg = parsed?.message?.trim() || '추가할 항목 내용을 받지 못했습니다.';
        if (this.active) this.active.msgEl.textContent = msg;
        this.recordMessage('assistant', msg);
        this.setActiveStatus('추가할 항목이 없습니다.', 'warn');
        return;
      }

      // 항목마다 소스 표를 결정적 복제하는 clone_table 편집 목록(AC-6bdb1e17).
      // anchor는 표 바깥 본문 문단(.tbl 없는 마지막 sec[s].p[p]) — 새 항목을 그 뒤/새 페이지에.
      // 앱이 방금 만든 양식이면 그 표 '뒤' 문단이어야 한다 — 앞에 넣으면 분할이 소스 표를
      // 밀어내 복제가 전부 실패한다(F-86317c64 AC-f8890de9).
      const anchor = createdForm
        ? `sec[${createdForm.section}].p[${createdForm.paragraph + 1}]`
        : lastBodyParagraphId(context);
      if (!anchor) {
        const reason = '새 항목을 넣을 본문 문단을 찾지 못했습니다.';
        if (this.active) this.active.msgEl.textContent = reason;
        this.setActiveStatus(reason, 'warn');
        return;
      }
      // 앱이 방금 만든 빈 양식이면 앞에 내용이 없다 — 첫 항목까지 쪽을 나누면 첫 장이
      // 빈 페이지가 된다(F-86317c64 실측: 3항목 → 4페이지). 그때만 첫 항목을 현재 페이지에.
      const plans = buildFormFillEdits(source, entries, anchor, true, !createdForm);
      const script: ActionScript = { edits: plans.map((p) => p.edit) };
      const labelSkips = plans.flatMap((p) => p.skipped);
      if (labelSkips.length) {
        this.log(`라벨 해석 건너뜀 ${labelSkips.length}건: ${labelSkips.map((s) => `${s.label}(${s.reason})`).join(' / ')}`);
      }

      // 앱이 양식을 만들었으면 그 전에 잡은 스냅샷을 그대로 쓴다(덮어쓰면 빈 양식이 남는다).
      if (!createdForm && !this.snapshotDocument()) {
        this.setActiveStatus('이 환경에서는 양식 이어쓰기를 미리 적용할 수 없습니다.', 'warn');
        return;
      }
      const result = applyActionScript(this.deps.bridge, script, [], this.compiledTheme);
      // 앱이 만든 원본은 빈 껍데기다 — 항목을 복제한 뒤 지워 채워진 항목만 남긴다.
      // 사용자 문서의 양식 표는 대상이 아니다(createdForm일 때만). 스냅샷 안이라 거절 시 복원된다.
      if (createdForm && result.applied > 0) {
        try {
          (this.deps.bridge as unknown as WasmEditing).removeSourceFormTable?.(
            createdForm.section,
            createdForm.paragraph,
            createdForm.controlIndex,
          );
          this.log('앱이 만든 빈 양식 표 제거(채워진 항목만 남김)');
        } catch {
          /* 제거 실패는 무시 — 항목 내용은 정상이다. */
        }
        // 표 뒤/문서 끝에 남은 빈 문단 정리 — 한컴에서 빈 페이지로 흘러가는 것을 막는다.
        const cleaner = this.deps.bridge as unknown as WasmEditing;
        try {
          cleaner.removeOrphanParasBeforePageBreaks?.(createdForm.section);
          cleaner.trimTrailingParasAfterLastTable?.(createdForm.section);
        } catch {
          /* 정리 실패는 무시 — 내용은 정상이다. */
        }
      }
      this.reflowAndRender();
      this.applied = result;
      this.pendingScript = script;
      this.rejectedEdits = new Set();
      // 응답 수신 때 세션은 IDLE로 끝났다(onReady→complete). 승인/거절이 동작하려면
      // DIFF_PENDING이어야 한다 — runDocxFormFill과 같은 전이(F-c63c3a91).
      this.session.startRequest();
      if (!this.session.onReady()) return;
      previewReady = true;
      this.renderDiff(script);
      this.renderDecisionBar(script, result.changed);
      this.setPreviewEnabled(true);
      const summary =
        (createdForm ? '문서에 양식이 없어 기본 연구노트 양식을 만들고 채웠습니다. ' : '') +
        (parsed?.message?.trim() ||
          `양식 항목 ${entries.length}개를 기존 표와 동일한 구조로 추가했습니다.`);
      if (this.active) this.active.msgEl.textContent = summary;
      this.recordMessage('assistant', summary);
      const note = this.skipNote(result) + (labelSkips.length ? ` · 라벨 ${labelSkips.length}건 미해석` : '');
      const tone = result.applied === 0 ? 'warn' : 'info';
      this.setActiveStatus(`항목 ${result.applied}개 미리 추가${note} — 승인 또는 거절하세요.`, tone);
    } catch (error) {
      this.setActiveStatus(`양식 이어쓰기 실패: ${String(error)}`, 'error');
    } finally {
      // 앱이 양식을 만들었는데 미리보기까지 못 갔으면(취소·항목 0개·오류) 빈 양식을 남기지 않는다.
      if (createdForm && !previewReady) this.revertToSnapshot();
      this.setRequesting(false);
    }
  }

  /**
   * 연구노트 docx → 양식 일괄 변환(LLM 없음, F-beb35fbb). docx를 구조로 파싱해 각 항목을
   * 양식 항목으로 매핑하고, 엔트리 양식 표를 항목마다 결정적 복제·채운다(내용은 docx에서
   * 직접). 반환 true=처리함(성공 또는 명시적 거부), false=연구노트 구조가 아니라 폴백해야 함.
   */
  private async runDocxFormFill(docId: string, docxPath: string): Promise<boolean> {
    let doc;
    const isPdf = /\.pdf$/i.test(docxPath);
    try {
      // 확장자로 분기: PDF는 텍스트 줄 패턴, docx는 표 구조로 동일 스키마를 만든다.
      doc = isPdf
        ? await this.deps.bridge.aiParseResearchNotePdf(docxPath)
        : await this.deps.bridge.aiParseResearchNoteDocx(docxPath);
    } catch (e) {
      // 연구노트형 문서가 아님 → 호출 측이 기존 AI 경로로 폴백한다.
      this.log(`${isPdf ? 'PDF' : 'docx'} 구조 파싱 실패 → AI 경로로 폴백: ${String(e)}`);
      return false;
    }
    const allEntries = doc.entries ?? [];
    // 부분 선택(F-docx-select): 지시문에 "3~7번"·"처음 5개" 같은 선택이 있으면 그 항목만
    // 변환한다. 선택이 없으면 전체. 목차도 선택분에 맞춰 거른다(원래 일련번호 보존).
    const promptText = this.promptInput.value.trim();
    const selection = parseEntrySelection(promptText, allEntries.length);
    const entries = selection
      ? allEntries.filter((_, i) => selection.has(i + 1))
      : allEntries;
    const selectedToc = selection
      ? (doc.toc ?? []).filter((_, i) => selection.has(i + 1))
      : (doc.toc ?? []);

    this.requestMode = 'form_fill';
    const userText =
      promptText || '첨부한 연구노트 docx의 항목들을 이 양식으로 변환해줘';
    if (selection) {
      this.log(`부분 선택: 전체 ${allEntries.length}개 중 ${entries.length}개만 변환 (${[...selection].sort((a, b) => a - b).join(',')}번)`);
    }
    this.appendUserTurn(userText, this.attachments);
    this.recordMessage('user', userText);
    this.active = this.appendAssistantTurn();
    this.promptInput.value = '';
    this.attachments = [];
    this.setRequesting(true);
    // 세션 머신 전이(F-c63c3a91): accept()/reject()는 DIFF_PENDING에서만 동작하므로,
    // 결정적 경로도 IDLE→REQUESTING(startRequest)→DIFF_PENDING(onReady)로 전이시켜야
    // 승인이 문서에 반영된다. 미확정 Diff가 있으면 먼저 정리한다.
    if (this.session.isPending) this.session.cancel();
    this.session.startRequest();
    try {
      // AC-unwanted: 항목 0개면 거부(문서 변경 없음). parse가 항목을 못 찾으면 Err를 던지므로
      // 여기 도달하면 보통 entries>0이지만, 방어적으로 한 번 더 본다.
      if (!entries.length) {
        const reason = 'docx에서 연구노트 항목을 찾지 못했습니다 — 문서를 변경하지 않았습니다.';
        if (this.active) this.active.msgEl.textContent = reason;
        this.recordMessage('assistant', reason);
        this.setActiveStatus(reason, 'warn');
        this.session.onFailed();
        return true;
      }
      let context = await this.deps.bridge.aiGetDocumentContext(docId, false, null, true);
      this.context = context;
      let tables = (context.document_metadata.form_tables ?? []) as FormSourceTable[];
      let source = pickEntryFormTable(tables);
      let createdForm = false;
      if (!source) {
        // 엔트리 양식 표가 없으면 앱이 기본 연구노트 양식을 만들어 소스로 쓴다(F-403700d8).
        // 'compose 금지'는 LLM이 표 구조를 정하지 말라는 뜻이고, 여기서 만드는 기하는
        // 코드에 고정돼 결정적이므로 그 원칙과 충돌하지 않는다. 만든 표는 아래에서 기존
        // 소스와 똑같이 복제·제거된다.
        const seed = lastBodyParagraphId(context);
        const seedAt = seed ? parseParagraphTarget(seed) : null;
        if (!seedAt) {
          const reason = '양식을 만들 본문 문단을 찾지 못했습니다 — 문서를 변경하지 않았습니다.';
          if (this.active) this.active.msgEl.textContent = reason;
          this.recordMessage('assistant', reason);
          this.setActiveStatus(reason, 'warn');
          this.session.onFailed();
          return true;
        }
        // 양식을 그리기 '전'에 스냅샷 — 거절하면 빈 양식이 아니라 원래 문서로 돌아간다.
        if (!this.snapshotDocument()) {
          this.setActiveStatus('이 환경에서는 양식 변환을 미리 적용할 수 없습니다.', 'warn');
          this.session.onFailed();
          return true;
        }
        try {
          const created = createEntryFormTable(
            this.deps.bridge as unknown as WasmEditing,
            seedAt.sec,
            seedAt.para,
          );
          source = created.table;
          createdForm = true;
          this.log(
            `양식 표가 없어 기본 연구노트 양식을 생성했습니다 ` +
              `(sec${created.section}.p${created.paragraph}.tbl${created.controlIndex}, ${created.table.rows}×${created.table.cols})`,
          );
          // 표가 문서에 들어갔으므로 앵커·양식 목록을 다시 읽는다. 새로 만든 표보다
          // 뒤에 앵커가 잡혀야 복제본이 소스 뒤로 들어가 좌표가 유효하다.
          context = await this.deps.bridge.aiGetDocumentContext(docId, false, null, true);
          this.context = context;
          tables = (context.document_metadata.form_tables ?? []) as FormSourceTable[];
          source = pickEntryFormTable(tables) ?? created.table;
        } catch (error) {
          // 표 생성이 중간에 실패해도(병합·라벨 단계) 반쯤 그린 표를 남기지 않는다.
          this.revertToSnapshot();
          const reason = `기본 연구노트 양식을 만들지 못했습니다: ${String(error)}`;
          if (this.active) this.active.msgEl.textContent = reason;
          this.recordMessage('assistant', reason);
          this.setActiveStatus(reason, 'warn');
          this.session.onFailed();
          return true;
        }
      }
      const anchor = lastBodyParagraphId(context);
      if (!anchor) {
        if (createdForm) this.revertToSnapshot();
        const reason = '새 항목을 넣을 본문 문단을 찾지 못했습니다.';
        if (this.active) this.active.msgEl.textContent = reason;
        this.setActiveStatus(reason, 'warn');
        this.session.onFailed();
        return true;
      }
      this.log(
        `docx 일괄 변환: 항목 ${entries.length}개, 엔트리 양식 sec[${source.section}].p[${source.paragraph}].tbl[${source.control_index}] (${source.rows}×${source.cols})`,
      );
      const fillEntries = entries.map(entryRecordToFormFillEntry);
      // page_break=true(기본): 항목마다 새 페이지에서 시작(1항목=1페이지). applyActionScript의
      // clone_table 경로가 쪽나누기 후 고아 빈 문단을 삭제하므로 항목 사이 빈 페이지는 없다(F-32a1a7d2).
      const plans = buildFormFillEdits(source, fillEntries, anchor);
      // 목차 재생성(F-9a5045da): 파싱된 목차로 HWP 목차 표를 '하나의 표'로 재구성한다(정상 HWP
      // 형태 — 표에 "쪽 경계에서 나눔(행 단위)"이 켜져 있어 한글이 페이지 경계에서 자동 분할).
      // 임의 페이지 청킹은 제거. 한 표 자동분할이 한컴에서 안 풀리면 rhwp 직렬화 과제로 둔다.
      const tocTable = pickTocTable(tables);
      const tocItems = selectedToc.map((t, i) => ({ no: t.no || String(i + 1), title: t.title }));
      const tocEdits = buildTocRegenEdits(tocTable, tocItems);
      const script: ActionScript = { edits: [...plans.map((p) => p.edit), ...tocEdits] };
      const skips = plans.flatMap((p) => p.skipped);
      if (tocEdits.length) this.log(`목차 재생성: ${tocItems.length}개 항목으로 목차 표 재구성`);
      if (skips.length) {
        this.log(`셀 매핑 건너뜀 ${skips.length}건: ${skips.map((s) => `${s.label}(${s.reason})`).join(' / ')}`);
      }

      // 앱이 양식을 만들었으면 그 전에 잡은 스냅샷을 그대로 쓴다(덮어쓰면 빈 양식이 남는다).
      if (!createdForm && !this.snapshotDocument()) {
        this.setActiveStatus('이 환경에서는 양식 변환을 미리 적용할 수 없습니다.', 'warn');
        this.session.onFailed();
        return true;
      }
      const result = applyActionScript(this.deps.bridge, script, [], this.compiledTheme);
      // 표지 채움(F-cover-fill): docx 표지 메타(관리번호·기관/과제 정보·기록자 명단)를
      // HWP 표지 표에 직접 채운다. 표지 표가 없거나 cover 미추출이면 no-op. snapshot 안.
      if (doc.cover) {
        const coverRes = applyCoverFill(
          this.deps.bridge as unknown as WasmEditing,
          pickCoverTable(tables),
          pickCoverHeaderTable(tables),
          doc.cover,
        );
        if (coverRes.filled > 0) this.log(`표지 채움: ${coverRes.filled}개 칸 갱신(기록자 ${doc.cover.recorders.length}명)`);
        if (coverRes.skipped.length) {
          this.log(`표지 건너뜀 ${coverRes.skipped.length}건: ${coverRes.skipped.map((s) => `${s.label}(${s.reason})`).join(' / ')}`);
        }
      }
      // 목차 표를 자유배치(treatAsChar=false) + 행 단위 쪽나눔(pageBreak=2) + 위아래 배치로 —
      // 46행이 한 페이지를 넘으면 다음 페이지로 행 경계에서 이어진다(F-form-fill-page-layout).
      // 핵심: 글자처럼취급(treatAsChar=true) 표는 인라인이라 페이지 경계에서 안 나뉘고 클립되므로
      // treatAsChar=false 가 필수다(검증: TAC=true → 1페이지 클립, false → 3페이지 흐름).
      // snapshot 안이라 거절 시 복원된다.
      if (tocTable && tocEdits.length) {
        try {
          (this.deps.bridge as unknown as WasmEditing).setTableProperties?.(
            tocTable.section,
            tocTable.paragraph,
            tocTable.control_index,
            { pageBreak: 2, treatAsChar: false, textWrap: 'TopAndBottom' },
          );
        } catch {
          /* 표 속성 설정 실패는 무시(목차 내용은 정상) */
        }
      }
      // 표 복제 시 표 뒤에 남는 빈 문단이 페이지를 가득 채운 표 다음으로 흘러 한컴에서
      // 빈 페이지를 만든다(hop 뷰어는 흡수, 한컴은 빈 페이지 표시 — 고객은 한컴으로 봄).
      // 다음이 쪽 나누기라 불필요하므로 제거한다(검증: 92→50쪽, 표 전부 보존). snapshot 안.
      {
        const sections = new Set<number>([source.section]);
        const m = /sec\[(\d+)\]/.exec(anchor);
        if (m) sections.add(Number(m[1]));
        const obridge = this.deps.bridge as unknown as WasmEditing;
        let removedTotal = 0;
        for (const s of sections) {
          try {
            removedTotal += obridge.removeOrphanParasBeforePageBreaks?.(s)?.removed ?? 0;
          } catch {
            /* 정리 실패는 무시(내용은 정상) */
          }
        }
        if (removedTotal > 0) this.log(`빈 페이지 제거: 표 뒤 빈 문단 ${removedTotal}개 정리(한컴 빈 페이지 방지)`);
      }
      // 원본 양식(샘플) 표 제거: 항목마다 복제하므로 원본은 빈 샘플로 남는다(첫 항목 앞 페이지).
      // 그 표 + 바로 뒤 쪽 나누기를 제거해 첫 항목이 첫 페이지에서 시작하게 한다. 복제는
      // 원본보다 뒤(높은 문단 인덱스)에 삽입되므로 source 좌표는 그대로 유효하다. snapshot 안.
      try {
        const r = (this.deps.bridge as unknown as WasmEditing).removeSourceFormTable?.(
          source.section,
          source.paragraph,
          source.control_index,
        );
        if (r) this.log('원본 빈 양식 표 제거(첫 항목이 첫 페이지에서 시작)');
      } catch {
        /* 원본 표 제거 실패는 무시(항목 내용은 정상) */
      }
      // 구역 끝 '마지막 표 뒤' 빈 문단 제거 — 페이지를 꽉 채운 마지막 항목 표 뒤 빈 줄이
      // 다음 페이지로 밀려 문서 끝에 빈 페이지가 남는 것을 막는다(2026-07 실측). snapshot 안.
      try {
        const t = (this.deps.bridge as unknown as WasmEditing).trimTrailingParasAfterLastTable?.(
          source.section,
        );
        if (t && t.removed > 0) this.log(`문서 끝 빈 문단 ${t.removed}개 정리(끝 빈 페이지 방지)`);
      } catch {
        /* 정리 실패는 무시(내용은 정상) */
      }
      // NOTE: 빈 선행 문단 압축(compactLeadingParasBeforeTables)은 첫 항목 밀림을 못 고쳤고,
      // DocInfo에 글자모양을 추가해 엄격한 한컴 오피스(윈도우)가 '파일 손상'으로 거부하게 만들어
      // 제거했다. 첫 항목 밀림은 removeSourceFormTable의 '첫 표 흡수'(absorbedFirstTable)로 해결.
      this.reflowAndRender();
      this.applied = result;
      this.pendingScript = script;
      this.rejectedEdits = new Set();
      // REQUESTING→DIFF_PENDING: 이제 accept()/reject()가 유효하다(F-c63c3a91).
      if (!this.session.onReady()) return true;
      this.renderDiff(script);
      this.renderDecisionBar(script, result.changed);
      this.setPreviewEnabled(true);
      const summary =
        (createdForm ? '문서에 연구노트 양식이 없어 기본 양식을 만들고 채웠습니다. ' : '') +
        `연구노트 ${entries.length}개 항목을 양식으로 변환해 추가했습니다(미리보기).` +
        (tocEdits.length ? ` 목차도 ${tocItems.length}개로 재구성했습니다.` : '');
      if (this.active) this.active.msgEl.textContent = summary;
      this.recordMessage('assistant', summary);
      const note = this.skipNote(result) + (skips.length ? ` · 셀 ${skips.length}건 미해석` : '');
      const tone = result.applied === 0 ? 'warn' : 'info';
      this.setActiveStatus(`항목 ${result.applied}개 미리 추가${note} — 승인 또는 거절하세요.`, tone);
      return true;
    } catch (error) {
      // 실패하면 이 실행이 바꾼 문서(앱이 만든 양식·일부 복제)를 스냅샷 시점으로 되돌린다.
      // 미리보기까지 갔다면 세션 취소가 롤백(스냅샷 복원)을 맡는다.
      if (this.session.isPending) {
        this.session.cancel();
      } else {
        if (this.snapshot) this.revertToSnapshot();
        this.session.onFailed();
      }
      this.setActiveStatus(`docx 일괄 변환 실패: ${String(error)}`, 'error');
      return true;
    } finally {
      this.setRequesting(false);
    }
  }

  /**
   * 복제할 소스 양식 표를 고른다. 커서가 양식 표 안/근처면 그 표를, 아니면 첫 양식 표를
   * 고른다(가장 단순한 안전한 선택). form_tables가 비어 있으면 null(→ 거부).
   */
  private pickSourceFormTable(context: DocumentContext): FormSourceTable | null {
    const tables = context.document_metadata.form_tables ?? [];
    if (!tables.length) return null;
    return tables[0] as FormSourceTable;
  }

  /** 양식 이어쓰기 요청(content-only 모드)을 보내고 응답 원문 JSON(또는 실패 시 null)을 기다린다. */
  private requestFormFillContent(
    docId: string,
    provider: string,
    model: string,
    baseUrl: string | null,
    userText: string,
    labels: string[],
  ): Promise<string | null> {
    return new Promise((resolve) => {
      this.formFillResolve = resolve;
      this.session.startRequest();
      this.deps.bridge
        .aiRequestEdit(docId, userText, provider, model, null, baseUrl, null, null, null, null, labels)
        .then((requestId) => {
          this.requestId = requestId;
        })
        .catch((error) => {
          this.session.onFailed();
          this.setActiveStatus(`요청 실패: ${String(error)}`, 'error');
          this.resolveFormFill(null);
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
    const result = applyActionScript(this.deps.bridge, { edits: [edit] }, [], this.compiledTheme);
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
    applyBtn.textContent = '적용됨';
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
    // '수정' — Cursor식 인라인 편집: 말풍선이 입력창으로 바뀌고, 보내면 이 지점부터
    // 대화를 다시 시작한다(아래 메시지들은 제거).
    const editBtn = iconButton('hop-ai-msg-edit', 'pencil', '수정');
    editBtn.title = '이 메시지를 고쳐 여기서부터 다시 보냅니다(아래 대화는 지워집니다)';
    editBtn.addEventListener('click', () => this.beginEditMessage(bubble, body, text));
    bubble.appendChild(editBtn);
    if (attachments.length) {
      const chips = el('div', 'hop-ai-msg-chips');
      for (const a of attachments) {
        const chip = el('span', 'hop-ai-chip');
        chip.append(icon(a.kind === 'image' ? 'image' : 'file'), textSpan('hop-ai-chip-label', a.name));
        chips.appendChild(chip);
      }
      bubble.appendChild(chips);
    }
    this.thread.appendChild(bubble);
    this.scrollThreadToEnd();
  }

  /** 말풍선을 그 자리에서 입력창으로 바꾼다(Cursor식). 보내기/취소 버튼 포함. */
  private beginEditMessage(bubble: HTMLElement, bodyEl: HTMLElement, originalText: string): void {
    if (bubble.querySelector('.hop-ai-msg-editor')) return; // 이미 편집 중.
    bodyEl.classList.add('hop-ai-hidden');
    const editor = el('div', 'hop-ai-msg-editor');
    const input = document.createElement('textarea');
    input.className = 'hop-ai-msg-editbox';
    input.value = originalText;
    input.rows = Math.min(6, Math.max(2, originalText.split('\n').length + 1));
    const actions = el('div', 'hop-ai-msg-edit-actions');
    const sendBtn = btn('hop-ai-msg-edit-send', '보내기');
    sendBtn.title = '여기서부터 대화를 다시 시작합니다(아래 대화는 지워집니다)';
    sendBtn.addEventListener('click', () => {
      const newText = input.value.trim();
      if (!newText) return;
      void this.resendEditedMessage(bubble, newText);
    });
    const cancelBtn = btn('hop-ai-msg-edit-cancel', '취소');
    cancelBtn.addEventListener('click', () => {
      editor.remove();
      bodyEl.classList.remove('hop-ai-hidden');
    });
    actions.append(sendBtn, cancelBtn);
    editor.append(input, actions);
    bubble.appendChild(editor);
    input.focus?.();
  }

  /**
   * 수정한 메시지를 그 지점부터 다시 보낸다 — 해당 말풍선 이후(본인 포함)의 대화를
   * DOM·저장소에서 제거하고, 새 텍스트로 send()를 다시 탄다(Cursor IDE와 동일).
   */
  private async resendEditedMessage(bubble: HTMLElement, newText: string): Promise<void> {
    // 진행 중 요청/미확정 편집 정리 — 이후 응답이 지워진 스레드에 붙지 않게 한다.
    if (this.requestId) {
      try {
        await this.deps.bridge.aiCancelRequest(this.requestId);
      } catch {
        /* 취소 실패는 무시 */
      }
    }
    this.session.cancel();
    this.requestId = null;
    this.active = null;
    this.resolveProofread(null);

    const conv = this.activeConv;
    const children = Array.from(conv.thread.children) as HTMLElement[];
    const pos = children.indexOf(bubble);
    if (pos >= 0) {
      // 이 말풍선 앞의 사용자 말풍선 수 = 유지할 user 메시지 수. 저장 메시지는
      // (그 수 + 1)번째 user 메시지 직전까지 자른다(실패한 어시스턴트 턴처럼
      // 기록이 없는 말풍선이 있어도 안전).
      const keepUsers = children
        .slice(0, pos)
        .filter((c) => c.classList.contains('hop-ai-msg-user')).length;
      let seenUsers = 0;
      let cut = conv.messages.length;
      for (let i = 0; i < conv.messages.length; i += 1) {
        if (conv.messages[i].role === 'user') {
          if (seenUsers === keepUsers) {
            cut = i;
            break;
          }
          seenUsers += 1;
        }
      }
      conv.messages = conv.messages.slice(0, cut);
      for (const node of children.slice(pos)) node.remove();
      upsertConversation({
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: Date.now(),
        messages: conv.messages,
      });
    }
    this.promptInput.value = newText;
    await this.send();
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
    const skillEl = el('div', 'hop-ai-skill');
    bubble.append(streamEl, skillEl, msgEl, bodyEl, decision, statusEl);
    this.thread.appendChild(bubble);
    this.scrollThreadToEnd();
    const turn: ActiveTurn = {
      streamEl,
      msgEl,
      bodyEl,
      decisionEl: decision,
      acceptBtn,
      rejectBtn,
      statusEl,
      skillEl,
    };
    this.setPreviewEnabledFor(turn, false);
    this.showThinking(turn);
    return turn;
  }

  /** 응답 첫 글자가 오기 전까지 '생각 중 · N초'를 보여준다(점 애니메이션 + 경과 시간). */
  private showThinking(turn: ActiveTurn): void {
    const wrap = el('span', 'hop-ai-thinking');
    wrap.setAttribute('role', 'status');
    wrap.setAttribute('aria-label', 'AI가 생각 중입니다');
    const dots = el('span', 'hop-ai-thinking-dots');
    for (let i = 0; i < 3; i += 1) dots.appendChild(el('span', 'hop-ai-thinking-dot'));
    const label = textSpan('hop-ai-thinking-label', '생각 중');
    wrap.append(dots, label);
    turn.streamEl.replaceChildren(wrap);
    this.stopThinkingTimer();
    const started = Date.now();
    this.thinkingTimer = setInterval(() => {
      // 본문이 흐르기 시작했거나 응답이 끝나 표시가 사라졌으면 멈춘다.
      if (!turn.streamEl.contains(wrap)) {
        this.stopThinkingTimer();
        return;
      }
      const sec = Math.floor((Date.now() - started) / 1000);
      label.textContent = sec > 0 ? `생각 중 · ${sec}초` : '생각 중';
    }, 1000);
  }

  private stopThinkingTimer(): void {
    if (this.thinkingTimer !== null) clearInterval(this.thinkingTimer);
    this.thinkingTimer = null;
  }

  private scrollThreadToEnd(): void {
    this.thread.scrollTop = this.thread.scrollHeight;
  }

  // ── 첨부 ─────────────────────────────────────────────────────

  /** 이미지·문서 공용 파일 입력에서 종류를 판별해 첨부한다(웹/테스트 폴백 경로). */
  private async onFilesPicked(): Promise<void> {
    const files = Array.from(this.fileInput.files ?? []);
    for (const file of files) {
      if (file.type.startsWith('image/')) await this.addImageFile(file);
      else await this.addPickedDoc(file);
    }
    this.fileInput.value = '';
  }

  private async addPickedDoc(file: File): Promise<void> {
    if (/\.(pdf|hwp|hwpx|docx)$/i.test(file.name) || file.type === 'application/pdf') {
      // 네이티브 텍스트 추출은 파일 경로가 필요하다 — 파일 선택엔 경로가 없다.
      this.setStatus('PDF/HWP/HWPX/DOCX는 드래그&드롭으로 첨부하세요.', 'warn');
    } else {
      await this.addDocFile(file);
    }
  }

  /**
   * 첨부(F-157aa77d): Tauri 네이티브 open 다이얼로그로 파일 경로를 받아 attachPaths로
   * 첨부한다 — 경로가 있어 이미지는 물론 docx/pdf/hwp/hwpx도 추출·첨부된다(파일 입력의
   * '경로 없음' 거부 회피). Tauri 런타임이 아니면(웹/테스트) HTML 파일 입력으로 폴백한다.
   */
  private async pickFilesViaDialog(): Promise<void> {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: true,
        filters: [
          {
            name: '이미지·문서',
            extensions: [
              'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp',
              'pdf', 'hwp', 'hwpx', 'docx', 'txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm', 'xml',
            ],
          },
        ],
      });
      if (selected == null) return; // 사용자가 취소
      const paths = Array.isArray(selected) ? selected : [selected];
      await this.attachPaths(paths);
    } catch {
      // 웹/테스트 런타임 — 네이티브 다이얼로그 불가 → 파일 입력 폴백.
      this.fileInput.click();
    }
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
      chip.classList.toggle('hop-ai-chip-loading', !!a.loading);
      const label = el('span', 'hop-ai-chip-label');
      label.textContent = a.loading ? `${a.name} (분석 중)` : a.name;
      const remove = iconButton('hop-ai-chip-remove', 'x', `${a.name} 첨부 빼기`);
      remove.addEventListener('click', () => {
        this.attachments = this.attachments.filter((x) => x.id !== a.id);
        this.renderChips();
      });
      chip.append(icon(a.kind === 'image' ? 'image' : 'file'), label, remove);
      this.chipsArea.appendChild(chip);
    }
  }

  // ── 모델 / provider / 옵션 ───────────────────────────────────

  private onPromptKeydown(event: KeyboardEvent): void {
    // 한글 조합 중 Enter는 글자 확정용이다 — 보내지 않는다.
    if (event.isComposing) return;
    if (this.isSlashOpen()) {
      const items = this.visibleSlashItems();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (items.length) {
          const step = event.key === 'ArrowDown' ? 1 : -1;
          this.slashIndex = (this.slashIndex + step + items.length) % items.length;
          this.highlightSlash();
        }
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && items.length) {
        event.preventDefault();
        const action = items[Math.min(this.slashIndex, items.length - 1)].dataset.action;
        this.closeSlashMenu(true);
        if (action) void this.runQuickAction(action);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.closeSlashMenu();
        return;
      }
    }
    // ⌘⏎ / Ctrl+⏎는 '모두 승인'(패널 단축키) — 여기서 보내지 않는다.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) return;
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
    const item = (name: IconName, label: string, onClick: () => void, hint = ''): HTMLButtonElement => {
      const button = el('button', 'hop-ai-menu-item hop-ai-pop-item') as HTMLButtonElement;
      button.type = 'button';
      button.append(icon(name), textSpan('hop-ai-pop-label', label));
      if (hint) button.appendChild(textSpan('hop-ai-pop-hint', hint));
      button.addEventListener('click', () => {
        this.toggleMenu(false);
        onClick();
      });
      return button;
    };
    this.menu.appendChild(popGroupLabel('열린 대화'));
    // 최신 대화가 위로 오도록 역순.
    for (const conv of [...this.conversations].reverse()) {
      const convItem = item('chat', conv.tab.textContent || '새 대화', () => this.switchConversation(conv.id));
      if (conv === this.activeConv) convItem.classList.add('hop-ai-menu-item-active');
      this.menu.appendChild(convItem);
    }
    this.menu.appendChild(el('div', 'hop-ai-menu-divider hop-ai-pop-sep'));
    this.menu.append(
      item('history', '과거 대화', () => this.toggleHistory(true)),
      item('terminal', '로그 보기', () => this.openLogWindow()),
      item('folder', '스킬 폴더 열기', () => {
        void this.deps.bridge.aiOpenSkillsDir?.().then(() => this.loadSkills());
      }),
      item('folder', '테마 폴더 열기', () => {
        void this.deps.bridge.aiOpenThemesDir?.().then(() => this.loadThemes());
      }),
      // 테스트·사용자 모두 '마지막 항목 = Agent 설정'을 기대한다.
      item('gear', 'Agent 설정', () => this.toggleSettings(true)),
    );
  }

  private async onProviderChange(): Promise<void> {
    this.populateModels(this.providerSelect.value);
    await this.refreshKeyState();
  }

  private populateModels(provider: string): void {
    // 이미 조회해둔 목록이 있으면 그것을, 없으면 내장 목록을 쓴다.
    const models = this.fetchedModels.get(provider) ?? builtinModels(provider);
    const keep = this.modelSelect.value;
    this.modelSelect.replaceChildren();
    for (const model of models) this.modelSelect.appendChild(option(model, model));
    this.modelSelect.appendChild(option(CUSTOM_MODEL, '직접 입력…'));
    // 선택이 살아 있으면 유지한다(새로 고침이 사용자의 선택을 되돌리지 않게).
    this.modelSelect.value = models.includes(keep) ? keep : (models[0] ?? CUSTOM_MODEL);
    this.modelRefreshBtn.disabled = !supportsModelListing(provider);
    this.updateModelVisibility();
    if (!this.modelMenu.classList.contains('hop-ai-hidden')) this.renderModelMenu();
  }

  /**
   * provider가 지금 서비스하는 모델 목록을 조회해 드롭다운을 채운다(F-ec1f3481 AC-001).
   * 실패해도 내장 목록을 그대로 두고 사유만 알린다 — 조회는 편의 기능이다.
   */
  private async refreshModels(): Promise<void> {
    const provider = this.providerSelect.value;
    if (!supportsModelListing(provider)) {
      this.setStatus(`${provider}는 모델 목록 API가 없습니다 — CLI 별칭을 그대로 쓰세요.`, 'info');
      return;
    }
    this.modelRefreshBtn.disabled = true;
    this.setStatus('모델 목록을 불러옵니다…', 'info');
    try {
      const listed = await this.deps.bridge.aiListModels(
        provider,
        provider === CUSTOM_PROVIDER ? this.baseUrlInput.value.trim() || undefined : undefined,
      );
      const models = mergeModelList(provider, listed);
      if (!models.length) {
        this.setStatus('쓸 수 있는 모델을 찾지 못해 기본 목록을 유지합니다.', 'warn');
        return;
      }
      this.fetchedModels.set(provider, models);
      // 조회 중 사용자가 provider를 바꿨으면 화면을 건드리지 않는다.
      if (this.providerSelect.value === provider) this.populateModels(provider);
      this.setStatus(`모델 ${models.length}개를 불러왔습니다.`, 'ok');
    } catch (error) {
      this.setStatus(`모델 목록을 불러오지 못했습니다: ${String(error)}`, 'warn');
    } finally {
      this.modelRefreshBtn.disabled = !supportsModelListing(this.providerSelect.value);
    }
  }

  private updateModelVisibility(): void {
    this.modelInput.classList.toggle('hop-ai-hidden', this.modelSelect.value !== CUSTOM_MODEL);
    this.updateModelTrigger();
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
    // 어느 provider의 키인지 밝힌다 — 모달에는 provider select가 없다(F-9dbe7a25).
    const providerName = PROVIDER_LABELS[provider] ?? provider;
    this.keyLabel.textContent = `${providerName} API 키`;
    this.keyInput.placeholder = `${providerName} API 키`;
    if (!showsKey) {
      this.keylessHint.classList.add('hop-ai-hidden');
      return;
    }

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
    // 키가 정말 필요한데 없을 때만 대안을 권한다 — 문제 없을 땐 조용히 둔다.
    this.keylessHint.classList.toggle('hop-ai-hidden', present || !requiresKey);
  }

  /**
   * 키 없는 경로로 갈아탄다(F-9dbe7a25). provider select 값을 바꾸고 기존 변경 경로를
   * 그대로 태워, 모델 목록·키 줄 갱신이 한 곳에서만 일어나게 한다.
   */
  private async switchToLocalCli(): Promise<void> {
    this.providerSelect.value = CLAUDE_CLI_PROVIDER;
    await this.onProviderChange();
    this.toggleSettings(false);
    this.setStatus(
      'Claude Code (로컬 CLI)로 전환했습니다 — 터미널에 로그인된 계정을 사용하며 API 키가 필요 없습니다.',
      'ok',
    );
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
    this.active.bodyEl.appendChild(renderDiffSummary(items));
    items.forEach((item, index) => {
      const row = renderDiffItem(item);
      if (perEdit) row.querySelector('.hop-ai-diff-head')?.appendChild(this.buildEditControls(index));
      row.classList.toggle('hop-ai-diff-item-rejected', this.rejectedEdits.has(index));
      // 변경이 1건이면 처음부터 전/후를 펼쳐 둔다(선택 영역 다듬기 등).
      if (items.length === 1) row.classList.add('hop-ai-diff-open');
      // 한 줄 요약을 누르면 자세히(전/후)를 펼치고 문서의 그 위치로 이동한다.
      row.querySelector('.hop-ai-diff-head')?.addEventListener('click', (event) => {
        if ((event.target as HTMLElement | null)?.closest?.('.hop-ai-diff-controls')) return;
        row.classList.toggle('hop-ai-diff-open');
        this.jumpToTarget(item.targetId);
      });
      this.diffRows.push(row);
      this.active!.bodyEl.appendChild(row);
    });
  }

  /** diff 행의 개별 포함/제외 컨트롤. */
  private buildEditControls(index: number): HTMLElement {
    const wrap = el('div', 'hop-ai-diff-controls');
    const drop = iconButton('hop-ai-diff-drop', 'x', '이 변경만 거절');
    drop.addEventListener('click', () => this.setEditRejected(index, true));
    const keep = iconButton('hop-ai-diff-keep', 'check', '이 변경 다시 포함');
    keep.addEventListener('click', () => this.setEditRejected(index, false));
    wrap.append(drop, keep);
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
    this.resolvedEdits.delete(index);
    this.diffRows[index]?.classList.toggle('hop-ai-diff-item-rejected', rejected);
    this.diffRows[index]?.classList.remove('hop-ai-diff-item-accepted');

    const filtered = this.filteredScript(script);
    if (this.snapshot) {
      try {
        this.reloadSnapshot();
        clearInlineDiff(this.deps.scrollContent);
        const result = applyActionScript(this.deps.bridge, filtered, this.pendingInsertImages, this.compiledTheme);
        this.reflowAndRender();
        this.applied = result;
        this.renderDecisionBar(filtered, result.changed, false);
      } catch (error) {
        // 재적용 도중 오류 — 부분 적용 상태로 남기지 않고 전체 롤백한다(AC-95b4b0).
        this.session.cancel();
        this.setActiveStatus(`적용 중 오류가 나 전체를 되돌렸습니다: ${String(error)}`, 'error');
        return;
      }
    } else {
      clearInlineDiff(this.deps.scrollContent);
      this.renderInlineDiff(filtered, false);
    }
    const total = script.edits.length;
    const remain = total - this.rejectedEdits.size;
    this.updateReviewBar(true);
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
  private renderInlineDiff(script: ActionScript, scroll = true): number {
    const canvasView = this.deps.getCanvasView();
    if (!canvasView) return 0;
    const zoom = canvasView.getViewportManager().getZoom();
    const before = new Map<string, string>();
    for (const node of this.context?.content ?? []) before.set(node.id, node.text);
    const kept = this.keptEditIndices();

    const entries: InlineDiffEntry[] = [];
    for (const [i, edit] of script.edits.entries()) {
      const editIndex = kept[i] ?? i;
      if (this.resolvedEdits.has(editIndex)) continue;
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
        editIndex,
        miniLeft: pageLeft + pageWidth + 6,
      });
    }
    return this.showInline(entries, scroll);
  }

  /** 문서 위 표시 + 검토 바(모두/개별 승인·거절, 이전/다음)를 그린다. */
  private showInline(entries: InlineDiffEntry[], scroll: boolean): number {
    if (!entries.length) return 0;
    return showInlineDiff(
      { scrollContent: this.deps.scrollContent, scrollContainer: this.deps.scrollContainer },
      entries,
      {
        onAccept: () => this.accept(),
        onReject: () => this.reject(),
        onAcceptOne: (index) => this.resolveEdit(index, 'accept'),
        onRejectOne: (index) => this.resolveEdit(index, 'reject'),
      },
      { focusIndex: this.inlineFocus, scroll, onFocusChange: (index) => (this.inlineFocus = index) },
    );
  }

  /** 거절하지 않은 edit의 원래 인덱스들 — filteredScript의 i번째 편집 = 이 배열의 i번째. */
  private keptEditIndices(): number[] {
    const total = this.pendingScript?.edits.length ?? 0;
    const kept: number[] = [];
    for (let i = 0; i < total; i += 1) if (!this.rejectedEdits.has(i)) kept.push(i);
    return kept;
  }

  /**
   * 문서 위 미니 ✓/✗ — 변경 하나만 승인(표시만 걷고 적용 유지) 또는 거절(되돌림). 모든 변경을
   * 결정하면 커서처럼 자동으로 마무리한다(하나라도 남기면 승인, 전부 거절이면 거절).
   */
  private resolveEdit(index: number, decision: 'accept' | 'reject'): void {
    const script = this.pendingScript;
    if (!script || !this.session.isPending) return;
    const total = script.edits.length;
    if (decision === 'reject') {
      this.setEditRejected(index, true);
    } else {
      this.resolvedEdits.add(index);
      this.diffRows[index]?.classList.add('hop-ai-diff-item-accepted');
      this.log(`편집 ${index + 1} 개별 승인`);
    }
    if (this.rejectedEdits.size + this.resolvedEdits.size >= total) {
      if (this.rejectedEdits.size >= total) this.reject();
      else this.accept();
      return;
    }
    if (decision === 'accept') this.redrawInline();
  }

  /** 현재 미리보기 상태로 문서 위 표시를 다시 그린다(스크롤 없이). */
  private redrawInline(): void {
    const script = this.pendingScript;
    if (!script) return;
    const filtered = this.filteredScript(script);
    if (this.snapshot && this.applied) this.renderDecisionBar(filtered, this.applied.changed, false);
    else this.renderInlineDiff(filtered, false);
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
   * 낙관적 적용 직후 문서 위 검토 표시(커서식): 새/바뀐 본문 문단(정확한 최종 위치 changed[])
   * 전체를 초록으로 칠하고, 사라진 원문(REPLACE/DELETE)은 그 아래 빨간 취소선 카드로 보인다.
   * 변경마다 페이지 오른쪽 바깥에 개별 ✓/✗, 문서 뷰 아래에 '변경 i / N' 검토 바를 둔다.
   * 반환: 그린 표시 수(0이면 호출 측이 버블 버튼으로 폴백).
   */
  private renderDecisionBar(script: ActionScript, changed: ChangedPara[], scroll = true): number {
    const canvasView = this.deps.getCanvasView();
    if (!canvasView) return 0;
    const zoom = canvasView.getViewportManager().getZoom();
    const beforeById = new Map<string, string>();
    for (const node of this.context?.content ?? []) beforeById.set(node.id, node.text);
    // applyActionScript에 넘긴 script(거절분 제외)의 i번째 = 원래 pendingScript의 kept[i]번째.
    const kept = this.keptEditIndices();

    const pageBox = (pageIndex: number) => {
      const page = this.deps.bridge.getPageInfo(pageIndex);
      const pageTop = canvasView.getVirtualScroll().getPageOffset(pageIndex);
      const pageWidth = page.width * zoom;
      const pageLeft = Math.max(0, (this.deps.scrollContent.clientWidth - pageWidth) / 2);
      const contentRight = pageLeft + (page.width - (page.marginRight ?? 0)) * zoom;
      const pageRight = pageLeft + pageWidth;
      return {
        page,
        pageTop,
        pageLeft,
        pageRight,
        contentLeft: pageLeft + (page.marginLeft ?? 0) * zoom,
        contentRight,
        // 개별 ✗/✓(폭 ~48px) — 종이 오른쪽 여백에 들어가면 거기, 좁으면 종이 바깥.
        miniLeft: pageRight - contentRight >= 56 ? contentRight + 8 : pageRight + 6,
      };
    };

    const entries: InlineDiffEntry[] = [];
    const marked = new Set<number>();
    // 초록 칠 — 새/바뀐 본문 문단 전체(첫 줄 위 ~ 마지막 줄 아래).
    for (const c of changed) {
      const editIndex = c.editIndex !== undefined ? (kept[c.editIndex] ?? c.editIndex) : undefined;
      if (editIndex !== undefined && this.resolvedEdits.has(editIndex)) continue;
      try {
        const start = this.deps.bridge.getCursorRect(c.sec, c.para, 0);
        let end = start;
        const length = this.deps.bridge.getParagraphLength(c.sec, c.para);
        if (length > 0) {
          try {
            end = this.deps.bridge.getCursorRect(c.sec, c.para, length);
          } catch {
            /* 끝 좌표 실패 — 첫 줄만 칠한다 */
          }
        }
        const box = pageBox(start.pageIndex);
        const top = box.pageTop + start.y * zoom;
        const lineBottom = top + start.height * zoom;
        const samePage = end.pageIndex === start.pageIndex;
        const bottom = samePage
          ? box.pageTop + (end.y + end.height) * zoom
          : box.pageTop + (box.page.height - (box.page.marginBottom ?? 0)) * zoom;
        // 칠은 본문 폭 + 왼쪽 여백 쪽으로 8px(초록 줄이 글자에 붙지 않게).
        entries.push({
          top,
          lineBottom,
          bottom,
          left: box.contentLeft - 8,
          maxWidth: box.contentRight - box.contentLeft + 8,
          block: true,
          editIndex,
          miniLeft: box.miniLeft,
        });
        // 쪽을 넘긴 문단은 다음 쪽의 이어진 부분도 칠한다.
        if (!samePage) {
          const next = pageBox(end.pageIndex);
          const nextTop = next.pageTop + (next.page.marginTop ?? 0) * zoom;
          entries.push({
            top: nextTop,
            lineBottom: nextTop,
            bottom: next.pageTop + (end.y + end.height) * zoom,
            left: next.contentLeft - 8,
            maxWidth: next.contentRight - next.contentLeft + 8,
            block: true,
            editIndex,
          });
        }
        if (editIndex !== undefined) marked.add(editIndex);
      } catch {
        /* 좌표 실패는 무시 */
      }
    }
    // 빨간 취소선 카드 — 사라진 기존 내용(REPLACE/DELETE). 표 셀처럼 changed[]에 안 잡히는
    // 변경은 줄 왼쪽 초록 표시줄로 위치를 알린다.
    script.edits.forEach((edit, i) => {
      const editIndex = kept[i] ?? i;
      if (this.resolvedEdits.has(editIndex)) return;
      const formatOnly = edit.payload.text === undefined && FORMAT_ONLY_PAYLOADS.has(edit.payload.type ?? '');
      const old =
        (edit.command === 'REPLACE' || edit.command === 'DELETE') && !formatOnly
          ? beforeById.get(edit.target_id)
          : undefined;
      const unmarked = !marked.has(editIndex);
      if (old === undefined && !unmarked) return;
      const rect = this.targetRect(edit.target_id);
      if (!rect) return;
      const box = pageBox(rect.pageIndex);
      const left = box.pageLeft + rect.x * zoom;
      const top = box.pageTop + rect.y * zoom;
      const lineBottom = box.pageTop + (rect.y + rect.height) * zoom;
      // 같은 변경의 초록 칠 아래에 원문 카드를 둔다(새 글을 가리지 않게).
      const groupBottom = entries
        .filter((e) => e.editIndex === editIndex && e.block)
        .reduce((max, e) => Math.max(max, e.bottom ?? e.lineBottom), lineBottom);
      entries.push({
        top,
        lineBottom,
        bottom: groupBottom,
        left,
        maxWidth: Math.max(120, box.contentRight - left - 4),
        before: old,
        changeBar: unmarked && edit.command !== 'DELETE',
        editIndex,
        miniLeft: unmarked ? box.miniLeft : undefined,
      });
      marked.add(editIndex);
    });
    return this.showInline(entries, scroll);
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
    const result = applyActionScript(this.deps.bridge, filtered, this.pendingInsertImages, this.compiledTheme);
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
    this.resolvedEdits = new Set();
    this.inlineFocus = 0;
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
    // 제안이 대기 중이면(enabled=true) 승인/거절을 항상 노출한다 — 페이지 위 인라인 바는
    // 보조 표시일 뿐, 좌표를 못 잡으면 안 뜰 수 있다. 화면에는 입력창 위 검토 바가
    // 보이고(커서식), 버블 안 버튼은 같은 동작의 대체 수단으로 남긴다.
    turn.decisionEl.classList.toggle('hop-ai-hidden', !enabled);
    turn.acceptBtn.disabled = !enabled;
    turn.rejectBtn.disabled = !enabled;
    if (enabled || turn === this.active || !this.active) this.updateReviewBar(enabled);
  }

  /** 입력창 위 검토 바(모두 승인/거절)를 승인 대기 상태에 맞춘다. */
  private updateReviewBar(enabled: boolean): void {
    const script = this.pendingScript;
    const show = enabled && script !== null;
    this.reviewBar.classList.toggle('hop-ai-hidden', !show);
    this.panel.classList.toggle('hop-ai-reviewing', show);
    this.reviewAcceptBtn.disabled = !show;
    this.reviewRejectBtn.disabled = !show;
    if (!show || !script) return;
    const total = script.edits.length;
    const remain = total - this.rejectedEdits.size;
    this.reviewLabel.textContent =
      remain === total ? `변경 ${total}건 검토 중` : `변경 ${remain}/${total}건 적용 예정`;
  }

  private setRequesting(active: boolean): void {
    // 생성 중에는 보내기 자리에 중지 버튼을 둔다(커서식).
    this.sendBtn.disabled = active;
    this.sendBtn.classList.toggle('hop-ai-hidden', active);
    this.cancelBtn.classList.toggle('hop-ai-hidden', !active);
    this.panel.classList.toggle('hop-ai-requesting', active);
    if (!active) this.stopThinkingTimer();
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

/**
 * 스트리밍 중인 Action Script JSON 버퍼에서 완성된 payload.text 문자열들을 추출한다.
 * (따옴표가 닫힌 값만 — 쓰다 만 문장은 다음 델타에서 완성되면 나타난다.)
 */
function extractGeneratedTexts(buffer: string): string[] {
  const out: string[] = [];
  const pattern = /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(buffer)) !== null) {
    try {
      const text = JSON.parse(`"${match[1]}"`) as string;
      if (text.trim()) out.push(text);
    } catch {
      /* 이스케이프가 깨진 조각은 건너뛴다 */
    }
  }
  return out;
}

/** 표시용 — 앞 `max`자만, 길면 말줄임표. */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 편집 명령·대상 ID를 사람이 읽는 라벨로 바꾼다(원본 ID는 title 속성으로 보존). */
function describeEdit(command: string, targetId: string): string {
  const action =
    command === 'REPLACE'
      ? '바꿈'
      : command === 'DELETE'
        ? '삭제'
        : command === 'INSERT_BEFORE'
          ? '앞에 추가'
          : '추가';
  const where = targetId.startsWith('field[')
    ? '누름틀'
    : targetId.includes('.header[')
    ? '머리말'
    : targetId.includes('.footer[')
      ? '꼬리말'
      : targetId.includes('.fn[')
        ? '각주'
        : targetId.includes('.tbl[')
          ? '표 셀'
          : '본문';
  return `${where} ${action}`;
}

/** 변경 종류 → 목록 아이콘. */
function diffIcon(item: DiffItem): IconName {
  switch (item.payloadType) {
    case 'table':
    case 'clone_table':
    case 'table_edit':
    case 'table_formula':
      return 'table';
    case 'image':
      return 'image';
    case 'chart':
      return 'chart';
    case 'format':
    case 'para_format':
    case 'page_setup':
      return 'layout';
    case 'page_number':
      return 'hash';
    case 'replace_text':
      return 'replace';
    default:
      if (item.targetId.includes('.tbl[')) return 'table';
      return 'text';
  }
}

/** 변경 목록 머리: 'N개 변경 · 추가 a · 바꿈 b · 삭제 c'. */
function renderDiffSummary(items: DiffItem[]): HTMLElement {
  const count = (cmd: (c: DiffItem['command']) => boolean) => items.filter((i) => cmd(i.command)).length;
  const added = count((c) => c === 'INSERT_AFTER' || c === 'INSERT_BEFORE');
  const changed = count((c) => c === 'REPLACE');
  const removed = count((c) => c === 'DELETE');
  const summary = el('div', 'hop-ai-diff-summary');
  summary.appendChild(textSpan('hop-ai-diff-summary-count', `변경 ${items.length}건`));
  for (const [n, label, cls] of [
    [added, '추가', 'hop-ai-diff-plus'],
    [changed, '바꿈', 'hop-ai-diff-mod'],
    [removed, '삭제', 'hop-ai-diff-minus'],
  ] as const) {
    if (n > 0) summary.appendChild(textSpan(cls, `${label} ${n}`));
  }
  return summary;
}

/** 변경 1건을 한 줄로: [아이콘] 어디·무엇 · 미리보기 … [+추가 −삭제]. 누르면 전/후가 펼쳐진다. */
function renderDiffItem(item: DiffItem): HTMLElement {
  const kind =
    item.command === 'DELETE' ? 'del' : item.command === 'REPLACE' ? 'mod' : 'add';
  const row = el('div', `hop-ai-diff-item hop-ai-diff-kind-${kind}`);
  const head = el('div', 'hop-ai-diff-head');
  head.title = `${item.command} · ${item.targetId}`;
  const preview = (item.afterText ?? item.beforeText ?? '').replace(/\s+/g, ' ').trim();
  const stat = el('span', 'hop-ai-diff-stat');
  if (item.afterText !== undefined && !item.afterText.startsWith('[')) {
    stat.appendChild(textSpan('hop-ai-diff-plus', `+${item.afterText.length}`));
  }
  if (item.beforeText) {
    stat.appendChild(textSpan('hop-ai-diff-minus', `−${item.beforeText.length}`));
  }
  head.append(
    icon(diffIcon(item)),
    textSpan('hop-ai-diff-where', describeEdit(item.command, item.targetId)),
    textSpan('hop-ai-diff-snippet', clip(preview, 80)),
    stat,
  );
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
  modeTrigger: HTMLButtonElement;
  modeMenu: HTMLElement;
  quickActions: HTMLElement;
  slashMenu: HTMLElement;
  skillSelect: HTMLSelectElement;
  themeSelect: HTMLSelectElement;
  providerSelect: HTMLSelectElement;
  modelSelect: HTMLSelectElement;
  modelInput: HTMLInputElement;
  modelRefreshBtn: HTMLButtonElement;
  modelTrigger: HTMLButtonElement;
  modelMenu: HTMLElement;
  modelProviders: HTMLElement;
  modelList: HTMLElement;
  modelKeyBtn: HTMLButtonElement;
  sendBtn: HTMLButtonElement;
  cancelBtn: HTMLButtonElement;
  statusArea: HTMLElement;
  chipsArea: HTMLElement;
  fileInput: HTMLInputElement;
  attachBtn: HTMLButtonElement;
  reviewBar: HTMLElement;
  reviewLabel: HTMLElement;
  reviewAcceptBtn: HTMLButtonElement;
  reviewRejectBtn: HTMLButtonElement;
  welcome: HTMLElement;
  settingsPanel: HTMLElement;
  keyRow: HTMLElement;
  keyLabel: HTMLElement;
  keyInput: HTMLInputElement;
  keySaveBtn: HTMLButtonElement;
  keyClearBtn: HTMLButtonElement;
  keyStatus: HTMLElement;
  keylessHint: HTMLElement;
  keylessBtn: HTMLButtonElement;
  sensitiveCheckbox: HTMLInputElement;
  customRow: HTMLElement;
  baseUrlInput: HTMLInputElement;
  presetSelect: HTMLSelectElement;
}

/** 빠른 작업(입력창에서 /). alias는 '/간결'처럼 걸러 찾을 때 쓴다. */
const QUICK_ACTIONS: { action: string; label: string; alias: string; icon: IconName; group: '선택' | '문서' }[] = [
  { action: 'concise', label: '간결하게', alias: '간결', icon: 'text', group: '선택' },
  { action: 'formal', label: '격식 있게', alias: '격식', icon: 'text', group: '선택' },
  { action: 'expand', label: '길게', alias: '길게', icon: 'text', group: '선택' },
  { action: 'grammar', label: '문법 교정', alias: '교정', icon: 'text', group: '선택' },
  { action: 'variations', label: '변형 제안', alias: '변형', icon: 'text', group: '선택' },
  { action: 'proofread', label: '전체 교정', alias: '전체교정', icon: 'file', group: '문서' },
  { action: 'summarize', label: '요약', alias: '요약', icon: 'file', group: '문서' },
  { action: 'form_fill', label: '양식 항목 추가', alias: '양식', icon: 'table', group: '문서' },
];

function buildPanel(): PanelParts {
  // 문서 위 둥근 AI 버튼은 더 이상 붙이지 않는다(툴바 AI 버튼·⌘J로 연다). 호환용으로만 만든다.
  const toggleBtn = el('button', 'hop-ai-toggle') as HTMLButtonElement;
  toggleBtn.textContent = 'AI';
  toggleBtn.title = 'AI 편집 도우미';

  const panel = el('aside', 'hop-ai-panel');
  panel.setAttribute('aria-label', 'AI 편집');

  // 헤더 한 줄: [대화 탭들 …] [새 대화] [기록] [메뉴] [닫기]
  const header = el('div', 'hop-ai-header');
  const title = el('span', 'hop-ai-title');
  title.textContent = 'AI 편집';
  const tabBar = el('div', 'hop-ai-tabbar');
  tabBar.setAttribute('role', 'tablist');
  const newChatBtn = iconButton('hop-ai-newchat', 'plus', '새 대화');
  const historyBtn = iconButton('hop-ai-history-btn', 'history', '대화 기록');
  const settingsBtn = iconButton('hop-ai-settings-btn', 'more', '메뉴 (대화 · 로그 · Agent 설정)');
  const closeBtn = iconButton('hop-ai-close', 'x', `패널 닫기 (${modKey('J')})`);
  header.append(title, tabBar, newChatBtn, historyBtn, settingsBtn, closeBtn);

  // 과거 대화 기록 드로어(패널 안 왼쪽). 기본 숨김.
  const historyPanel = el('div', 'hop-ai-history');
  historyPanel.classList.add('hop-ai-hidden');

  // 디버그 로그 패널(기본 숨김) — 새 창을 못 열 때의 폴백 표시용.
  const logPanel = el('div', 'hop-ai-log');
  logPanel.classList.add('hop-ai-hidden');

  // "⋯" 메뉴(최근 대화 + 로그·폴더·설정). 기본 숨김.
  const menu = el('div', 'hop-ai-menu hop-ai-pop');
  menu.classList.add('hop-ai-hidden');

  // 대화 스레드들을 담는 래퍼(대화마다 thread 하나, 활성만 표시).
  const threadsWrap = el('div', 'hop-ai-threads');

  // ── Agent 설정 모달 ──
  // 키 줄 — 어느 provider의 키인지 라벨로 밝히고, 좁은 모달에서 잘리지 않게
  // [라벨] / [입력] / [동작 묶음] 세 덩어리로 나눈다(F-9dbe7a25).
  const keyLabel = el('span', 'hop-ai-key-label');
  const keyInput = inputEl('hop-ai-key', 'password', 'API 키');
  keyInput.autocomplete = 'off';
  const keySaveBtn = btn('hop-ai-key-save', '키 저장');
  const keyClearBtn = btn('hop-ai-key-clear', '삭제');
  const keyStatus = el('span', 'hop-ai-key-status');
  const keyActions = el('div', 'hop-ai-key-actions');
  keyActions.append(keySaveBtn, keyClearBtn, keyStatus);
  const keyRow = el('div', 'hop-ai-key-row');
  keyRow.append(keyLabel, keyInput, keyActions);

  // 키가 없을 때만 뜨는 대안 — 구독(팀·Pro)이면 로컬 CLI로 키 없이 쓸 수 있다.
  const keylessText = el('span', 'hop-ai-keyless-text');
  keylessText.textContent =
    '구독 플랜(팀·Pro)이 있으면 키 없이 쓸 수 있습니다 — 터미널에 로그인된 Claude Code를 그대로 사용합니다.';
  const keylessBtn = btn('hop-ai-keyless-switch hop-ai-btn', 'Claude Code (로컬 CLI)로 전환');
  const keylessHint = el('div', 'hop-ai-keyless-hint');
  keylessHint.append(keylessText, keylessBtn);
  keylessHint.classList.add('hop-ai-hidden');

  const presetSelect = document.createElement('select');
  presetSelect.className = 'hop-ai-preset hop-ai-select';
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
  settingsPanel.append(customRow, keyRow, keylessHint, sensitiveRow);

  const settingsModal = el('div', 'hop-ai-modal');
  settingsModal.classList.add('hop-ai-hidden');
  const settingsCard = el('div', 'hop-ai-modal-card');
  const settingsHeader = el('div', 'hop-ai-modal-header');
  const settingsTitle = el('span', 'hop-ai-modal-title');
  settingsTitle.textContent = 'Agent 설정';
  const settingsClose = iconButton('hop-ai-modal-close', 'x', '닫기');
  settingsHeader.append(settingsTitle, settingsClose);
  settingsCard.append(settingsHeader, settingsPanel);
  settingsModal.appendChild(settingsCard);

  // ── 입력 카드 ──
  const chipsArea = el('div', 'hop-ai-chips');
  // 컨텍스트 줄 — 첨부 칩. 칩이 0건이면 줄째 숨는다(CSS :has).
  const contextRow = el('div', 'hop-ai-context-row');
  contextRow.append(chipsArea);

  const promptInput = document.createElement('textarea');
  promptInput.className = 'hop-ai-prompt';
  promptInput.rows = 2;
  promptInput.placeholder = PROMPT_PLACEHOLDER.edit;
  promptInput.setAttribute('aria-label', 'AI에게 보낼 지시');

  // 이미지·문서 공용 파일 입력(웹/테스트 폴백용). 네이티브 런타임에서는
  // pickFilesViaDialog가 경로 기반으로 첨부하므로 이 입력은 폴백 경로에서만 쓰인다.
  const fileInput = inputEl('hop-ai-file-input hop-ai-hidden', 'file', '');
  fileInput.accept = 'image/*,.pdf,.hwp,.hwpx,.docx,.txt,.md,.markdown,.csv,.json,.html,.htm,.xml';
  fileInput.multiple = true;

  // 모드(편집/질문) — 입력창 아래 드롭다운.
  const modeEditBtn = menuItemButton('hop-ai-mode-btn hop-ai-mode-active', 'pencil', '편집', '문서를 고칩니다');
  const modeAskBtn = menuItemButton('hop-ai-mode-btn', 'chat', '질문', '편집하지 않고 질문·요약에 답합니다');
  const modeMenu = el('div', 'hop-ai-pop hop-ai-mode-menu hop-ai-hidden');
  modeMenu.setAttribute('role', 'menu');
  modeMenu.append(modeEditBtn, modeAskBtn);
  const modeTrigger = el('button', 'hop-ai-mode-trigger hop-ai-dd') as HTMLButtonElement;
  modeTrigger.type = 'button';
  modeTrigger.title = '모드 — 편집 또는 질문';

  // 모델 선택 — 입력창 아래 '모델명 ▾' 하나. 실제 값은 숨은 select들이 들고 있다
  // (기존 provider/model 변경 경로·저장 동작을 그대로 쓴다).
  const providerSelect = document.createElement('select');
  providerSelect.className = 'hop-ai-provider';
  for (const id of PROVIDERS) providerSelect.appendChild(option(id, PROVIDER_LABELS[id] ?? id));
  const modelSelect = document.createElement('select');
  modelSelect.className = 'hop-ai-model-select';
  const modelInput = inputEl('hop-ai-model', 'text', '모델 ID 직접 입력');
  const modelRefreshBtn = el('button', 'hop-ai-model-refresh hop-ai-pop-item') as HTMLButtonElement;
  modelRefreshBtn.type = 'button';
  modelRefreshBtn.title = '지원 모델 목록 새로 고침 (provider에서 조회)';
  modelRefreshBtn.append(icon('refresh'), textSpan('hop-ai-pop-label', '모델 목록 새로 고침'));
  const modelKeyBtn = el('button', 'hop-ai-model-key hop-ai-pop-item') as HTMLButtonElement;
  modelKeyBtn.type = 'button';
  modelKeyBtn.append(icon('gear'), textSpan('hop-ai-pop-label', 'API 키·Agent 설정…'));
  const modelProviders = el('div', 'hop-ai-model-providers');
  const modelList = el('div', 'hop-ai-model-list');
  modelList.setAttribute('role', 'listbox');
  const hiddenSelects = el('div', 'hop-ai-sr-only');
  hiddenSelects.append(providerSelect, modelSelect);
  const modelMenu = el('div', 'hop-ai-pop hop-ai-model-menu hop-ai-hidden');
  modelMenu.append(
    popGroupLabel('제공자'),
    modelProviders,
    popGroupLabel('모델'),
    modelList,
    modelInput,
    el('div', 'hop-ai-pop-sep'),
    modelRefreshBtn,
    modelKeyBtn,
    hiddenSelects,
  );
  const modelTrigger = el('button', 'hop-ai-model-trigger hop-ai-dd') as HTMLButtonElement;
  modelTrigger.type = 'button';
  modelTrigger.title = '모델 선택';

  // 빠른 작업 — 입력창 맨 앞에서 '/'. 항목은 data-action 위임 클릭으로 실행된다.
  const quickActions = el('div', 'hop-ai-quick');
  quickActions.setAttribute('role', 'listbox');
  let lastGroup = '';
  for (const q of QUICK_ACTIONS) {
    if (q.group !== lastGroup) {
      quickActions.appendChild(popGroupLabel(q.group === '선택' ? '선택한 부분 고치기' : '문서 전체'));
      lastGroup = q.group;
    }
    const item = el('button', 'hop-ai-quick-chip hop-ai-pop-item') as HTMLButtonElement;
    item.type = 'button';
    item.dataset.action = q.action;
    item.dataset.alias = q.alias;
    item.append(icon(q.icon), textSpan('hop-ai-pop-label', q.label), textSpan('hop-ai-pop-hint', `/${q.alias}`));
    quickActions.appendChild(item);
  }
  // 글쓰기 스킬·디자인 테마 — 자주 바꾸지 않으므로 / 메뉴 아래쪽에 둔다. 런타임에 옵션 채움.
  const skillSelect = document.createElement('select');
  skillSelect.className = 'hop-ai-skill-select hop-ai-select';
  skillSelect.title = '글쓰기 스킬 — 평소엔 자동(AI가 요청에 맞는 지침을 고름). 특정 지침을 강제하거나 끌 때만 바꾸세요.';
  skillSelect.appendChild(option('auto', '스킬: 자동(AI 선택)'));
  const themeSelect = document.createElement('select');
  themeSelect.className = 'hop-ai-theme-select hop-ai-select';
  themeSelect.title = '디자인 테마 — 생성 문서의 간격·글자 크기·색 (themes/*.json)';
  const slashFoot = el('div', 'hop-ai-slash-foot');
  slashFoot.append(skillSelect, themeSelect);
  const slashMenu = el('div', 'hop-ai-pop hop-ai-slash hop-ai-hidden');
  slashMenu.append(quickActions, el('div', 'hop-ai-pop-sep'), slashFoot);

  const attachBtn = iconButton('hop-ai-attach', 'clip', '파일 첨부 (이미지·PDF·HWP·DOCX)');
  const sendBtn = iconButton('hop-ai-send', 'arrowUp', '보내기 (Enter)');
  const cancelBtn = iconButton('hop-ai-cancel', 'stop', '생성 중지 (Esc)');

  const composerLeft = el('div', 'hop-ai-composer-left');
  composerLeft.append(modeTrigger, modelTrigger);
  const composerRight = el('div', 'hop-ai-composer-right');
  composerRight.append(attachBtn, cancelBtn, sendBtn);
  const composerBar = el('div', 'hop-ai-composer-bar');
  composerBar.append(composerLeft, composerRight);

  const composerCard = el('div', 'hop-ai-composer-card');
  composerCard.append(contextRow, promptInput, composerBar, slashMenu, modeMenu, modelMenu);

  // 검토 바 — 승인 대기 동안 입력창 바로 위에 고정(커서식 'Accept all').
  const reviewLabel = el('span', 'hop-ai-review-label');
  const reviewRejectBtn = el('button', 'hop-ai-review-reject hop-ai-btn') as HTMLButtonElement;
  reviewRejectBtn.type = 'button';
  reviewRejectBtn.append(textSpan('', '모두 거절'), kbdSpan(modKey('⌫')));
  const reviewAcceptBtn = el('button', 'hop-ai-review-accept hop-ai-btn hop-ai-btn-primary') as HTMLButtonElement;
  reviewAcceptBtn.type = 'button';
  reviewAcceptBtn.append(textSpan('', '모두 승인'), kbdSpan(modKey('⏎')));
  const reviewBar = el('div', 'hop-ai-review hop-ai-hidden');
  reviewBar.setAttribute('role', 'toolbar');
  reviewBar.setAttribute('aria-label', 'AI 변경 검토');
  reviewBar.append(reviewLabel, el('span', 'hop-ai-flex'), reviewRejectBtn, reviewAcceptBtn);

  const statusArea = el('div', 'hop-ai-status');
  // 빈 대화 화면(최근 대화·자주 쓰는 작업). 대화가 시작되면 CSS로 숨는다.
  const welcome = el('div', 'hop-ai-welcome');

  const composer = el('div', 'hop-ai-composer');
  composer.append(reviewBar, composerCard, statusArea, welcome, fileInput);

  // 컴포저는 본문 영역에 두고, 빈 대화면 상단/대화 시작 시 하단으로 CSS order로 이동.
  const body = el('div', 'hop-ai-body');
  body.append(threadsWrap, composer);
  panel.append(header, menu, logPanel, historyPanel, body, settingsModal);

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
    modeTrigger,
    modeMenu,
    quickActions,
    slashMenu,
    skillSelect,
    themeSelect,
    providerSelect,
    modelSelect,
    modelInput,
    modelRefreshBtn,
    modelTrigger,
    modelMenu,
    modelProviders,
    modelList,
    modelKeyBtn,
    sendBtn,
    cancelBtn,
    statusArea,
    chipsArea,
    fileInput,
    attachBtn,
    reviewBar,
    reviewLabel,
    reviewAcceptBtn,
    reviewRejectBtn,
    welcome,
    settingsPanel,
    keyRow,
    keyLabel,
    keyInput,
    keySaveBtn,
    keyClearBtn,
    keyStatus,
    keylessHint,
    keylessBtn,
    sensitiveCheckbox,
    customRow,
    baseUrlInput,
    presetSelect,
  };
}

/** 글 내용은 그대로 두고 모양만 바꾸는 편집 — 원문을 '사라진 글'로 보이지 않는다. */
const FORMAT_ONLY_PAYLOADS = new Set<string>(['format', 'para_format', 'page_setup', 'page_number']);

/** 입력창 안내 문구(모드별). */
const PROMPT_PLACEHOLDER = {
  edit: '무엇을 쓰거나 고칠까요?  / 빠른 작업',
  ask: '문서에 대해 물어보세요 — 편집하지 않습니다',
};

/**
 * 패널에 쓰는 선 아이콘(24px 그리드, 1.7 선). 앱에 내장된 정적 SVG라 네트워크·폰트
 * 의존이 없다. 이모지·글자 기호(🕘 ＋ ⋯ ✓ ✗ ⟳)를 대신한다.
 */
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  right: '<path d="m9 6 6 6-6 6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clip: '<path d="m21.4 11-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l9.2-9.2a3.7 3.7 0 0 1 5.2 5.2l-9.2 9.2a1.8 1.8 0 0 1-2.6-2.6l8.5-8.5"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
  pencil: '<path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.6A8.4 8.4 0 1 1 21 11.5Z"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  heading: '<path d="M6 4v16M18 4v16M6 12h12"/>',
  text: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
  chart: '<path d="M3 3v18h18"/><path d="M8 17v-6M13 17V7M18 17v-3"/>',
  replace: '<path d="M4 7h11l-3-3M20 17H9l3 3"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
  refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.3L3 16"/><path d="M3 12A9 9 0 0 1 18.5 5.7L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
} as const;
type IconName = keyof typeof ICONS;

/** 선 아이콘 하나(장식용 — 의미는 버튼의 title/aria-label이 전한다). */
function icon(name: IconName): HTMLElement {
  const span = el('span', `hop-ai-ic hop-ai-ic-${name}`);
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
    `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

/** 아이콘만 있는 버튼 — 이름은 title·aria-label로 준다. */
function iconButton(className: string, name: IconName, label: string): HTMLButtonElement {
  const button = el('button', className) as HTMLButtonElement;
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.appendChild(icon(name));
  return button;
}

/** 팝오버 메뉴 항목 버튼(아이콘 + 이름 + 설명). */
function menuItemButton(className: string, name: IconName, label: string, desc: string): HTMLButtonElement {
  const button = el('button', `${className} hop-ai-pop-item`) as HTMLButtonElement;
  button.type = 'button';
  button.title = desc;
  button.append(icon(name), textSpan('hop-ai-pop-label', label), textSpan('hop-ai-pop-desc', desc));
  return button;
}

function textSpan(className: string, text: string): HTMLElement {
  const span = el('span', className);
  span.textContent = text;
  return span;
}

function kbdSpan(text: string): HTMLElement {
  const kbd = el('kbd', 'hop-ai-kbd');
  kbd.textContent = text;
  return kbd;
}

function popGroupLabel(text: string): HTMLElement {
  const label = el('div', 'hop-ai-pop-group');
  label.textContent = text;
  return label;
}

/** '방금 · N분 전 · N시간 전 · M/D' 형식의 짧은 시각. */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return '방금';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 단축키 표기 — macOS는 ⌘, 그 밖은 Ctrl+. */
function modKey(key: string): string {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform ?? '');
  return mac ? `⌘${key}` : `Ctrl+${key}`;
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

/**
 * 소스 양식 표의 '필드 라벨' 목록을 뽑는다(F-ae778890). 텍스트가 있고 role이 input이
 * 아닌 셀의 내용을 라벨로 본다(serialize.rs의 role 힌트). 중복 제거, 순서 보존. 이 목록을
 * form-fill 시스템 프롬프트에 넣어 모델이 내용을 라벨로 키잉하게 한다(AC-0cd01fc1).
 */
function formTableLabels(table: FormSourceTable): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of table.cells) {
    const t = (c.text ?? '').trim();
    if (!t || c.role === 'input') continue;
    const key = t.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/**
 * 새 항목을 넣을 anchor로 쓸 '표 바깥 본문 문단'의 마지막 ID(`sec[s].p[p]`, `.tbl` 없음)를
 * 고른다. 표 셀 안에는 표를 넣을 수 없으므로(셀은 페이지로 늘어나지 않음) 본문 문단을
 * anchor로 삼아 INSERT_AFTER + page_break로 문서 끝/새 페이지에 차례로 추가한다. 본문
 * 문단이 하나도 없으면 null.
 */
function lastBodyParagraphId(context: DocumentContext): string | null {
  let last: string | null = null;
  for (const node of context.content) {
    if (/^sec\[\d+\]\.p\[\d+\]$/.test(node.id)) last = node.id;
  }
  return last;
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
