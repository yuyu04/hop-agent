/**
 * F-a7b2c7ba AC-8790cc2f: 스킬 자동 선택.
 *
 * - 맞은 트리거의 '글자 수 합'으로 고른다(맞은 개수·가장 긴 하나만이 아님).
 * - 한 글자 트리거(표·셀·행·열)는 낱말 첫머리에서만 맞는다(목표·진행·발표에는 안 맞음).
 * - 작성 요청(작성·써줘·만들어·초안)에는 편집 전용 스킬(mode: edit, 기본 '한글 문서 편집')을
 *   고르지 않는다.
 * - 동점은 파일(배열) 순서가 아니라 가장 긴 맞은 트리거로 가린다.
 *
 * 각 사례는 '틀린 규칙이었다면 다른 스킬이 뽑히도록' 짰다 — 예: 개수 규칙이면 동점이 되어
 * 배열 앞 스킬이 뽑히는 배치. 뒷부분은 앱에 번들된 실제 기본 스킬 파일(.md)로 확인한다.
 *
 * F-fb6592e9 AC-cee73e04 / AC-a0f16fb6: '자동' 모드 작성 지침 목록(buildSkillCatalog) —
 * 모든 스킬의 이름·설명·본문을 낱말 점수 순서로 싣고, 첫머리에 pickSkill의 '낱말 기준 추천'을
 * 참고로 적으며, 본문 합이 상한을 넘으면 점수 낮은 쪽부터 이름·설명만 남긴다.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSkillCatalog,
  isAuthoringRequest,
  pickSkill,
  rankSkills,
  SKILL_CATALOG_MAX_CHARS,
  type CatalogSkill,
  type SelectableSkill,
} from './skill-select';
import gongmunMd from '../../../desktop/src-tauri/src/ai/skills_default/gongmun.md?raw';
import hwpEditMd from '../../../desktop/src-tauri/src/ai/skills_default/hwp_edit.md?raw';
import proposalMd from '../../../desktop/src-tauri/src/ai/skills_default/proposal.md?raw';
import reportMd from '../../../desktop/src-tauri/src/ai/skills_default/report.md?raw';
import styleMd from '../../../desktop/src-tauri/src/ai/skills_default/style.md?raw';

function skill(id: string, triggers: string[], mode?: string): SelectableSkill {
  return { id, name: id, triggers, body: `${id} 지침`, ...(mode ? { mode } : {}) };
}

const ids = (skills: SelectableSkill[]) => (prompt: string) => pickSkill(prompt, skills)?.id ?? null;

describe('F-a7b2c7ba AC-8790cc2f: 트리거 글자 수 합으로 고른다', () => {
  it('AC-8790cc2f: 긴 구체 트리거(사업계획서 5자)가 흔한 낱말(작성 2자)을 이긴다 — 개수 규칙이면 동점→앞 스킬', () => {
    // 개수로 세면 둘 다 1개 → 배열 앞의 '문체'가 뽑혔다(2026-10-08 실측 버그).
    const skills = [skill('style', ['작성', '문체']), skill('proposal', ['사업계획서'])];
    expect(ids(skills)('스마트공장 구축 사업계획서 작성해줘')).toBe('proposal');
  });

  it('AC-8790cc2f: 가장 긴 트리거 하나가 아니라 맞은 트리거 전부의 합이다', () => {
    // A: 분석(2)+보고(2)=4, B: 보고서(3). 최장 하나로 고르면 B가 뽑힌다.
    const skills = [skill('B', ['보고서']), skill('A', ['분석', '보고'])];
    expect(ids(skills)('분석 보고서를 정리')).toBe('A');
  });

  it('AC-8790cc2f: 같은 트리거가 여러 번 나와도 한 번만 센다(합은 트리거 단위)', () => {
    // A: 표(1) — 세 번 나와도 1, B: 문단(2). 등장 횟수로 세면 A가 이긴다.
    const skills = [skill('A', ['표']), skill('B', ['문단'])];
    expect(ids(skills)('표 표 표 문단')).toBe('B');
  });

  it('AC-8790cc2f: 맞는 트리거가 없으면 null', () => {
    const skills = [skill('A', ['사업계획서']), skill('B', ['표'])];
    expect(ids(skills)('날씨가 좋네요')).toBeNull();
  });

  it('AC-8790cc2f: 대소문자를 가리지 않는다(R&D)', () => {
    const skills = [skill('style', ['작성']), skill('rnd', ['R&D'])];
    // r&d(3자) > 작성(2자)
    expect(ids(skills)('r&d 과제 작성해줘')).toBe('rnd');
  });
});

describe('F-a7b2c7ba AC-8790cc2f: 동점은 가장 긴 맞은 트리거로 가린다', () => {
  // A: 계획(2)+일정(2)=4(최장 2), B: 사업계획(4)=4(최장 4).
  const a = skill('A', ['계획', '일정']);
  const b = skill('B', ['사업계획']);

  it('AC-8790cc2f: 합이 같으면 더 긴 트리거가 맞은 스킬 — 배열 순서와 무관', () => {
    expect(ids([a, b])('사업계획 일정 검토')).toBe('B');
    expect(ids([b, a])('사업계획 일정 검토')).toBe('B');
  });
});

describe('F-a7b2c7ba AC-8790cc2f: 한 글자 트리거는 낱말 첫머리에서만 맞는다', () => {
  const table = skill('table', ['표', '셀', '행', '열']);

  it.each(['올해 목표를 정리', '발표 일정 공유', '프로젝트 진행 상황'])(
    "AC-8790cc2f: '%s' — 낱말 안의 표·행에는 안 맞는다",
    (prompt) => {
      expect(pickSkill(prompt, [table])).toBeNull();
    },
  );

  it.each(['표를 정리해줘', '2번 표 정리', '(표) 다듬기', '셀 병합', '목표 표 정리'])(
    "AC-8790cc2f: '%s' — 낱말 첫머리의 한 글자 트리거는 맞는다",
    (prompt) => {
      expect(pickSkill(prompt, [table])?.id).toBe('table');
    },
  );

  it("AC-8790cc2f: '목표 수립'은 '목표' 트리거 스킬만 맞고 '표' 스킬은 점수를 얻지 못한다", () => {
    const goal = skill('goal', ['목표']);
    expect(ids([table, goal])('목표 수립')).toBe('goal');
  });
});

describe('F-a7b2c7ba AC-8790cc2f: 작성 요청에는 편집 전용 스킬을 고르지 않는다', () => {
  // 편집 전용 스킬은 점수(표1+문단2+정리2+제목2+서식2=9)로는 압도적으로 이긴다.
  const edit = skill('edit', ['표', '문단', '정리', '제목', '서식'], 'edit');
  const style = skill('style', ['정리']);

  it.each(['작성해줘', '써줘', '써 줘', '만들어줘', '초안 잡아줘', '작성해 주세요'])(
    "AC-8790cc2f: '표와 문단, 제목 서식을 정리해서 %s' → 편집 전용 스킬 제외",
    (verb) => {
      const prompt = `표와 문단, 제목 서식을 정리해서 ${verb}`;
      expect(isAuthoringRequest(prompt)).toBe(true);
      expect(ids([edit, style])(prompt)).toBe('style');
    },
  );

  it('AC-8790cc2f: 작성 요청이 아니면 편집 전용 스킬도 고른다', () => {
    const prompt = '표와 문단, 제목 서식을 정리해줘';
    expect(isAuthoringRequest(prompt)).toBe(false);
    expect(ids([edit, style])(prompt)).toBe('edit');
  });

  it("AC-8790cc2f: mode 머리말이 없는 예전 '한글 문서 편집'(id 또는 이름)도 작성 요청에서는 제외한다", () => {
    const legacyById: SelectableSkill = { id: '한글-문서-편집', name: '편집', triggers: edit.triggers, body: '' };
    const legacyByName: SelectableSkill = { id: 'x', name: '한글 문서 편집', triggers: edit.triggers, body: '' };
    for (const legacy of [legacyById, legacyByName]) {
      expect(pickSkill('표와 문단, 제목 서식을 정리해서 작성해줘', [legacy, style])?.id).toBe('style');
      expect(pickSkill('표와 문단, 제목 서식을 정리해줘', [legacy, style])).toBe(legacy);
    }
  });

  it('AC-8790cc2f: 작성 동사 인식 — 작성·써줘·써 줘·만들어·초안은 작성, 수정·고쳐·정리는 아님', () => {
    for (const p of ['사업계획서 작성해줘', '회의록을 써줘', '안내문 써 주세요', '공문 만들어줘', '기획안 초안']) {
      expect(isAuthoringRequest(p), p).toBe(true);
    }
    for (const p of ['표 수정해줘', '문단을 고쳐줘', '서식을 정리해줘', '이 문서 요약해줘']) {
      expect(isAuthoringRequest(p), p).toBe(false);
    }
  });
});

/** Rust skills.rs::parse_skill과 같은 규칙으로 번들 기본 스킬의 머리말을 읽는다. */
function parseBundled(id: string, content: string): SelectableSkill {
  const out: SelectableSkill = { id, name: id, triggers: [], body: content };
  if (!content.startsWith('---')) return out;
  const rest = content.slice(3);
  const end = rest.indexOf('\n---');
  if (end < 0) return out;
  for (const line of rest.slice(0, end).split('\n')) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key === 'name') out.name = value;
    if (key === 'mode' && value) out.mode = value;
    if (key === 'triggers') out.triggers = value.split(',').map((t) => t.trim()).filter(Boolean);
  }
  out.body = rest.slice(end + 4).trim();
  return out;
}

