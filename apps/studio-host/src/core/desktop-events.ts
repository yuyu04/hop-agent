import type { CommandDispatcher } from '@/command/dispatcher';
import type { EventBus } from '@/core/event-bus';
import { isTauriRuntime } from '@/core/bridge-factory';
import { findLatestSupportedDocumentPath, hasSupportedDocumentPath } from '@/core/document-files';
import type { DesktopBridgeApi, DesktopLoadPayload, DesktopUpdateState } from './tauri-bridge';

type DesktopRuntimeBridge = Partial<
  Pick<
    DesktopBridgeApi,
    | 'openDocumentByPath'
    | 'takePendingOpenPaths'
    | 'createNewDocumentAsync'
    | 'confirmWindowClose'
    | 'destroyCurrentWindow'
    | 'cancelAppQuit'
    | 'hasUnsavedChanges'
    | 'getUpdateState'
  >
>;

interface DesktopEventsOptions {
  bridge: unknown;
  dispatcher: CommandDispatcher;
  eventBus: EventBus;
  setMessage(message: string): void;
  onUpdateState(state: DesktopUpdateState): void;
}

interface CloseRequestEvent {
  preventDefault(): void;
}

/** 네이티브 Edit 메뉴 커맨드 → 포커스된 입력란에서 수행할 document.execCommand 이름. */
const NATIVE_EDIT_COMMANDS: Record<string, string> = {
  'edit:copy': 'copy',
  'edit:cut': 'cut',
  'edit:undo': 'undo',
  'edit:redo': 'redo',
};

/**
 * 실제 텍스트 입력(우리 UI 크롬: AI 글상자·대화상자 등)에 포커스가 있으면 그 입력란의
 * 기본 편집 동작을 수행하고 true를 반환한다. 에디터의 숨은 입력 surface(본문 직속
 * textarea/contenteditable)는 제외해 문서 복사/실행취소는 에디터 커맨드로 유지한다.
 */
function runNativeEditIfTextFieldFocused(execName: string): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  // instanceof 대신 tagName으로 판별(브라우저/테스트 환경 모두에서 안전).
  const tag = el.tagName;
  const isInput = tag === 'INPUT';
  const isTextarea = tag === 'TEXTAREA';
  const editable = el.isContentEditable === true;
  if (!isInput && !isTextarea && !editable) return false;
  // <input>은 항상 실제 UI 필드(에디터 surface는 input이 아님). textarea/contenteditable은
  // 알려진 크롬 컨테이너 안에 있을 때만 — 에디터의 숨은 surface는 body 직속이라 제외된다.
  const isChromeField =
    isInput ||
    (typeof el.closest === 'function' &&
      el.closest('.hop-ai-panel, .dialog, .dialog-overlay, [data-native-edit]') != null);
  if (!isChromeField) return false;
  try {
    document.execCommand?.(execName);
  } catch {
    /* execCommand 미지원 환경은 무시 */
  }
  return true;
}

export async function setupDesktopEvents({
  bridge,
  dispatcher,
  eventBus,
  setMessage,
  onUpdateState,
}: DesktopEventsOptions): Promise<void> {
  if (!isTauriRuntime()) return;

  const desktop = bridge as DesktopRuntimeBridge;
  const { listen } = await import('@tauri-apps/api/event');
  const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const currentWindow = getCurrentWebviewWindow();

  await listen('hop-job-progress', (event) => {
    const payload = event.payload as { message?: string };
    if (payload?.message) setMessage(payload.message);
  });

  await listen('hop-update-state', (event) => {
    onUpdateState(event.payload as DesktopUpdateState);
  });

  await currentWindow.listen('hop-menu-command', (event) => {
    const command = String(event.payload || '');
    if (!command) return;
    // 네이티브 Edit 메뉴 단축키(Cmd+C/X/Z/Shift+Z)는 macOS에서 포커스된 웹뷰
    // 입력란보다 먼저 메뉴가 가로채므로, AI 글상자 등 실제 텍스트 입력에 포커스가
    // 있으면 에디터 커맨드 대신 그 입력란의 기본 편집 동작을 수행한다.
    const nativeEdit = NATIVE_EDIT_COMMANDS[command];
    if (nativeEdit && runNativeEditIfTextFieldFocused(nativeEdit)) return;
    dispatcher.dispatch(command);
  });

  await currentWindow.listen('hop-app-quit-requested', async () => {
    await handleDesktopAppQuitRequest(desktop, setMessage);
  });

  await currentWindow.listen('hop-open-paths', async (event) => {
    const payload = event.payload as { paths?: string[] };
    const pending = await desktop.takePendingOpenPaths?.();
    await openLatestDesktopDocument({
      bridge: desktop,
      eventBus,
      paths: [...(payload.paths ?? []), ...(pending ?? [])],
      setMessage,
    });
  });

  await currentWindow.listen('tauri://drag-enter', (event) => {
    const payload = event.payload as { paths?: string[] };
    if (hasSupportedDocumentPath(payload.paths ?? [])) {
      setDesktopDragActive(true);
      setMessage('HWP/HWPX 파일을 놓으면 문서를 엽니다');
    }
  });

  await currentWindow.listen('tauri://drag-leave', () => {
    setDesktopDragActive(false);
  });

  await currentWindow.listen('tauri://drag-drop', () => {
    setDesktopDragActive(false);
  });

  await currentWindow.onCloseRequested(async (event) => {
    await handleDesktopCloseRequest(event, desktop, setMessage);
  });

  const pending = await desktop.takePendingOpenPaths?.();
  await openLatestDesktopDocument({
    bridge: desktop,
    eventBus,
    paths: pending ?? [],
    setMessage,
  });

  if (desktop.getUpdateState) {
    try {
      onUpdateState(await desktop.getUpdateState());
    } catch (error) {
      console.warn('[desktop-events] updater state hydrate failed:', error);
    }
  }
}

