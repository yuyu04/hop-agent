/**
 * AI 대화 기록 영속 저장소.
 *
 * 사이드바의 대화는 그동안 메모리에만 있어 앱을 끄면 사라졌다. 이 모듈은 대화 목록을
 * 브라우저(webview) localStorage에 저장해 재시작 후에도 과거 대화를 다시 열 수 있게 한다.
 * 문서 내용이 아니라 '대화 텍스트'(사용자 지시 + AI 요약)만 저장한다(민감 본문 미저장).
 */

export interface StoredMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

export interface StoredConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
}

const KEY = 'hop-ai-conversations-v1';
/** 너무 커지지 않도록 최근 N개만 유지. */
const MAX_CONVERSATIONS = 100;

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 저장된 모든 대화를 최신순(updatedAt 내림차순)으로 반환한다. */
export function loadConversations(): StoredConversation[] {
  const s = storage();
  if (!s) return [];
  try {
    const raw = s.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as StoredConversation[];
    if (!Array.isArray(list)) return [];
    return list
      .filter((c) => c && typeof c.id === 'string' && Array.isArray(c.messages))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

/** 대화 하나를 upsert(있으면 갱신, 없으면 추가)한다. 메시지가 없으면 저장하지 않는다. */
export function upsertConversation(conv: StoredConversation): void {
  const s = storage();
  if (!s || !conv.messages.length) return;
  try {
    const list = loadConversations().filter((c) => c.id !== conv.id);
    list.unshift(conv);
    const trimmed = list.slice(0, MAX_CONVERSATIONS);
    s.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    /* 저장 실패(용량 초과 등)는 무시 — 기능 자체는 계속 동작 */
  }
}

/** 대화 하나를 삭제한다. */
export function deleteConversation(id: string): void {
  const s = storage();
  if (!s) return;
  try {
    const list = loadConversations().filter((c) => c.id !== id);
    s.setItem(KEY, JSON.stringify(list));
  } catch {
    /* 무시 */
  }
}

/** 전체 기록을 비운다. */
export function clearConversations(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(KEY);
  } catch {
    /* 무시 */
  }
}