/** 앱 스킬 폴더의 기본 파일들 — Rust `list()`가 경로를 정렬하므로 그 순서(공문, 문서-문체, 보고서, 사업계획서, 한글-문서-편집). */
const BUNDLED: SelectableSkill[] = [
  parseBundled('공문', gongmunMd),
  parseBundled('문서-문체', styleMd),
  parseBundled('보고서', reportMd),
  parseBundled('사업계획서', proposalMd),
  parseBundled('한글-문서-편집', hwpEditMd),
];

const bundledName = (prompt: string, skills = BUNDLED) => pickSkill(prompt, skills)?.name ?? null;

describe('F-a7b2c7ba AC-8790cc2f: 번들 기본 스킬로 본 실제 사례(2026-10-08 작성 E2E)', () => {
  it("AC-8790cc2f: 기본 '한글 문서 편집'은 mode: edit 이다(작성 요청에서 빠지는 근거)", () => {
    const hwpEdit = BUNDLED.find((s) => s.name === '한글 문서 편집');
    expect(hwpEdit?.mode).toBe('edit');
  });

  it("AC-8790cc2f: '스마트공장 구축 사업계획서 작성해줘' → '사업계획서'(동점으로 '문서 문체'가 뽑히던 문제), 파일 순서를 뒤집어도 같다", () => {
    expect(bundledName('스마트공장 구축 사업계획서 작성해줘')).toBe('사업계획서');
    expect(bundledName('스마트공장 구축 사업계획서 작성해줘', [...BUNDLED].reverse())).toBe('사업계획서');
  });

  it("AC-8790cc2f: '사업계획서를 표와 문단으로 정리해서 작성해줘' → '사업계획서'(편집 스킬 아님)", () => {
    expect(bundledName('사업계획서를 표와 문단으로 정리해서 작성해줘')).toBe('사업계획서');
  });

  it("AC-8790cc2f: 편집 낱말이 잔뜩인 작성 요청도 '한글 문서 편집'을 고르지 않는다(작성 동사를 빼면 고른다)", () => {
    expect(bundledName('표와 문단, 제목 서식을 정리해서 작성해줘')).toBe('문서 문체');
    expect(bundledName('표와 문단, 제목 서식을 정리해줘')).toBe('한글 문서 편집');
  });

  it("AC-8e9f717d(교차 확인): 공문·기안문 작성 요청은 기본 '공문' 스킬이 자동 선택된다", () => {
    for (const prompt of ['협조 요청 공문 작성해줘', '기안문 써줘', '공문서 초안 만들어줘']) {
      expect(bundledName(prompt), prompt).toBe('공문');
      expect(bundledName(prompt, [...BUNDLED].reverse()), prompt).toBe('공문');
    }
  });
});

