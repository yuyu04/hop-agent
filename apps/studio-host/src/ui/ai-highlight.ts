/**
 * 승인 전 대상 문단을 페이지 위에 하이라이트한다(스펙 4장 — 휘발성 미리보기).
 *
 * `getCursorRect`(페이지 px)와 `VirtualScroll.getPageOffset` + zoom으로
 * scroll-content 좌표의 반투명 박스를 그린다. 실제 문서는 변경하지 않는다.
 * 좌표 계산이 실패해도 핵심 흐름(Accept/Reject)을 막지 않도록 방어한다.
 */

import type { CursorRect, PageInfo } from '@/core/types';

const HIGHLIGHT_ATTR = 'data-hop-ai-highlight';

export type HighlightKind = 'insert' | 'remove';

export interface HighlightTarget {
  kind: HighlightKind;
  sec: number;
  para: number;
}

export interface HighlightDeps {
  getCursorRect(sec: number, para: number, charOffset: number): CursorRect;
  getParagraphLength(sec: number, para: number): number;
  getPageInfo(pageIndex: number): PageInfo;
  getZoom(): number;
  getPageOffset(pageIndex: number): number;
  scrollContent: HTMLElement;
  scrollContainer: HTMLElement;
}

export function clearHighlights(scrollContent: HTMLElement): void {
  scrollContent.querySelectorAll(`[${HIGHLIGHT_ATTR}]`).forEach((node) => node.remove());
}

export function showHighlights(deps: HighlightDeps, targets: HighlightTarget[]): void {
  clearHighlights(deps.scrollContent);
  let firstTop: number | null = null;

  for (const target of targets) {
    try {
      const top = drawOne(deps, target);
      if (top !== null && (firstTop === null || top < firstTop)) firstTop = top;
    } catch {
      // 좌표 계산 실패는 무시한다(미리보기는 보조 수단, 사이드바 diff가 본체).
    }
  }

  if (firstTop !== null) {
    deps.scrollContainer.scrollTo({ top: Math.max(0, firstTop - 48), behavior: 'smooth' });
  }
}

/** 하이라이트 박스를 그리고 scroll-content 기준 top(px)을 반환한다. */
function drawOne(deps: HighlightDeps, target: HighlightTarget): number | null {
  const zoom = deps.getZoom();
  const start = deps.getCursorRect(target.sec, target.para, 0);
  const length = deps.getParagraphLength(target.sec, target.para);
  const end = deps.getCursorRect(target.sec, target.para, Math.max(0, length));
  const page = deps.getPageInfo(start.pageIndex);

  const pageTopPx = deps.getPageOffset(start.pageIndex);
  const pageWidthPx = page.width * zoom;
  const pageLeftPx = Math.max(0, (deps.scrollContent.clientWidth - pageWidthPx) / 2);

  const boxTop = pageTopPx + start.y * zoom;
  // 같은 문단이 여러 줄이면 시작~끝을 덮고, 한 줄이면 줄 높이만큼.
  const spans = end.pageIndex === start.pageIndex && end.y > start.y;
  const boxHeight = (spans ? end.y - start.y + end.height : start.height) * zoom;

  const box = document.createElement('div');
  box.setAttribute(HIGHLIGHT_ATTR, target.kind);
  box.className = `hop-ai-highlight hop-ai-highlight-${target.kind}`;
  box.style.position = 'absolute';
  box.style.left = `${pageLeftPx}px`;
  box.style.width = `${pageWidthPx}px`;
  box.style.top = `${boxTop}px`;
  box.style.height = `${Math.max(6, boxHeight)}px`;
  box.style.pointerEvents = 'none';
  deps.scrollContent.appendChild(box);
  return boxTop;
}
