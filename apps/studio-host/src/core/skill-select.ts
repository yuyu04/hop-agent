/**
 * 글쓰기 스킬 자동 선택(스킬 드롭다운이 '자동'일 때).
 *
 * 트리거가 몇 개 맞았는지만 세면 '작성'·'표'처럼 흔한 낱말이 '사업계획서' 같은 구체적인
 * 낱말과 같은 무게가 되고, 동점은 파일 이름 순서로 갈렸다. 여기서는 맞은 트리거의 글자 수
 * 합으로 고르고, 동점은 가장 긴 맞은 트리거로 가린다.
 */

export interface SelectableSkill {
  id: string;
  name: string;
  triggers: string[];
  body: string;
  /** 'edit'면 기존 문서 편집 전용 — 새로 작성하는 요청에는 자동으로 고르지 않는다. */
  mode?: string;
}

/** 새 글을 쓰라는 요청의 동사(작성·써줘·만들어·초안). */
const AUTHORING = /(작성|써\s*줘|써\s*주|만들어|초안)/;

/** 예전에 깔린 기본 '한글 문서 편집' 스킬 파일엔 mode 머리말이 없다 — 이름으로도 알아본다. */
const LEGACY_EDIT_SKILLS = new Set(['한글-문서-편집', '한글 문서 편집']);

export function isAuthoringRequest(prompt: string): boolean {
  return AUTHORING.test(prompt);
}

function isEditOnly(skill: SelectableSkill): boolean {
  return skill.mode === 'edit' || LEGACY_EDIT_SKILLS.has(skill.id) || LEGACY_EDIT_SKILLS.has(skill.name);
}

/**
 * 트리거 하나가 지시문에 맞는지. 한 글자 트리거(표·셀·행·열)는 낱말 첫머리에서만 맞는다 —
 * 앞 글자가 한글이면(목표·진행·발표) 다른 낱말의 일부로 본다.
 */
function triggerMatches(prompt: string, trigger: string): boolean {
  const t = trigger.toLowerCase();
  if (!t) return false;
  if (t.length > 1) return prompt.includes(t);
  let from = 0;
  for (;;) {
    const at = prompt.indexOf(t, from);
    if (at < 0) return false;
    const prev = at > 0 ? prompt[at - 1] : '';
    if (!/[가-힣]/.test(prev)) return true;
    from = at + 1;
  }
}

/** 자동 선택 결과(맞는 스킬이 없으면 null). */
export function pickSkill<T extends SelectableSkill>(prompt: string, skills: T[]): T | null {
  const p = prompt.toLowerCase();
  const authoring = isAuthoringRequest(prompt);
  let best: { skill: T; score: number; longest: number } | null = null;
  for (const skill of skills) {
    if (authoring && isEditOnly(skill)) continue;
    let score = 0;
    let longest = 0;
    for (const trigger of skill.triggers) {
      if (!triggerMatches(p, trigger)) continue;
      score += trigger.length;
      longest = Math.max(longest, trigger.length);
    }
    if (score === 0) continue;
    if (!best || score > best.score || (score === best.score && longest > best.longest)) {
      best = { skill, score, longest };
    }
  }
  return best?.skill ?? null;
}

/** 자동 모드 작성 지침 목록에 실을 본문 합계 상한(글자). 넘으면 점수 낮은 스킬은 이름·설명만. */
export const SKILL_CATALOG_MAX_CHARS = 16_000;

export interface CatalogSkill extends SelectableSkill {
  description?: string;
}

/** 지시문에 대한 스킬 점수 순서(동점·0점은 원래 순서 유지). */
export function rankSkills<T extends SelectableSkill>(prompt: string, skills: T[]): T[] {
  const p = prompt.toLowerCase();
  const scored = skills.map((skill, index) => {
    let score = 0;
    for (const trigger of skill.triggers) if (triggerMatches(p, trigger)) score += trigger.length;
    return { skill, index, score };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.skill);
}

/**
 * '자동' 모드에서 요청 앞에 붙일 작성 지침 목록. AI가 요청 내용과 문서 상태를 보고 맞는
 * 지침을 의미로 골라 따르고, 고른 이름을 응답의 skill에 적는다(시스템 프롬프트 [작성 지침]).
 * 낱말 일치 점수는 '목록 순서'로만 쓴다. 스킬이 없으면 빈 문자열.
 */
export function buildSkillCatalog(
  prompt: string,
  skills: CatalogSkill[],
  maxChars = SKILL_CATALOG_MAX_CHARS,
): string {
  if (!skills.length) return '';
  const ranked = rankSkills(prompt, skills);
  let used = 0;
  let full = false;
  const sections: string[] = [];
  const summaries: string[] = [];
  for (const skill of ranked) {
    const tag = isEditOnly(skill) ? ' (기존 문서 편집 전용 — 새로 쓰는 요청에는 쓰지 마세요)' : '';
    const head = `### ${skill.name}${tag}${skill.description ? ` — ${skill.description}` : ''}`;
    // 점수 순서를 지킨다 — 한 번 상한을 넘으면 그 뒤(점수가 더 낮은) 스킬은 모두 이름·설명만.
    if (!full && used + skill.body.length <= maxChars) {
      used += skill.body.length;
      sections.push(`${head}\n${skill.body}`);
    } else {
      full = true;
      summaries.push(`- ${skill.name}${tag}${skill.description ? ` — ${skill.description}` : ''}`);
    }
  }
  const rest = summaries.length
    ? `\n\n[본문을 싣지 못한 지침 — 이름·설명만]\n${summaries.join('\n')}`
    : '';
  // 낱말 기준 추천은 참고로만 알린다 — 최종 판단은 AI가 요청의 의미로 한다.
  const hint = pickSkill(prompt, skills);
  const hintLine = hint ? `(낱말 기준 추천: ${hint.name} — 참고만 하고 요청의 의미로 판단하세요.)\n` : '';
  return (
    '[작성 지침 목록] 아래에서 이 요청과 문서 상태에 맞는 지침 하나를 골라 따르세요' +
    '(문서 문체 같은 일반 지침은 함께 따라도 됩니다). 맞는 것이 없으면 따르지 않아도 됩니다. ' +
    '따른 지침의 이름을 응답의 skill에 그대로 적으세요(없으면 빈 문자열).\n' +
    hintLine +
    '\n' +
    sections.join('\n\n') +
    rest
  );
}
