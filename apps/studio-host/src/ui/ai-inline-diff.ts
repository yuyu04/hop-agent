/**
 * 페이지 위 인라인 Diff 오버레이(Cursor/Google Docs식, 스펙 4장 확장).
 *
 * 변경 위치마다 현재(빨강 취소선)·변경(초록) 텍스트를 겹쳐 보이고, 변경 영역
 * 상단에 떠 있는 승인/거절 바를 둔다. 실제 문서는 건드리지 않는 휘발성 표시이며,
 * 좌표 계산이 실패해도 핵심 흐름(사이드바 승인/거절)을 막지 않도록 방어한다.
 */

const ATTR = 'data-hop-ai-inline';

export interface InlineDiffEntry {
  /** scroll-content 기준 좌표(px). `top`은 대상 줄의 위, `lineBottom`은 줄 아래. */
  top: number;
  lineBottom: number;
  left: number;
  /** 카드 최대 폭(대상 위치 기준). 페이지를 가로로 다 가리지 않도록 제한한다. */
  maxWidth: number;
  /** REPLACE/DELETE에서 사라지는 원문(빨강 카드). */
  before?: string;
  /** INSERT/REPLACE로 들어오는 텍스트(초록 카드 — 가상 미리보기 폴백 모드). */
  after?: string;
  /** 낙관적 적용 모드: 새/바뀐 줄 왼쪽 여백에 얇은 초록 변경 표시줄(텍스트 안 가림). */
  changeBar?: boolean;
}

export interface InlineDiffCallbacks {
  onAccept(): void;
  onReject(): void;
}

export interface InlineDiffDeps {
  scrollContent: HTMLElement;
  scrollContainer: HTMLElement;
}

export function clearInlineDiff(scrollContent: HTMLElement): void {
  scrollContent.querySelectorAll(`[${ATTR}]`).forEach((node) => node.remove());
}

/**
 * 인라인 Diff 카드들과 떠 있는 승인/거절 바를 그린다. 변경 영역 최상단으로
 * 부드럽게 스크롤한다.
 */
/** 그린 변경 카드 수를 반환한다(0이면 호출 측이 폴백 UI를 띄울 수 있다). */
export function showInlineDiff(
  deps: InlineDiffDeps,
  entries: InlineDiffEntry[],
  callbacks: InlineDiffCallbacks,
): number {
  clearInlineDiff(deps.scrollContent);
  if (!entries.length) return 0;

  let minTop = Number.POSITIVE_INFINITY;
  let barLeft = 0;
  for (const entry of entries) {
    if (entry.top < minTop) {
      minTop = entry.top;
      barLeft = entry.left;
    }

    // 새/바뀐 줄 왼쪽에 얇은 초록 변경 표시줄(여백에 위치 — 텍스트를 가리지 않음).
    if (entry.changeBar) {
      const bar = document.createElement('div');
      bar.setAttribute(ATTR, 'changebar');
      bar.className = 'hop-ai-inline-changebar';
      bar.style.position = 'absolute';
      bar.style.left = `${Math.max(0, entry.left - 8)}px`;
      bar.style.top = `${entry.top}px`;
      bar.style.height = `${Math.max(10, entry.lineBottom - entry.top)}px`;
      bar.style.pointerEvents = 'none';
      deps.scrollContent.appendChild(bar);
    }

    // 위치/표시줄만 있고 before/after 카드가 없으면 카드 생략.
    if (entry.before === undefined && entry.after === undefined) {
      continue;
    }
    // 카드는 대상 줄 "아래"에 두어 원문을 가리지 않는다. 폭은 maxWidth로 제한.
    const card = document.createElement('div');
    card.setAttribute(ATTR, 'card');
    card.className = 'hop-ai-inline-card';
    card.style.position = 'absolute';
    card.style.left = `${entry.left}px`;
    card.style.top = `${entry.lineBottom + 2}px`;
    card.style.maxWidth = `${Math.max(120, entry.maxWidth)}px`;
    card.style.pointerEvents = 'none';

    if (entry.before !== undefined) {
      const before = document.createElement('div');
      before.className = 'hop-ai-inline-before';
      before.textContent = entry.before;
      card.appendChild(before);
    }
    if (entry.after !== undefined) {
      const after = document.createElement('div');
      after.className = 'hop-ai-inline-after';
      after.textContent = entry.after;
      card.appendChild(after);
    }
    deps.scrollContent.appendChild(card);
  }

  // 변경 영역 상단에 떠 있는 승인/거절 바(대상 위치 기준, 좁게).
  const bar = document.createElement('div');
  bar.setAttribute(ATTR, 'bar');
  bar.className = 'hop-ai-inline-bar';
  bar.style.position = 'absolute';
  bar.style.left = `${barLeft}px`;
  bar.style.top = `${Math.max(0, minTop - 30)}px`;

  const label = document.createElement('span');
  label.className = 'hop-ai-inline-label';
  label.textContent =
    entries.length > 1 ? `AI 제안 ${entries.length}건` : 'AI 제안';

  const accept = document.createElement('button');
  accept.className = 'hop-ai-inline-accept';
  accept.textContent = '✓ 승인';
  accept.addEventListener('click', () => callbacks.onAccept());

  const reject = document.createElement('button');
  reject.className = 'hop-ai-inline-reject';
  reject.textContent = '✗ 거절';
  reject.addEventListener('click', () => callbacks.onReject());

  bar.append(label, accept, reject);
  deps.scrollContent.appendChild(bar);

  deps.scrollContainer.scrollTo({ top: Math.max(0, minTop - 60), behavior: 'smooth' });
  return entries.length;
}
