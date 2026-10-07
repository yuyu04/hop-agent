/**
 * 페이지 위 인라인 Diff 오버레이(Cursor식 문서 내 검토, 스펙 4장 확장).
 *
 * 바뀐 문단 전체를 은은한 초록으로 칠하고(왼쪽 초록 줄), 사라진 원문은 빨간 취소선
 * 카드로 그 아래에 보인다. 변경마다 페이지 오른쪽 바깥에 작은 ✓/✗(이 변경만 승인/거절)를
 * 두고, 문서 뷰 아래쪽에 '변경 i / N · ‹ › · 모두 거절 · 모두 승인' 바를 띄운다.
 * 실제 문서는 건드리지 않는 휘발성 표시이며, 좌표 계산이 실패해도 핵심 흐름(사이드바
 * 승인/거절)을 막지 않도록 방어한다.
 */

const ATTR = 'data-hop-ai-inline';

export interface InlineDiffEntry {
  /** scroll-content 기준 좌표(px). `top`은 대상 줄의 위, `lineBottom`은 줄 아래. */
  top: number;
  lineBottom: number;
  left: number;
  /** 카드·칠 최대 폭(대상 위치 기준). 페이지를 가로로 다 가리지 않도록 제한한다. */
  maxWidth: number;
  /** REPLACE/DELETE에서 사라지는 원문(빨강 취소선 카드). */
  before?: string;
  /** INSERT/REPLACE로 들어오는 텍스트(초록 카드 — 가상 미리보기 폴백 모드). */
  after?: string;
  /** 줄 왼쪽 여백에 얇은 초록 변경 표시줄(텍스트 안 가림). 표 셀처럼 칠할 폭을 모를 때. */
  changeBar?: boolean;
  /** 낙관적 적용 모드: 바뀐 문단 전체(top~bottom, 폭 maxWidth)를 은은하게 칠한다. */
  block?: boolean;
  /** 문단의 아래 끝(여러 줄 문단). 없으면 lineBottom. 원문 카드는 이 아래에 놓인다. */
  bottom?: number;
  /** 이 표시가 속한 변경(편집) 번호 — 같은 번호끼리 한 변경으로 묶여 이동·개별 승인/거절된다. */
  editIndex?: number;
  /** 개별 승인/거절 미니 버튼의 x 좌표(보통 페이지 오른쪽 바깥). 없으면 버튼 생략. */
  miniLeft?: number;
}

export interface InlineDiffCallbacks {
  onAccept(): void;
  onReject(): void;
  /** 변경 하나만 승인/거절(editIndex). 없으면 미니 버튼을 그리지 않는다. */
  onAcceptOne?(editIndex: number): void;
  onRejectOne?(editIndex: number): void;
}

export interface InlineDiffOptions {
  /** 처음 가리킬 변경 위치(0부터, 기본 0). */
  focusIndex?: number;
  /** 처음 위치로 스크롤할지(기본 true). 개별 승인/거절 뒤 다시 그릴 때는 끈다. */
  scroll?: boolean;
  /** 이전/다음으로 위치가 바뀔 때 알린다(다시 그려도 위치를 이어 가기 위해). */
  onFocusChange?(index: number): void;
}

export interface InlineDiffDeps {
  scrollContent: HTMLElement;
  scrollContainer: HTMLElement;
}

export function clearInlineDiff(scrollContent: HTMLElement): void {
  scrollContent.querySelectorAll(`[${ATTR}]`).forEach((node) => node.remove());
  // 검토 바는 뷰포트 고정(fixed)이라 body에 붙는다 — 함께 정리한다.
  if (typeof document !== 'undefined') {
    document.body?.querySelectorAll?.(`[${ATTR}]`)?.forEach?.((node) => node.remove());
  }
}

const SVG_CHECK =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const SVG_X =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const SVG_UP =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg>';
const SVG_DOWN =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

interface Group {
  top: number;
  marks: HTMLElement[];
  /** 이 변경의 편집 번호(없으면 개별 승인/거절 불가). */
  editIndex?: number;
}

function make(tag: string, className: string, kind: string): HTMLElement {
  const node = document.createElement(tag);
  node.setAttribute(ATTR, kind);
  node.className = className;
  return node;
}

function iconButton(className: string, svg: string, label: string): HTMLButtonElement {
  const button = document.createElement('button') as HTMLButtonElement;
  button.className = className;
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = svg;
  // 문서 위 클릭이 편집기 캐럿 이동으로 번지지 않게 한다.
  button.addEventListener('mousedown', (event) => {
    event.preventDefault?.();
    event.stopPropagation?.();
  });
  return button;
}

