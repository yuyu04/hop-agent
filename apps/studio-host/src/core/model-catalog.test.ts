/**
 * F-ec1f3481 모델 카탈로그 — 내장 기본값 세대(AC-002), 조회 실패 폴백(AC-003),
 * CLI 위임 예외(AC-004)를 계약으로 고정한다.
 *
 * 여기서 지키는 것은 "사용자가 모델 ID를 외워 적지 않아도 되는가"다: 기본 선택이
 * 현행 세대여야 하고, 조회가 실패해도 목록이 비어선 안 되고, 조회 결과가 오면
 * 권장 모델이 맨 앞(=기본 선택)에 와야 한다.
 */
import { describe, it, expect } from 'vitest';
import {
  BUILTIN_MODELS,
  builtinModels,
  defaultModel,
  isSelectableModel,
  mergeModelList,
  supportsModelListing,
} from './model-catalog';

describe('F-ec1f3481 AC-002 — 내장 기본값이 현행 세대다', () => {
  it('anthropic 기본값은 Claude 5 계열이다 — 구세대 3.5가 기본으로 남지 않는다', () => {
    expect(defaultModel('anthropic')).toBe('claude-opus-5');
    expect(BUILTIN_MODELS.anthropic).toContain('claude-sonnet-5');
    expect(BUILTIN_MODELS.anthropic).toContain('claude-haiku-4-5');
    expect(BUILTIN_MODELS.anthropic.some((id) => id.startsWith('claude-3'))).toBe(false);
  });

  it('gemini 기본값은 자체 갱신되는 -latest 별칭이다 — 목록을 손보지 않아도 최신을 탄다', () => {
    expect(defaultModel('gemini')).toBe('gemini-flash-latest');
  });

  it('모든 provider가 기본값을 가진다(빈 문자열 모델로 요청하지 않게)', () => {
    for (const provider of Object.keys(BUILTIN_MODELS)) {
      expect(defaultModel(provider), provider).toBeTruthy();
    }
  });

  it('알 수 없는 provider도 빈 값이 아닌 기본값으로 폴백한다', () => {
    expect(defaultModel('없는-provider')).toBe(BUILTIN_MODELS.gemini[0]);
    expect(builtinModels('없는-provider')).toEqual([]);
  });
});

describe('F-ec1f3481 AC-001 — 조회 결과를 드롭다운 순서로 정규화한다', () => {
  it('권장(내장) 모델을 내장 순서대로 앞에 올린다 — 알파벳 응답에서도 기본 선택이 맞다', () => {
    const listed = ['claude-haiku-4-5', 'claude-opus-4-1', 'claude-opus-5', 'claude-sonnet-5'];

    const merged = mergeModelList('anthropic', listed);

    expect(merged[0]).toBe('claude-opus-5');
    expect(merged.slice(0, 3)).toEqual(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
    // 내장에 없는 모델도 버리지 않는다 — 조회의 목적은 "전부 보여주기"다.
    expect(merged).toContain('claude-opus-4-1');
  });

  it('내장에 없는 신모델만 와도 그대로 쓴다 — 카탈로그를 손대지 않고 최신을 고를 수 있다', () => {
    expect(mergeModelList('anthropic', ['claude-opus-6', 'claude-sonnet-6'])).toEqual([
      'claude-opus-6',
      'claude-sonnet-6',
    ]);
  });

  it('중복·공백 ID를 정리한다', () => {
    expect(mergeModelList('ollama', ['llama3.2', ' ', 'llama3.2', 'phi4'])).toEqual([
      'llama3.2',
      'phi4',
    ]);
  });

  it('OpenAI 목록의 비대화형 모델(음성·이미지·임베딩)은 감춘다', () => {
    const merged = mergeModelList('openai', [
      'gpt-4o-mini',
      'whisper-1',
      'dall-e-3',
      'text-embedding-3-small',
      'omni-moderation-latest',
      'gpt-4o-realtime-preview',
      'gpt-5',
    ]);

    expect(merged).toEqual(['gpt-5', 'gpt-4o-mini']);
  });

  it('비-OpenAI provider는 걸러내지 않는다 — 이름 규칙이 다르다', () => {
    expect(isSelectableModel('ollama', 'llava-image')).toBe(true);
    expect(isSelectableModel('gemini', 'gemini-embedding-001')).toBe(true);
    expect(isSelectableModel('openai', 'text-embedding-3-large')).toBe(false);
  });
});

describe('F-ec1f3481 AC-003 — 조회가 쓸 값을 못 주면 빈 목록을 돌려준다(호출부가 내장 유지)', () => {
  it('응답이 비었거나 전부 걸러지면 빈 배열 — 드롭다운을 비우는 판단은 호출부가 하지 않는다', () => {
    expect(mergeModelList('anthropic', [])).toEqual([]);
    expect(mergeModelList('openai', ['whisper-1', 'dall-e-3'])).toEqual([]);
    expect(mergeModelList('anthropic', ['  ', ''])).toEqual([]);
  });
});

describe('F-ec1f3481 AC-004 — CLI 위임은 모델 목록 API가 없다', () => {
  it('claude-cli·agy-cli·gemini-cli는 조회 대상이 아니다', () => {
    expect(supportsModelListing('claude-cli')).toBe(false);
    expect(supportsModelListing('agy-cli')).toBe(false);
    expect(supportsModelListing('gemini-cli')).toBe(false);
  });

  it('키/HTTP를 쓰는 provider는 조회 대상이다', () => {
    for (const provider of ['anthropic', 'openai', 'gemini', 'ollama', 'openai-compat']) {
      expect(supportsModelListing(provider), provider).toBe(true);
    }
  });

  it('CLI 별칭 목록은 모델 ID가 아니라 CLI가 아는 별칭이다', () => {
    expect(BUILTIN_MODELS['claude-cli']).toEqual(['default', 'sonnet', 'opus', 'haiku']);
    expect(defaultModel('claude-cli')).toBe('default');
    expect(defaultModel('agy-cli')).toBe('default');
  });
});
