/**
 * provider별 모델 카탈로그(F-ec1f3481).
 *
 * 하드코딩된 모델 목록은 릴리스마다 낡는다. 그래서 두 층으로 나눈다:
 *  - **내장 목록**: 첫 실행·오프라인·키 없음일 때 쓰는 현행 세대 기본값
 *  - **조회 목록**: `aiListModels`가 provider API에서 받아온 실제 사용 가능한 ID
 *
 * 조회가 성공하면 내장 목록은 "정렬 힌트"로만 남는다 — 조회 결과에서 내장 항목을
 * 앞으로 끌어올려, 알파벳순 응답에서도 권장 모델이 기본 선택되게 한다.
 */

/** 모델 드롭다운에서 "직접 입력"을 고를 때의 sentinel 값. */
export const CUSTOM_MODEL = '__custom__';

/**
 * provider별 내장 모델 목록(첫 항목이 기본 선택).
 *
 * anthropic 목록은 번들된 Claude API 레퍼런스(2026-06 기준) 기반이다. openai·gemini·
 * ollama는 세대 교체가 잦아 "새로 고침"으로 실제 목록을 받는 것이 정답이고, 여기 값은
 * 조회 전 폴백이다. gemini는 자체 갱신되는 `-latest` 별칭을 기본값으로 둔다.
 */
export const BUILTIN_MODELS: Record<string, readonly string[]> = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-4-8'],
  openai: ['gpt-5-mini', 'gpt-5', 'gpt-4.1', 'gpt-4o', 'gpt-4o-mini'],
  gemini: ['gemini-flash-latest', 'gemini-pro-latest', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  ollama: ['llama3.2', 'llama3.1', 'qwen3', 'gemma3', 'mistral'],
  // CLI 위임은 모델 ID가 아니라 CLI가 아는 별칭만 받는다.
  'claude-cli': ['default', 'sonnet', 'opus', 'haiku'],
  'agy-cli': ['default'],
  'openai-compat': ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
};

/** 모델 목록 API가 없는 provider — 별칭만 받으므로 조회를 시도하지 않는다. */
const NO_LISTING_PROVIDERS = new Set(['claude-cli', 'agy-cli', 'gemini-cli']);

export function supportsModelListing(provider: string): boolean {
  return !NO_LISTING_PROVIDERS.has(provider);
}

export function builtinModels(provider: string): readonly string[] {
  return BUILTIN_MODELS[provider] ?? [];
}

/** provider 기본 모델 — 내장 목록의 첫 항목. 목록이 없으면 gemini 기본값으로 폴백. */
export function defaultModel(provider: string): string {
  return builtinModels(provider)[0] ?? BUILTIN_MODELS.gemini[0];
}

/**
 * OpenAI 계열 목록에는 편집에 쓸 수 없는 모델(음성·이미지·임베딩·moderation)이 섞여
 * 온다. 드롭다운을 쓸 만하게 유지하려고 걸러낸다 — 필요하면 "직접 입력"으로 여전히
 * 어떤 ID든 넣을 수 있으므로 과잉 차단이 아니다.
 */
const NON_CHAT_MARKERS = [
  'whisper',
  'tts',
  'dall-e',
  'embedding',
  'moderation',
  'audio',
  'realtime',
  'transcribe',
  'image',
  'davinci',
  'babbage',
];

export function isSelectableModel(provider: string, id: string): boolean {
  if (provider !== 'openai' && provider !== 'openai-compat') return true;
  const lower = id.toLowerCase();
  return !NON_CHAT_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * 조회 결과를 드롭다운 순서로 정규화한다. 내장(권장) 모델을 내장 순서대로 앞에 두고,
 * 나머지 조회 결과를 뒤에 붙인다. 빈 결과는 빈 배열을 돌려주고, 호출부는 내장 목록을
 * 유지한다(조회 실패가 모델 선택 자체를 막지 않는다).
 */
export function mergeModelList(provider: string, fetched: readonly string[]): string[] {
  const usable = new Set<string>();
  for (const raw of fetched) {
    const id = raw.trim();
    if (id && isSelectableModel(provider, id)) usable.add(id);
  }
  if (usable.size === 0) return [];

  const ordered: string[] = [];
  for (const preferred of builtinModels(provider)) {
    if (usable.delete(preferred)) ordered.push(preferred);
  }
  return [...ordered, ...usable];
}