// ── F-fb6592e9: 자동 모드 작성 지침 목록(buildSkillCatalog) ─────────────────

/** 번들 기본 스킬 + 머리말 description(작성 지침 목록에 이름과 함께 싣는 설명). */
function parseBundledCatalog(id: string, content: string): CatalogSkill {
  const header = content.slice(3, content.indexOf('\n---', 3));
  const description = /^description:\s*(.+)$/m.exec(header)?.[1].trim() ?? '';
  return { ...parseBundled(id, content), description };
}

/** Rust `list()` 순서(공문, 문서-문체, 보고서, 사업계획서, 한글-문서-편집). */
const BUNDLED_CATALOG: CatalogSkill[] = [
  parseBundledCatalog('공문', gongmunMd),
  parseBundledCatalog('문서-문체', styleMd),
  parseBundledCatalog('보고서', reportMd),
  parseBundledCatalog('사업계획서', proposalMd),
  parseBundledCatalog('한글-문서-편집', hwpEditMd),
];

/** '### 이름[ (편집 전용 표시)][ — 설명]' 제목 줄을 읽는다. */
const HEADING = /^### (.+?)( \(기존 문서 편집 전용[^)]*\))?(?: — (.*))?$/;

function headings(catalog: string): { name: string; editOnly: boolean; description: string | null }[] {
  return catalog
    .split('\n')
    .filter((line) => line.startsWith('### '))
    .map((line) => {
      const m = HEADING.exec(line);
      if (!m) throw new Error(`제목 줄 형식이 아님: ${line}`);
      return { name: m[1], editOnly: m[2] !== undefined, description: m[3] ?? null };
    });
}