export async function createDesktopDocument(bridge: unknown): Promise<DesktopLoadPayload | null> {
  const desktop = bridge as DesktopRuntimeBridge;
  if (!desktop.createNewDocumentAsync) return null;
  return desktop.createNewDocumentAsync();
}

async function handleDesktopCloseRequest(
  event: CloseRequestEvent,
  desktop: DesktopRuntimeBridge,
  setMessage: (message: string) => void,
): Promise<void> {
  if (!desktop.destroyCurrentWindow) return;
  event.preventDefault();
  await confirmAndDestroyWindow(desktop, {
    context: 'close request',
    errorPrefix: '창 닫기 실패',
    setMessage,
  });
}

async function handleDesktopAppQuitRequest(
  desktop: DesktopRuntimeBridge,
  setMessage: (message: string) => void,
): Promise<void> {
  if (!desktop.destroyCurrentWindow) return;
  await confirmAndDestroyWindow(desktop, {
    context: 'app quit request',
    errorPrefix: '앱 종료 실패',
    onCancel: () => desktop.cancelAppQuit?.(),
    setMessage,
  });
}

function setDesktopDragActive(active: boolean): void {
  document.getElementById('scroll-container')?.classList.toggle('drag-over', active);
}

async function confirmAndDestroyWindow(
  desktop: DesktopRuntimeBridge,
  {
    context,
    errorPrefix,
    onCancel,
    setMessage,
  }: {
    context: string;
    errorPrefix: string;
    onCancel?: () => Promise<void> | void;
    setMessage: (message: string) => void;
  },
): Promise<void> {
  if (!desktop.destroyCurrentWindow) return;

  try {
    const canClose = desktop.confirmWindowClose ? await desktop.confirmWindowClose() : true;
    if (canClose) {
      await desktop.destroyCurrentWindow();
    } else {
      await onCancel?.();
    }
  } catch (error) {
    console.error(`[desktop-events] ${context} failed:`, error);
    if (!desktop.hasUnsavedChanges?.()) {
      await desktop.destroyCurrentWindow();
    } else {
      setMessage(`${errorPrefix}: ${error}`);
      await onCancel?.();
    }
  }
}

async function openLatestDesktopDocument({
  bridge,
  eventBus,
  paths,
  setMessage,
}: {
  bridge: DesktopRuntimeBridge;
  eventBus: EventBus;
  paths: string[];
  setMessage(message: string): void;
}): Promise<void> {
  const path = findLatestSupportedDocumentPath(paths);
  if (!path) {
    if (paths.length > 0) setMessage('HWP/HWPX 파일만 열 수 있습니다');
    return;
  }
  if (!bridge.openDocumentByPath) return;

  try {
    setMessage('파일 로딩 중...');
    const loaded = await bridge.openDocumentByPath(path);
    if (loaded) eventBus.emit('desktop-document-loaded', loaded);
  } catch (error) {
    const errMsg = `파일 로드 실패: ${error}`;
    setMessage(errMsg);
    console.error('[desktop-events] 데스크톱 파일 로드 실패:', error);
  }
}
