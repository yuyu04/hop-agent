/**
 * 긴 문서 분할 작성(F-866a1c71) — 언제 나눠 쓸지, 개요 형식, 절마다 보내는 요청 문구.
 *
 * 10쪽 넘는 문서를 한 번에 쓰게 하면 출력 한도·CLI 시간 초과에 걸려 전부 잃는다. 개요를 먼저
 * 받고 절마다 따로 요청하면 응답 하나가 작아지고, 실패해도 그 절만 잃는다.
 */

import { isAuthoringRequest } from './skill-select';

export interface OutlineSection {
  heading: string;
  brief: string;
  target_chars: number;
  table: boolean;
}

export interface DocOutline {
  title: string;
  skill?: string;
  message?: string;
  sections: OutlineSection[];
}

/** 이 쪽수부터는 나눠 쓴다(쪽당 본문 ~1,300자 — 6쪽이면 응답 하나가 8천 자를 넘는다). */
export const SECTIONED_MIN_PAGES = 6;

/** 보통 길게 쓰는 문서 유형. */
const LONG_TYPES = /(사업\s*계획서|계획서|제안서|보고서|백서|연구\s*보고서|사업\s*제안)/;
/** 짧게 끝나는 문서 유형 — 유형 이름만으로는 나눠 쓰지 않는다. */
const SHORT_TYPES = /(공문|기안문|안내문|회의록|초대장|메모|공지문|보도자료)/;

/** 지시문의 요청 쪽수('10쪽', '3~5페이지' → 큰 값). 없으면 null. */
export function parseRequestedPages(prompt: string): number | null {
  const match = /(\d{1,3})(?:\s*[~∼-]\s*(\d{1,3}))?\s*(?:쪽|페이지)/.exec(prompt);
  if (!match) return null;
  const pages = Math.max(Number(match[1]), match[2] ? Number(match[2]) : 0);
  return Number.isFinite(pages) && pages > 0 ? pages : null;
}

/**
 * 빈 문서에 쓰는 작성 요청이 '긴 문서'인가. 쪽수를 밝혔으면 그것으로만 판단하고, 아니면
 * 문서 유형(사업계획서·보고서 등 길게 쓰는 유형, 공문 등 짧은 유형 제외)으로 판단한다.
 */
export function shouldSectionLongDocument(prompt: string, docIsBlank: boolean): boolean {
  if (!docIsBlank || !isAuthoringRequest(prompt)) return false;
  const pages = parseRequestedPages(prompt);
  if (pages !== null) return pages >= SECTIONED_MIN_PAGES;
  if (SHORT_TYPES.test(prompt)) return false;
  return LONG_TYPES.test(prompt);
}

/** 네이티브가 검증·정규화해 보낸 개요 JSON을 읽는다. 절이 없으면 null. */
export function parseOutline(json: string): DocOutline | null {
  try {
    const raw = JSON.parse(json) as Partial<DocOutline>;
    const sections = (raw.sections ?? []).filter(
      (s): s is OutlineSection => !!s && typeof s.heading === 'string' && s.heading.trim() !== '',
    );
    if (!sections.length) return null;
    return {
      title: (raw.title ?? '').trim(),
      skill: raw.skill?.trim() || undefined,
      message: raw.message?.trim() || undefined,
      sections: sections.map((s) => ({
        heading: s.heading.trim(),
        brief: (s.brief ?? '').trim(),
        target_chars: Number.isFinite(s.target_chars) ? s.target_chars : 1300,
        table: s.table === true,
      })),
    };
  } catch {
    return null;
  }
}

/** 1단계 — 개요만 달라는 요청 문구. */
export function buildOutlinePrompt(userPrompt: string): string {
  return (
    '[긴 문서 분할 작성 — 1단계: 개요]\n' +
    '아래 요청으로 만들 문서의 제목과 절(장) 목록만 설계하세요. 본문은 쓰지 않습니다.\n\n' +
    userPrompt
  );
}

/** 2단계 — i번째 절만 쓰라는 요청 문구. 모든 문단은 anchorId 뒤에 순서대로 붙인다. */
export function buildSectionPrompt(opts: {
  userPrompt: string;
  outline: DocOutline;
  index: number;
  anchorId: string;
  /** 앞에서 쓰지 못하고 건너뛴 절(인덱스별) — '이미 씀'으로 표시하지 않는다. */
  skipped?: boolean[];
}): string {
  const { userPrompt, outline, index, anchorId, skipped } = opts;
  const total = outline.sections.length;
  const section = outline.sections[index];
  const mark = (i: number): string => {
    if (i === index) return '▶';
    if (i > index) return '·';
    return skipped?.[i] ? '✗' : '✓';
  };
  const plan = outline.sections.map((s, i) => `${mark(i)} ${s.heading}`).join('\n');
  const table = section.table
    ? `이 절에 표를 하나 넣으세요 — 표 바로 앞에 '<표 n> 제목' 형식의 caption 문단을 두세요.`
    : '이 절에는 표를 넣지 마세요.';
  return [
    `[긴 문서 분할 작성 — ${index + 1}/${total}번째 절]`,
    `원래 요청: ${userPrompt}`,
    `문서 제목: ${outline.title}`,
    `전체 개요(✓ 이미 씀 · ✗ 쓰지 못함 · ▶ 지금 쓸 절):\n${plan}`,
    '',
    `지금은 '${section.heading}' 절만 쓰세요. 앞 절과 겹치는 내용이나 뒤 절의 내용은 쓰지 마세요.`,
    `- 첫 문단은 절 제목 '${section.heading}'(style=heading)입니다.`,
    `- 이 절의 요점: ${section.brief || '(개요의 절 제목에 맞게)'}`,
    `- 본문 목표 분량: 약 ${section.target_chars}자 — 소제목(subheading)과 본문(body) 문단으로 구조화하세요.`,
    `- ${table}`,
    `- 모든 문단·표는 '${anchorId}'에 INSERT_AFTER로, 문서에 놓일 순서대로 나열하세요. 다른 ID를 겨누지 마세요.`,
    '- 문서 제목과 다른 절의 제목은 다시 쓰지 말고, page_break는 쓰지 마세요.',
    '- message에는 이 절에서 쓴 내용을 한 문장으로 적으세요.',
  ].join('\n');
}

/** 문서 끝 문단 ID — 다음 절을 이어 붙일 자리. */
export function lastParagraphAnchor(paragraphCount: number, section = 0): string {
  return `sec[${section}].p[${Math.max(0, paragraphCount - 1)}]`;
}
