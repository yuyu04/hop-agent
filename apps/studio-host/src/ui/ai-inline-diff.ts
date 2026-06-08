/**
 * 페이지 위 인라인 Diff 오버레이(Cursor/Google Docs식, 스펙 4장 확장).
 *
 * 변경 위치마다 현재(빨강 취소선)·변경(초록) 텍스트를 겹쳐 보이고, 변경 영역
 * 상단에 떠 있는 승인/거절 바를 둔다. 실제 문서는 건드리지 않는 휘발성 표시이며,
 * 좌표 계산이 실패해도 핵심 흐름(사이드바 승인/거절)을 막지 않도록 방어한다.
 */

const ATTR = 'data-hop-ai-inline';

export interface InlineDiffEntry {
  /** scroll-content 기준 좌표(px). */
  top: number;
  left: number;
  width: number;
  /** REPLACE/DELETE에서 사라지는 원문(빨강). */
  before?: string;
  /** INSERT/REPLACE로 들어오는 텍스트(초록). */
  after?: string;
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
export function showInlineDiff(
  deps: InlineDiffDeps,
  entries: InlineDiffEntry[],
  callbacks: InlineDiffCallbacks,
): void {
  clearInlineDiff(deps.scrollContent);
  if (!entries.length) return;

  let minTop = Number.POSITIVE_INFINITY;
  let barLeft = 0;
  let barWidth = 0;
  for (const entry of entries) {
    const card = document.createElement('div');
    card.setAttribute(ATTR, 'card');
    card.className = 'hop-ai-inline-card';
    card.style.position = 'absolute';
    card.style.left = `${entry.left}px`;
    card.style.top = `${entry.top}px`;
    card.style.width = `${entry.width}px`;
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

    if (entry.top < minTop) {
      minTop = entry.top;
      barLeft = entry.left;
      barWidth = entry.width;
    }
  }

  // 변경 영역 상단에 떠 있는 승인/거절 바.
  const bar = document.createElement('div');
  bar.setAttribute(ATTR, 'bar');
  bar.className = 'hop-ai-inline-bar';
  bar.style.position = 'absolute';
  bar.style.left = `${barLeft}px`;
  bar.style.width = `${barWidth}px`;
  bar.style.top = `${Math.max(0, minTop - 34)}px`;

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
}