const sectionNames = (catalog: string) => headings(catalog).map((h) => h.name);

/** '(낱말 기준 추천: 이름 — …)' 줄이 가리키는 이름들. */
function hintNames(catalog: string): string[] {
  return Array.from(catalog.matchAll(/\(낱말 기준 추천: (.+?) — /g), (m) => m[1]);
}

const OVERFLOW_HEAD = '[본문을 싣지 못한 지침 — 이름·설명만]';

/** 상한을 넘겨 이름·설명만 남은 줄들(없으면 null). */
function overflowLines(catalog: string): string[] | null {
  const at = catalog.indexOf(OVERFLOW_HEAD);
  if (at < 0) return null;
  return catalog.slice(at + OVERFLOW_HEAD.length).split('\n').filter(Boolean);
}

function catSkill(name: string, triggers: string[], body = `${name} 지침 본문`, description = `${name} 설명`): CatalogSkill {
  return { id: `id-${name}`, name, triggers, body, description };
}

/** 길이가 정확히 len인 본문 — 앞머리 표지('[이름본문]')로 실렸는지 찾는다. */
function bodyOf(name: string, len: number): string {
  const marker = `[${name}본문]`;
  if (len < marker.length) throw new Error('본문 길이가 표지보다 짧다');
  return marker + '.'.repeat(len - marker.length);
}

describe('F-fb6592e9 AC-cee73e04: 자동 모드는 모든 스킬을 작성 지침 목록으로 싣는다', () => {
  it('AC-cee73e04: 번들 스킬 전부의 이름·설명·지침 본문 전체가 목록에 실린다', () => {
    const catalog = buildSkillCatalog('협조 요청 공문 작성해줘', BUNDLED_CATALOG);
    expect(catalog.startsWith('[작성 지침 목록]')).toBe(true);
    const byName = new Map(headings(catalog).map((h) => [h.name, h]));
    expect([...byName.keys()].sort()).toEqual(BUNDLED_CATALOG.map((s) => s.name).sort());
    for (const s of BUNDLED_CATALOG) {
      expect(s.description, `${s.id} 픽스처의 description`).not.toBe('');
      expect(byName.get(s.name)?.description, s.name).toBe(s.description);
      expect(catalog, s.name).toContain(`\n${s.body}`);
    }
    // 본문 합이 상한보다 한참 작다 — 이름·설명만 남는 지침이 없다.
    expect(overflowLines(catalog)).toBeNull();
  });

  it("AC-cee73e04: 낱말 점수 순서로 싣는다 — '사업계획서' 요청이면 사업계획서가 첫 지침, 0점은 받은 순서", () => {
    const prompt = '스마트공장 구축 사업계획서 작성해줘';
    // 사업계획서(사업계획서 5) > 문서 문체(작성 2) > 0점(받은 순서).
    expect(sectionNames(buildSkillCatalog(prompt, BUNDLED_CATALOG))).toEqual([
      '사업계획서',
      '문서 문체',
      '공문',
      '보고서',
      '한글 문서 편집',
    ]);
    expect(sectionNames(buildSkillCatalog(prompt, [...BUNDLED_CATALOG].reverse()))).toEqual([
      '사업계획서',
      '문서 문체',
      '한글 문서 편집',
      '보고서',
      '공문',
    ]);
  });

  it('AC-cee73e04: 동점 스킬은 받은 순서를 지킨다(목록 순서는 pickSkill의 최장 트리거 가림을 쓰지 않는다)', () => {
    const a = catSkill('A', ['가나']);
    const b = catSkill('B', ['다라']);
    const c = catSkill('C', ['없는낱말']);
    const d = catSkill('D', ['안맞는말']);
    const prompt = '가나 다라 정리';
    expect(sectionNames(buildSkillCatalog(prompt, [c, a, d, b]))).toEqual(['A', 'B', 'C', 'D']);
    expect(sectionNames(buildSkillCatalog(prompt, [d, b, c, a]))).toEqual(['B', 'A', 'D', 'C']);
    expect(rankSkills(prompt, [d, b, c, a]).map((s) => s.name)).toEqual(['B', 'A', 'D', 'C']);
  });

  it("AC-cee73e04: 첫머리 '낱말 기준 추천'은 pickSkill 결과다 — 편집 전용이 점수 1위여도 작성 요청이면 추천은 문서 문체", () => {
    const prompt = '표와 문단, 제목 서식을 정리해서 작성해줘';
    const catalog = buildSkillCatalog(prompt, BUNDLED_CATALOG);
    // 목록 순서는 점수 그대로(편집 전용 '한글 문서 편집'이 9점으로 1위)…
    expect(sectionNames(catalog)[0]).toBe('한글 문서 편집');
    // …추천은 작성 요청에서 편집 전용을 빼는 pickSkill의 결과.
    expect(hintNames(catalog)).toEqual([pickSkill(prompt, BUNDLED_CATALOG)?.name]);
    expect(hintNames(catalog)).toEqual(['문서 문체']);
    // 첫머리: 안내 첫 줄 바로 다음 줄이고, 지침 본문들보다 앞이다.
    const lines = catalog.split('\n');
    expect(lines[1]).toBe('(낱말 기준 추천: 문서 문체 — 참고만 하고 요청의 의미로 판단하세요.)');
    expect(catalog.indexOf('(낱말 기준 추천:')).toBeLessThan(catalog.indexOf('\n### '));
  });

  it("AC-cee73e04: '사업계획서' 요청의 추천은 사업계획서", () => {
    const catalog = buildSkillCatalog('스마트공장 구축 사업계획서 작성해줘', BUNDLED_CATALOG);
    expect(hintNames(catalog)).toEqual(['사업계획서']);
  });

  it("AC-cee73e04: 맞는 트리거가 없으면 '낱말 기준 추천' 줄이 없고 목록은 그대로 싣는다", () => {
    const prompt = '날씨가 좋네요';
    expect(pickSkill(prompt, BUNDLED_CATALOG)).toBeNull();
    const catalog = buildSkillCatalog(prompt, BUNDLED_CATALOG);
    expect(catalog).not.toContain('낱말 기준 추천');
    expect(hintNames(catalog)).toEqual([]);
    expect(sectionNames(catalog)).toEqual(BUNDLED_CATALOG.map((s) => s.name));
    for (const s of BUNDLED_CATALOG) expect(catalog, s.name).toContain(s.body);
  });

  it("AC-cee73e04: 편집 전용 스킬(mode: edit)에만 '기존 문서 편집 전용' 표시가 붙는다", () => {
    const catalog = buildSkillCatalog('분기 실적 보고서 작성해줘', BUNDLED_CATALOG);
    expect(headings(catalog).filter((h) => h.editOnly).map((h) => h.name)).toEqual(['한글 문서 편집']);
    // 표시는 그 제목 줄에 한 번만(다른 스킬·안내문에는 없다).
    expect(catalog.split('기존 문서 편집 전용').length - 1).toBe(1);
  });

  it("AC-cee73e04: mode 머리말이 없는 예전 '한글-문서-편집'(id)·'한글 문서 편집'(이름)에도 표시가 붙는다", () => {
    const plain = catSkill('일반', ['정리']);
    const legacyById: CatalogSkill = { id: '한글-문서-편집', name: '옛 편집기', triggers: ['정리'], body: '옛 본문 1', description: '옛 설명' };
    const legacyByName: CatalogSkill = { id: 'old-edit', name: '한글 문서 편집', triggers: ['정리'], body: '옛 본문 2', description: '옛 설명' };
    for (const legacy of [legacyById, legacyByName]) {
      const catalog = buildSkillCatalog('서식을 정리해줘', [plain, legacy]);
      expect(headings(catalog).map((h) => [h.name, h.editOnly]), legacy.id).toEqual([
        ['일반', false],
        [legacy.name, true],
      ]);
    }
  });

  it('AC-cee73e04: 안내 첫 줄은 지침 하나를 골라 따르고 그 이름을 응답의 skill에 적으라고 한다', () => {
    const first = buildSkillCatalog('공문 작성해줘', BUNDLED_CATALOG).split('\n')[0];
    expect(first.startsWith('[작성 지침 목록]')).toBe(true);
    expect(first).toContain('지침 하나를 골라 따르세요');
    expect(first).toContain('따른 지침의 이름을 응답의 skill에 그대로 적으세요');
    expect(first).toContain('없으면 빈 문자열');
  });

  it('AC-cee73e04: 스킬이 하나도 없으면 빈 문자열', () => {
    expect(buildSkillCatalog('공문 작성해줘', [])).toBe('');
  });
});

describe('F-a7b2c7ba AC-8790cc2f: 목록 첫머리 낱말 기준 추천은 pickSkill이 고른다', () => {
  it('AC-8790cc2f: 합이 같으면 목록은 받은 순서(A 먼저)지만 추천은 가장 긴 트리거가 맞은 B', () => {
    // A: 계획(2)+일정(2)=4(최장 2), B: 사업계획(4)=4(최장 4).
    const a = catSkill('A', ['계획', '일정']);
    const b = catSkill('B', ['사업계획']);
    const catalog = buildSkillCatalog('사업계획 일정 검토', [a, b]);
    expect(sectionNames(catalog)).toEqual(['A', 'B']);
    expect(hintNames(catalog)).toEqual(['B']);
  });
});

describe('F-fb6592e9 AC-a0f16fb6: 본문 합이 상한을 넘으면 점수 낮은 스킬은 이름·설명만', () => {
  // 점수: A(가나다라 4) > B(마바사 3) > C(아자 2) > D(0). 받은 순서는 일부러 거꾸로.
  const a = catSkill('A', ['가나다라'], bodyOf('A', 40), '설명A');
  const b = catSkill('B', ['마바사'], bodyOf('B', 50), '설명B');
  const c = catSkill('C', ['아자'], bodyOf('C', 5), '설명C');
  const d = catSkill('D', ['없는낱말'], bodyOf('D', 5), '설명D');
  const prompt = '가나다라 마바사 아자';

  it('AC-a0f16fb6: 상한을 처음 넘는 스킬부터는 뒤의 스킬이 들어갈 자리가 있어도 모두 이름·설명만 남는다', () => {
    // A(40)는 실리고, B(40+50=90 > 60)에서 넘친다. C(40+5=45)는 들어갈 자리가 있지만 점수 순서를 지켜 빠진다.
    expect(a.body.length + c.body.length).toBeLessThanOrEqual(60);
    const catalog = buildSkillCatalog(prompt, [d, c, b, a], 60);
    expect(sectionNames(catalog)).toEqual(['A']);
    expect(catalog).toContain(a.body);
    for (const s of [b, c, d]) expect(catalog, s.name).not.toContain(`[${s.name}본문]`);
    expect(overflowLines(catalog)).toEqual(['- B — 설명B', '- C — 설명C', '- D — 설명D']);
    // 넘친 목록은 실린 지침들 뒤에 온다.
    expect(catalog.indexOf(OVERFLOW_HEAD)).toBeGreaterThan(catalog.indexOf(a.body));
  });

  it('AC-a0f16fb6: 상한과 정확히 같아지는 본문까지는 싣는다', () => {
    // A(40)+B(50)=90 = 상한 → 둘 다 실린다. C(95)부터 넘친다.
    const catalog = buildSkillCatalog(prompt, [d, c, b, a], 90);
    expect(sectionNames(catalog)).toEqual(['A', 'B']);
    expect(catalog).toContain(b.body);
    expect(overflowLines(catalog)).toEqual(['- C — 설명C', '- D — 설명D']);
  });

  it('AC-a0f16fb6: 1순위 본문부터 상한을 넘으면 본문 없이 모두 이름·설명만', () => {
    const catalog = buildSkillCatalog(prompt, [d, c, b, a], 30);
    expect(sectionNames(catalog)).toEqual([]);
    expect(overflowLines(catalog)).toEqual(['- A — 설명A', '- B — 설명B', '- C — 설명C', '- D — 설명D']);
  });

  it('AC-a0f16fb6: 모두 들어가면 이름·설명만 묶음이 없다', () => {
    const catalog = buildSkillCatalog(prompt, [d, c, b, a], 100);
    expect(sectionNames(catalog)).toEqual(['A', 'B', 'C', 'D']);
    expect(catalog).not.toContain(OVERFLOW_HEAD);
    expect(catalog).not.toContain('본문을 싣지 못한');
  });

  it('AC-a0f16fb6: 기본 상한은 16,000자 — 합 16,000자는 모두 싣고 16,001자면 낮은 점수 쪽이 이름·설명만', () => {
    expect(SKILL_CATALOG_MAX_CHARS).toBe(16_000);
    const big = catSkill('큰', ['가나다라'], bodyOf('큰', 10_000), '큰 설명');
    const fits = catSkill('작은', ['마바'], bodyOf('작은', 6_000), '작은 설명');
    const exact = buildSkillCatalog('가나다라 마바', [fits, big]);
    expect(sectionNames(exact)).toEqual(['큰', '작은']);
    expect(overflowLines(exact)).toBeNull();

    const over = catSkill('작은', ['마바'], bodyOf('작은', 6_001), '작은 설명');
    const catalog = buildSkillCatalog('가나다라 마바', [over, big]);
    expect(sectionNames(catalog)).toEqual(['큰']);
    expect(overflowLines(catalog)).toEqual(['- 작은 — 작은 설명']);
  });

  it('AC-a0f16fb6: 번들 기본 스킬은 기본 상한 안에 모두 본문이 실린다', () => {
    const catalog = buildSkillCatalog('보고서 작성해줘', BUNDLED_CATALOG);
    expect(overflowLines(catalog)).toBeNull();
    for (const s of BUNDLED_CATALOG) expect(catalog, s.name).toContain(s.body);
  });
});
