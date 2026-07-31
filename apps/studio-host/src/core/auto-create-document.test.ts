/**
 * F-d448f667 문서 없이 들어온 요구의 처리 판정.
 *
 * 이 한 함수가 "언제 빈 문서를 만들어도 되는가"의 전부다. 넓게 잡으면 답할 대상이
 * 없는 질문에 쓰레기 문서가 생기고, 좁게 잡으면 사용자가 다시 '먼저 문서를 여세요'를
 * 만난다. 경계를 테스트로 못 박는다.
 */
import { describe, it, expect } from 'vitest';
import { shouldAutoCreateDocument } from './ai-apply';

describe('F-d448f667 AC-001 — 빈 문서가 필요한 요구면 만든다', () => {
  it('편집 모드 지시는 첨부가 없어도 만든다 — 새로 써 달라는 요구다', () => {
    expect(shouldAutoCreateDocument('edit', false)).toBe(true);
  });

  it('첨부가 있으면 모드와 무관하게 만든다 — 내용을 담을 곳이 필요하다', () => {
    expect(shouldAutoCreateDocument('edit', true)).toBe(true);
    expect(shouldAutoCreateDocument('ask', true)).toBe(true);
  });
});

describe('F-d448f667 AC-002 — 빈 문서가 무의미한 요구면 만들지 않는다', () => {
  it('첨부 없는 질문(ask)은 만들지 않는다 — 빈 문서에는 답할 내용이 없다', () => {
    expect(shouldAutoCreateDocument('ask', false)).toBe(false);
  });
});
