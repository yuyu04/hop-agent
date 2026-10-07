const SANS_FALLBACK = '함초롬돋움';
const SERIF_FALLBACK = '함초롬바탕';

const BLOCKED_FONT_KEYS = new Set([
  'hy헤드라인m',
  'hyheadlinem',
  'hyheadlinemedium',
  'hy견고딕',
  'hygothicextra',
  'hy그래픽',
  'hy그래픽m',
  'hygraphicmedium',
  'hy견명조',
  'hymyeongjoextra',
  'hy신명조',
  'hy중고딕',
  '휴먼명조',
  '휴먼고딕',
  '휴먼옛체',
  '휴먼매직체',
  '휴먼편지체',
  '휴먼둥근헤드라인',
  'hcipoppy',
]);

export function isAuthoringBlockedFontFamily(family: string | null | undefined): boolean {
  const key = fontFamilyKey(family);
  if (!key) return false;
  if (BLOCKED_FONT_KEYS.has(key)) return true;
  if (key.startsWith('휴먼')) return true;
  if (key.startsWith('hci')) return true;
  return /^hy(?:[가-힣]|headline|gothic|graphic|myeong|mj|gt|gp|sn|sm)/i.test(key);
}

function authoringFallbackForFontFamily(family: string | null | undefined): string {
  const key = fontFamilyKey(family);
  if (
    key.includes('명조')
    || key.includes('바탕')
    || key.includes('궁서')
    || key.includes('myeong')
    || key.includes('serif')
  ) {
    return SERIF_FALLBACK;
  }
  return SANS_FALLBACK;
}

export function sanitizeAuthoringFontFamily(family: string): string {
  const trimmed = family.trim();
  if (!trimmed) return trimmed;
  return isAuthoringBlockedFontFamily(trimmed)
    ? authoringFallbackForFontFamily(trimmed)
    : trimmed;
}

export function filterAuthoringFontFamilies(families: Iterable<string>): string[] {
  return Array.from(families)
    .map((family) => family.trim())
    .filter((family) => family && !isAuthoringBlockedFontFamily(family));
}

function fontFamilyKey(family: string | null | undefined): string {
  return (family ?? '')
    .trim()
    .replace(/["']/g, '')
    .replace(/[\s_-]+/g, '')
    .toLocaleLowerCase('ko-KR');
}
