// 회귀 테스트: 긴 문서는 개요부터 만들고 절마다 나눠 쓴다 — 판정·개요 읽기·절 요청 문구 (F-866a1c71).
import { describe, expect, it } from 'vitest';
import {
  SECTIONED_MIN_PAGES,
  buildOutlinePrompt,
  buildSectionPrompt,
  lastParagraphAnchor,
  parseOutline,
  parseRequestedPages,
  shouldSectionLongDocument,
  type DocOutline,
} from './long-document';

/**
 * F-866a1c71 — 긴 문서 분할 작성의 순수 로직.
 *
 * - AC-5c6d1ea3: 빈 문서 + 작성 요청 + (6쪽 이상 명시 또는 긴 문서 유형)일 때만 나눠 쓴다.
 *   쪽수를 밝혔으면 쪽수가 이긴다(짧은 유형이라도 8쪽이면 나눠 쓰고, 긴 유형이라도 3쪽이면 안 나눔).
 * - AC-a622a229: 네이티브가 보낸 개요 JSON을 읽고(공백 정리·빈 제목 제거·기본값), 1단계 요청 문구.
 * - AC-d156df37: 절 하나만 쓰라는 2단계 요청 문구와 다음 절을 이어 붙일 문단 ID.
 */

describe('F-866a1c71 AC-5c6d1ea3: 언제 나눠 쓰는가', () => {
  it('AC-5c6d1ea3: the threshold is 6 pages', () => {
    expect(SECTIONED_MIN_PAGES).toBe(6);
  });

  it.each([
    ['사업계획서 작성해줘'],
    ['연구 보고서 10쪽으로 써줘'],
    ['제안서 초안 만들어줘'],
    ['사업 계획서 작성해줘'],
    ['정책 백서 작성해줘'],
    ['분기 보고서 써줘'],
  ])('AC-5c6d1ea3: %s on a blank document is sectioned', (prompt) => {
    expect(shouldSectionLongDocument(prompt, true)).toBe(true);
  });

  it.each([
    ['사업계획서 3쪽으로 작성해줘', '6쪽 미만을 명시'],
    ['사업계획서 5페이지로 작성해줘', '6쪽 미만(경계 바로 아래)'],
    ['공문 작성해줘', '짧은 문서 유형'],
    ['회의록 써줘', '짧은 문서 유형'],
    ['보도자료 작성해줘', '짧은 문서 유형'],
    ['사업계획서 요약해줘', '작성 요청이 아님'],
    ['보고서 맞춤법 고쳐줘', '작성 요청이 아님'],
    ['자기소개 작성해줘', '긴 문서 유형도 쪽수도 없음'],
  ])('AC-5c6d1ea3: %s is NOT sectioned (%s)', (prompt) => {
    expect(shouldSectionLongDocument(prompt, true)).toBe(false);
  });

  it('AC-5c6d1ea3: a document that already has content is never sectioned', () => {
    expect(shouldSectionLongDocument('사업계획서 작성해줘', false)).toBe(false);
    expect(shouldSectionLongDocument('연구 보고서 10쪽으로 써줘', false)).toBe(false);
    expect(shouldSectionLongDocument('공문 8쪽으로 작성해줘', false)).toBe(false);
  });

  it('AC-5c6d1ea3: explicit pages win over the document type', () => {
    // 짧은 유형이라도 6쪽 이상을 밝히면 나눠 쓴다.
    expect(shouldSectionLongDocument('공문 8쪽으로 작성해줘', true)).toBe(true);
    // 정확히 6쪽(경계)부터 나눠 쓴다.
    expect(shouldSectionLongDocument('안내문 6페이지 작성해줘', true)).toBe(true);
    // 긴 유형이라도 6쪽 미만을 밝히면 한 번 요청 경로다.
    expect(shouldSectionLongDocument('제안서 2쪽 초안 만들어줘', true)).toBe(false);
    // 유형이 없어도 쪽수만으로 판단한다.
    expect(shouldSectionLongDocument('여행 후기 7쪽 써줘', true)).toBe(true);
  });

  it.each([
    ['보고서 10쪽으로 써줘', 10],
    ['3~5페이지 분량으로 작성해줘', 5],
    ['12 페이지 작성해줘', 12],
    ['5-8쪽', 8],
    ['8∼4쪽', 8],
    ['한 쪽짜리 메모', null],
    ['사업계획서 작성해줘', null],
    ['0쪽', null],
  ])('AC-5c6d1ea3: parseRequestedPages(%s) → %s', (prompt, pages) => {
    expect(parseRequestedPages(prompt)).toBe(pages);
  });
});