/**
 * 인라인 Diff 표시와 검토 바를 그린다. 반환: 그린 표시 항목 수(0이면 호출 측이 폴백 UI를
 * 띄울 수 있다).
 */
export function showInlineDiff(
  deps: InlineDiffDeps,
  entries: InlineDiffEntry[],
  callbacks: InlineDiffCallbacks,
  options: InlineDiffOptions = {},
): number {
  clearInlineDiff(deps.scrollContent);
  if (!entries.length) return 0;

  // 같은 editIndex끼리 한 변경으로 묶는다(번호가 없으면 항목마다 따로).
  const groups = new Map<string, Group>();
  const groupOf = (entry: InlineDiffEntry, index: number): Group => {
    const key = entry.editIndex !== undefined ? `e${entry.editIndex}` : `i${index}`;
    let group = groups.get(key);
    if (!group) {
      group = { top: entry.top, marks: [], editIndex: entry.editIndex };
      groups.set(key, group);
    }
    group.top = Math.min(group.top, entry.top);
    return group;
  };
  const miniDone = new Set<number>();

  let minTop = Number.POSITIVE_INFINITY;
  let barLeft = 0;
  entries.forEach((entry, index) => {
    const group = groupOf(entry, index);
    if (entry.top < minTop) {
      minTop = entry.top;
      barLeft = entry.left;
    }
    const bottom = Math.max(entry.bottom ?? entry.lineBottom, entry.lineBottom);

    // 바뀐 문단 전체를 칠한다(왼쪽 초록 줄 포함 — CSS). 클릭은 문서로 통과시킨다.
    if (entry.block) {
      const mark = make('div', 'hop-ai-inline-mark', 'mark');
      mark.style.position = 'absolute';
      mark.style.left = `${entry.left}px`;
      mark.style.top = `${entry.top}px`;
      mark.style.width = `${Math.max(40, entry.maxWidth)}px`;
      mark.style.height = `${Math.max(10, bottom - entry.top)}px`;
      mark.style.pointerEvents = 'none';
      deps.scrollContent.appendChild(mark);
      group.marks.push(mark);
    }

    // 표 셀처럼 칠할 폭을 모를 때 — 줄 왼쪽 여백의 얇은 초록 줄만.
    if (entry.changeBar) {
      const bar = make('div', 'hop-ai-inline-changebar', 'changebar');
      bar.style.position = 'absolute';
      bar.style.left = `${Math.max(0, entry.left - 8)}px`;
      bar.style.top = `${entry.top}px`;
      bar.style.height = `${Math.max(10, entry.lineBottom - entry.top)}px`;
      bar.style.pointerEvents = 'none';
      deps.scrollContent.appendChild(bar);
      group.marks.push(bar);
    }

    // 이 변경만 승인/거절 — 변경마다 한 번, 페이지 오른쪽 바깥 첫 줄 높이에.
    if (
      entry.miniLeft !== undefined &&
      entry.editIndex !== undefined &&
      !miniDone.has(entry.editIndex) &&
      (callbacks.onAcceptOne || callbacks.onRejectOne)
    ) {
      const editIndex = entry.editIndex;
      miniDone.add(editIndex);
      const mini = make('div', 'hop-ai-inline-mini', 'mini');
      mini.style.position = 'absolute';
      mini.style.left = `${entry.miniLeft}px`;
      mini.style.top = `${entry.top}px`;
      const reject = iconButton('hop-ai-inline-mini-reject', SVG_X, '이 변경 거절');
      reject.addEventListener('click', () => callbacks.onRejectOne?.(editIndex));
      const accept = iconButton('hop-ai-inline-mini-accept', SVG_CHECK, '이 변경 승인');
      accept.addEventListener('click', () => callbacks.onAcceptOne?.(editIndex));
      mini.append(reject, accept);
      deps.scrollContent.appendChild(mini);
    }

    // 원문(빨강 취소선)·제안(초록) 카드 — 바뀐 문단 아래에 둔다. 폭은 maxWidth로 제한.
    if (entry.before === undefined && entry.after === undefined) return;
    const card = make('div', 'hop-ai-inline-card', 'card');
    card.style.position = 'absolute';
    card.style.left = `${entry.left}px`;
    card.style.top = `${bottom + 2}px`;
    card.style.maxWidth = `${Math.max(120, entry.maxWidth)}px`;
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
  });

  // 문서 순서(위→아래)로 이동한다 — 페이지는 세로로 쌓이므로 top 순서가 곧 문서 순서다.
  const ordered = [...groups.values()].sort((a, b) => a.top - b.top);
  const total = ordered.length;
  let current = Math.min(Math.max(0, options.focusIndex ?? 0), total - 1);

  // 검토 바 — 문서 뷰 아래쪽 가운데 고정. 변경이 여러 쪽에 걸쳐도 어디서든 보인다.
  // 조상 transform의 영향을 받지 않도록 body에 fixed로 붙인다(clearInlineDiff가 정리).
  const bar = make('div', 'hop-ai-inline-bar', 'bar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'AI 변경 검토');
  const containerRect =
    typeof deps.scrollContainer.getBoundingClientRect === 'function'
      ? deps.scrollContainer.getBoundingClientRect()
      : null;
  if (containerRect && containerRect.width > 0) {
    bar.style.position = 'fixed';
    bar.style.left = `${containerRect.left + containerRect.width / 2}px`;
    bar.style.transform = 'translateX(-50%)';
    bar.style.top = `${Math.max(containerRect.top + 8, containerRect.bottom - 56)}px`;
  } else {
    // 좌표를 못 구하는 환경(테스트 등) — 변경 위치 위 폴백.
    bar.style.position = 'absolute';
    bar.style.left = `${barLeft}px`;
    bar.style.top = `${Math.max(0, minTop - 30)}px`;
  }

  const label = document.createElement('span');
  label.className = 'hop-ai-inline-label';

  const focus = (index: number, scroll: boolean): void => {
    current = (index + total) % total;
    label.textContent = total > 1 ? `변경 ${current + 1} / ${total}` : 'AI 변경 1건';
    ordered.forEach((group, i) => {
      for (const mark of group.marks) {
        const base = mark.className.replace(/\s*hop-ai-inline-current\b/g, '');
        mark.className = i === current && total > 1 ? `${base} hop-ai-inline-current` : base;
      }
    });
    if (scroll) {
      deps.scrollContainer.scrollTo({ top: Math.max(0, ordered[current].top - 80), behavior: 'smooth' });
    }
    options.onFocusChange?.(current);
  };

  const prev = iconButton('hop-ai-inline-prev', SVG_UP, '이전 변경');
  prev.addEventListener('click', () => focus(current - 1, true));
  const next = iconButton('hop-ai-inline-next', SVG_DOWN, '다음 변경');
  next.addEventListener('click', () => focus(current + 1, true));
  const nav = document.createElement('span');
  nav.className = total > 1 ? 'hop-ai-inline-nav' : 'hop-ai-inline-nav hop-ai-hidden';
  nav.append(prev, next);

  const sep = document.createElement('span');
  sep.className = 'hop-ai-inline-sep';

  // 지금 가리키는 변경만 거절/승인 — 결정하면 다음 변경으로 넘어간다(다시 그려도 같은 순번).
  const canDecideOne =
    total > 1 && ordered.every((g) => g.editIndex !== undefined) && !!callbacks.onAcceptOne && !!callbacks.onRejectOne;
  const rejectOne = document.createElement('button');
  rejectOne.className = 'hop-ai-inline-reject-one';
  rejectOne.textContent = '거절';
  rejectOne.title = '이 변경 거절';
  rejectOne.addEventListener('click', () => {
    const editIndex = ordered[current]?.editIndex;
    if (editIndex !== undefined) callbacks.onRejectOne?.(editIndex);
  });
  const acceptOne = document.createElement('button');
  acceptOne.className = 'hop-ai-inline-accept-one';
  acceptOne.textContent = '승인';
  acceptOne.title = '이 변경 승인';
  acceptOne.addEventListener('click', () => {
    const editIndex = ordered[current]?.editIndex;
    if (editIndex !== undefined) callbacks.onAcceptOne?.(editIndex);
  });
  const one = document.createElement('span');
  one.className = canDecideOne ? 'hop-ai-inline-one' : 'hop-ai-inline-one hop-ai-hidden';
  const sep2 = document.createElement('span');
  sep2.className = 'hop-ai-inline-sep';
  one.append(rejectOne, acceptOne, sep2);

  const reject = document.createElement('button');
  reject.className = 'hop-ai-inline-reject';
  reject.textContent = total > 1 ? '모두 거절' : '거절';
  reject.addEventListener('click', () => callbacks.onReject());

  const accept = document.createElement('button');
  accept.className = 'hop-ai-inline-accept';
  accept.textContent = total > 1 ? '모두 승인' : '승인';
  accept.addEventListener('click', () => callbacks.onAccept());

  bar.append(label, nav, sep, one, reject, accept);
  document.body.appendChild(bar);

  focus(current, options.scroll ?? true);
  return entries.length;
}
