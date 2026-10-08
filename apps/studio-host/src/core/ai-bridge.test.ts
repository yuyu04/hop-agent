// 회귀 테스트: AI가 문단 번호·정렬·줄간격, 쪽 방향·여백, 자동 쪽 번호, 글꼴·형광펜까지 직접 지정한다 (F-45cee3df).
import { describe, expect, it } from 'vitest';
import { interpretAiFailure, parseActionScript } from './ai-bridge';

describe('interpretAiFailure', () => {
  it('maps known codes to Korean messages', () => {
    expect(interpretAiFailure('PARSE_ERROR')).toContain('정형화된 데이터');
    expect(interpretAiFailure('WHITELIST_VIOLATION')).toContain('존재하지 않는 대상');
    expect(interpretAiFailure('TIMEOUT')).toContain('초과');
    expect(interpretAiFailure('CANCELLED')).toContain('취소');
    expect(interpretAiFailure('PROVIDER_ERROR')).toContain('제공자');
  });

  it('falls back for unknown codes', () => {
    expect(interpretAiFailure('SOMETHING_ELSE')).toContain('알 수 없는');
  });
});

describe('parseActionScript', () => {
  it('parses a valid action script', () => {
    const json = JSON.stringify({
      edits: [
        { command: 'INSERT_AFTER', target_id: 'sec[0].p[0]', payload: { type: 'paragraph', text: 'x' } },
      ],
    });
    const script = parseActionScript(json);
    expect(script).not.toBeNull();
    expect(script?.edits[0].command).toBe('INSERT_AFTER');
    expect(script?.edits[0].target_id).toBe('sec[0].p[0]');
  });

  it('returns null for malformed json', () => {
    expect(parseActionScript('{not json')).toBeNull();
  });

  it('returns null when edits is missing', () => {
    expect(parseActionScript(JSON.stringify({ foo: 1 }))).toBeNull();
  });
});