describe('F-866a1c71 AC-a622a229: 개요 읽기와 1단계 요청', () => {
  it('AC-a622a229: parseOutline reads a full outline and trims strings', () => {
    const outline = parseOutline(
      JSON.stringify({
        title: '  2027 사업계획서  ',
        skill: ' 사업계획서 ',
        message: ' 6개 절로 구성 ',
        sections: [
          { heading: ' 1. 사업 개요 ', brief: ' 목적과 배경 ', target_chars: 1200, table: false },
          { heading: '2. 추진 일정', brief: '분기별', target_chars: 800, table: true },
        ],
      }),
    );
    expect(outline).toEqual({
      title: '2027 사업계획서',
      skill: '사업계획서',
      message: '6개 절로 구성',
      sections: [
        { heading: '1. 사업 개요', brief: '목적과 배경', target_chars: 1200, table: false },
        { heading: '2. 추진 일정', brief: '분기별', target_chars: 800, table: true },
      ],
    });
  });

  it('AC-a622a229: parseOutline drops sections with empty or missing headings', () => {
    const outline = parseOutline(
      JSON.stringify({
        title: '보고서',
        sections: [
          { heading: '   ', brief: 'x', target_chars: 500, table: false },
          { heading: '1. 서론', brief: 'a', target_chars: 500, table: false },
          { brief: '제목 없음', target_chars: 500, table: false },
          null,
          { heading: 7, brief: '숫자 제목', target_chars: 500, table: false },
          { heading: '2. 결론', brief: 'b', target_chars: 500, table: false },
        ],
      }),
    );
    expect(outline?.sections.map((s) => s.heading)).toEqual(['1. 서론', '2. 결론']);
  });

  it('AC-a622a229: parseOutline fills defaults for missing fields', () => {
    const outline = parseOutline(JSON.stringify({ sections: [{ heading: '1. 개요' }] }));
    expect(outline).toEqual({
      title: '',
      skill: undefined,
      message: undefined,
      sections: [{ heading: '1. 개요', brief: '', target_chars: 1300, table: false }],
    });
  });

  it('AC-a622a229: parseOutline treats only table === true as a table section', () => {
    const outline = parseOutline(
      JSON.stringify({
        title: 't',
        sections: [
          { heading: 'a', table: 'true' },
          { heading: 'b', table: 1 },
          { heading: 'c', table: true },
        ],
      }),
    );
    expect(outline?.sections.map((s) => s.table)).toEqual([false, false, true]);
  });

  it('AC-a622a229: an empty skill name becomes undefined (no skill chosen)', () => {
    const outline = parseOutline(JSON.stringify({ title: 't', skill: '  ', sections: [{ heading: 'a' }] }));
    expect(outline?.skill).toBeUndefined();
    expect(outline?.title).toBe('t');
  });

  it.each([
    ['not json', '개요를 만들 수 없습니다'],
    ['no sections key', JSON.stringify({ title: 't' })],
    ['empty sections', JSON.stringify({ title: 't', sections: [] })],
    ['only blank headings', JSON.stringify({ title: 't', sections: [{ heading: ' ' }, { heading: '' }] })],
    ['truncated JSON', '{"title":"t","sections":[{"heading":"1. 개요"'],
  ])('AC-a622a229: parseOutline returns null for %s', (_label, json) => {
    expect(parseOutline(json)).toBeNull();
  });

  it('AC-a622a229: buildOutlinePrompt asks for the outline only and wraps the user prompt', () => {
    const prompt = buildOutlinePrompt('사업계획서 10쪽 작성해줘');
    const lines = prompt.split('\n');
    expect(lines[0]).toBe('[긴 문서 분할 작성 — 1단계: 개요]');
    expect(prompt).toContain('제목과 절(장) 목록만 설계하세요');
    expect(prompt).toContain('본문은 쓰지 않습니다');
    // 사용자 요청은 마지막에 그대로 들어간다.
    expect(prompt.endsWith('\n\n사업계획서 10쪽 작성해줘')).toBe(true);
  });
});

