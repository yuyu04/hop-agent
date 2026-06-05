/**
 * AI Agent 인라인 편집 — 프론트엔드 타입과 이벤트 배선(스펙 1장).
 *
 * 네이티브(Rust) `ai_*` 커맨드 및 `hop-ai-*` 이벤트와 짝을 이룬다. 타입은
 * Rust serde 직렬화 형태를 그대로 따른다:
 *  - DocumentContext: snake_case 키(serialize.rs)
 *  - 이벤트 payload: camelCase 키(mod.rs의 `rename_all = "camelCase"`)
 *  - Action Script JSON: snake_case 키(schema.rs)
 */

/** 직렬화된 콘텐츠 노드(스펙 2장). 현재 PR1은 문단만 직렬화한다. */
export interface ParagraphNode {
  type: 'paragraph';
  id: string;
  text: string;
}

export type ContentNode = ParagraphNode;

export interface DocumentContext {
  document_metadata: {
    total_sections: number;
    current_cursor_path?: string;
  };
  content: ContentNode[];
}

export type EditCommand = 'INSERT_BEFORE' | 'INSERT_AFTER' | 'REPLACE' | 'DELETE';

export interface EditPayload {
  type?: 'paragraph' | 'table';
  text?: string;
  style?: string;
  table_data?: {
    rows: number;
    cols: number;
    matrix: string[][];
  };
}

export interface Edit {
  command: EditCommand;
  target_id: string;
  payload: EditPayload;
}

export interface ActionScript {
  edits: Edit[];
}

/** `hop-ai-stream-delta` payload. */
export interface AiStreamDelta {
  requestId: string;
  partialText: string;
}

/** `hop-ai-edit-ready` payload. */
export interface AiEditReady {
  requestId: string;
  actionScriptJson: string;
}

/** `hop-ai-edit-failed` payload. */
export interface AiEditFailed {
  requestId: string;
  reason: string;
  code: AiFailureCode;
}

export type AiFailureCode =
  | 'PARSE_ERROR'
  | 'WHITELIST_VIOLATION'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PROVIDER_ERROR'
  | string;

export interface AiEventHandlers {
  onDelta?(delta: AiStreamDelta): void;
  onEditReady?(ready: AiEditReady): void;
  onEditFailed?(failed: AiEditFailed): void;
}

/** 정리(unlisten) 함수. */
export type AiEventUnsubscribe = () => void;

/**
 * `hop-ai-*` 이벤트를 구독한다. Tauri 런타임에서만 실제 리스너를 등록하고,
 * 반환된 함수를 호출하면 모두 해제한다.
 */
export async function listenAiEvents(
  handlers: AiEventHandlers,
): Promise<AiEventUnsubscribe> {
  const { listen } = await import('@tauri-apps/api/event');
  const unlisteners = await Promise.all([
    listen<AiStreamDelta>('hop-ai-stream-delta', (event) => handlers.onDelta?.(event.payload)),
    listen<AiEditReady>('hop-ai-edit-ready', (event) => handlers.onEditReady?.(event.payload)),
    listen<AiEditFailed>('hop-ai-edit-failed', (event) => handlers.onEditFailed?.(event.payload)),
  ]);
  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}

/** 실패 코드(스펙 7장)를 사용자에게 보여줄 한국어 메시지로 변환한다. */
export function interpretAiFailure(code: AiFailureCode): string {
  switch (code) {
    case 'PARSE_ERROR':
      return '편집 변환 실패: 정형화된 데이터를 수신하지 못했습니다.';
    case 'WHITELIST_VIOLATION':
      return '문서에 존재하지 않는 대상을 편집하려 했습니다. 다시 시도해 주세요.';
    case 'TIMEOUT':
      return '응답 시간이 초과되었습니다. 다시 시도해 주세요.';
    case 'CANCELLED':
      return '요청이 취소되었습니다.';
    case 'PROVIDER_ERROR':
      return 'AI 제공자 호출에 실패했습니다.';
    default:
      return '알 수 없는 오류가 발생했습니다.';
  }
}

/**
 * `hop-ai-edit-ready`의 `actionScriptJson` 문자열을 파싱한다. 형식이 어긋나면
 * `null`을 반환한다(휘발성 상태로만 두고 코어에는 적용하지 않는다).
 */
export function parseActionScript(json: string): ActionScript | null {
  try {
    const value = JSON.parse(json) as unknown;
    if (!value || typeof value !== 'object' || !Array.isArray((value as ActionScript).edits)) {
      return null;
    }
    return value as ActionScript;
  } catch {
    return null;
  }
}