describe('F-866a1c71 AC-d156df37: 절마다 보내는 요청', () => {
  const outline: DocOutline = {
    title: '2027 신규 사업계획서',
    skill: '사업계획서',
    sections: [
      { heading: '1. 사업 개요', brief: '목적과 배경', target_chars: 1200, table: false },
      { heading: '2. 추진 일정', brief: '분기별 마일스톤과 담당', target_chars: 1800, table: true },
      { heading: '3. 기대 효과', brief: '', target_chars: 900, table: false },
    ],
  };

  const second = () =>
    buildSectionPrompt({ userPrompt: '사업계획서 10쪽 작성해줘', outline, index: 1, anchorId: 'sec[0].p[7]' });

  it('AC-d156df37: the first line names the section as i/N', () => {
    expect(second().split('\n')[0]).toBe('[긴 문서 분할 작성 — 2/3번째 절]');
    const third = buildSectionPrompt({ userPrompt: 'x', outline, index: 2, anchorId: 'sec[0].p[9]' });
    expect(third.split('\n')[0]).toBe('[긴 문서 분할 작성 — 3/3번째 절]');
  });

  it('AC-d156df37: it carries the original request and the document title', () => {
    const lines = second().split('\n');
    expect(lines).toContain('원래 요청: 사업계획서 10쪽 작성해줘');
    expect(lines).toContain('문서 제목: 2027 신규 사업계획서');
  });

  const LEGEND = '전체 개요(✓ 이미 씀 · ✗ 쓰지 못함 · ▶ 지금 쓸 절):';

  /** 개요 범례 다음 줄부터 절 수만큼(계획 줄들). */
  function planLines(prompt: string): string[] {
    const lines = prompt.split('\n');
    const start = lines.indexOf(LEGEND);
    if (start < 0) throw new Error(`범례 줄이 없다:\n${prompt}`);
    return lines.slice(start + 1, start + 1 + outline.sections.length);
  }

  it('AC-d156df37: the plan marks written (✓), current (▶) and later (·) sections', () => {
    expect(planLines(second())).toEqual(['✓ 1. 사업 개요', '▶ 2. 추진 일정', '· 3. 기대 효과']);

    const first = buildSectionPrompt({ userPrompt: 'x', outline, index: 0, anchorId: 'sec[0].p[0]' });
    expect(planLines(first)).toEqual(['▶ 1. 사업 개요', '· 2. 추진 일정', '· 3. 기대 효과']);
  });

  it('AC-d156df37: earlier sections that were skipped are marked ✗, not ✓', () => {
    const third = buildSectionPrompt({
      userPrompt: 'x',
      outline,
      index: 2,
      anchorId: 'sec[0].p[4]',
      skipped: [false, true, false],
    });
    expect(planLines(third)).toEqual(['✓ 1. 사업 개요', '✗ 2. 추진 일정', '▶ 3. 기대 효과']);

    const allSkipped = buildSectionPrompt({
      userPrompt: 'x',
      outline,
      index: 2,
      anchorId: 'sec[0].p[0]',
      skipped: [true, true, false],
    });
    expect(planLines(allSkipped)).toEqual(['✗ 1. 사업 개요', '✗ 2. 추진 일정', '▶ 3. 기대 효과']);
  });

  it('AC-d156df37: skipped flags never override the current (▶) or later (·) marks', () => {
    const second = buildSectionPrompt({
      userPrompt: 'x',
      outline,
      index: 1,
      anchorId: 'sec[0].p[2]',
      skipped: [false, true, true],
    });
    expect(planLines(second)).toEqual(['✓ 1. 사업 개요', '▶ 2. 추진 일정', '· 3. 기대 효과']);
  });

  it('AC-d156df37: omitting skipped (or an empty list) keeps every earlier section as ✓', () => {
    const omitted = buildSectionPrompt({ userPrompt: 'x', outline, index: 2, anchorId: 'sec[0].p[4]' });
    expect(planLines(omitted)).toEqual(['✓ 1. 사업 개요', '✓ 2. 추진 일정', '▶ 3. 기대 효과']);
    const empty = buildSectionPrompt({ userPrompt: 'x', outline, index: 2, anchorId: 'sec[0].p[4]', skipped: [] });
    expect(planLines(empty)).toEqual(['✓ 1. 사업 개요', '✓ 2. 추진 일정', '▶ 3. 기대 효과']);
  });

  it('AC-d156df37: only this section — heading first, then brief and target length', () => {
    const lines = second().split('\n');
    expect(lines).toContain("지금은 '2. 추진 일정' 절만 쓰세요. 앞 절과 겹치는 내용이나 뒤 절의 내용은 쓰지 마세요.");
    expect(lines).toContain("- 첫 문단은 절 제목 '2. 추진 일정'(style=heading)입니다.");
    expect(lines).toContain('- 이 절의 요점: 분기별 마일스톤과 담당');
    expect(lines).toContain('- 본문 목표 분량: 약 1800자 — 소제목(subheading)과 본문(body) 문단으로 구조화하세요.');
  });

  it('AC-d156df37: an empty brief falls back to the heading', () => {
    const third = buildSectionPrompt({ userPrompt: 'x', outline, index: 2, anchorId: 'sec[0].p[9]' }).split('\n');
    expect(third).toContain('- 이 절의 요점: (개요의 절 제목에 맞게)');
    expect(third).toContain('- 본문 목표 분량: 약 900자 — 소제목(subheading)과 본문(body) 문단으로 구조화하세요.');
  });

  it('AC-d156df37: a table section asks for one table with a caption above it; others forbid tables', () => {
    const withTable = second();
    expect(withTable).toContain("- 이 절에 표를 하나 넣으세요 — 표 바로 앞에 '<표 n> 제목' 형식의 caption 문단을 두세요.");
    expect(withTable).not.toContain('표를 넣지 마세요');

    const noTable = buildSectionPrompt({ userPrompt: 'x', outline, index: 0, anchorId: 'sec[0].p[0]' });
    expect(noTable).toContain('- 이 절에는 표를 넣지 마세요.');
    expect(noTable).not.toContain('표를 하나 넣으세요');
  });

  it('AC-d156df37: every paragraph goes INSERT_AFTER the anchor, without page breaks or re-written titles', () => {
    const lines = second().split('\n');
    expect(lines).toContain(
      "- 모든 문단·표는 'sec[0].p[7]'에 INSERT_AFTER로, 문서에 놓일 순서대로 나열하세요. 다른 ID를 겨누지 마세요.",
    );
    expect(lines).toContain('- 문서 제목과 다른 절의 제목은 다시 쓰지 말고, page_break는 쓰지 마세요.');
    expect(lines).toContain('- message에는 이 절에서 쓴 내용을 한 문장으로 적으세요.');
  });

  it('AC-d156df37: lastParagraphAnchor points at the last paragraph of the section', () => {
    expect(lastParagraphAnchor(5)).toBe('sec[0].p[4]');
    expect(lastParagraphAnchor(1)).toBe('sec[0].p[0]');
    expect(lastParagraphAnchor(0)).toBe('sec[0].p[0]');
    expect(lastParagraphAnchor(3, 2)).toBe('sec[2].p[2]');
  });
});
