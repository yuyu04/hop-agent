/**
 * F-5e9c6033 연구노트형이 아닌 첨부도 연구노트로 — 라우팅 판정과 첨부 본문 합성.
 *
 * 두 순수 함수가 이 기능의 계약을 전부 담는다:
 *   wantsResearchNote  — 언제 LLM 양식 채움으로 보낼지(좁게 판정해야 회귀가 없다)
 *   attachmentDocText  — LLM이 첨부 내용을 실제로 볼 수 있게 하는 합성
 */
import { describe, it, expect } from 'vitest';
import { attachmentDocText, wantsResearchNote } from './ai-apply';

describe('F-5e9c6033 AC-001 — 연구노트 의도만 라우팅한다', () => {
  it('사용자가 실제로 쓰는 표현을 잡는다', () => {
    for (const prompt of [
      '이거 읽고 연구노트 만들어줘',
      '첨부한 PDF로 연구노트 작성해줘',
      '연구 노트 만들어줘', // 공백 변형
      '이 자료를  연구  노트로  정리해줘', // 공백 여러 개
      '연구노트',
    ]) {
      expect(wantsResearchNote(prompt), prompt).toBe(true);
    }
  });

  it('줄바꿈·탭이 섞여도 판정한다', () => {
    expect(wantsResearchNote('첨부 참고해서\n연구\t노트 만들어줘')).toBe(true);
  });
});

describe('F-5e9c6033 AC-003 — 다른 요구는 가로채지 않는다', () => {
  it('요약·질문·일반 편집 요청은 라우팅하지 않는다', () => {
    for (const prompt of [
      '이 PDF 요약해줘',
      '첨부 문서에서 핵심만 3줄로',
      '표의 총 사업비를 10억으로 바꿔줘',
      '맞춤법 교정해줘',
      '이 문서 내용 설명해줘',
      '',
    ]) {
      expect(wantsResearchNote(prompt), prompt).toBe(false);
    }
  });

  it("'연구'나 '노트'만 있으면 라우팅하지 않는다 — 과잉 판정 방지", () => {
    expect(wantsResearchNote('연구 배경을 정리해줘')).toBe(false);
    expect(wantsResearchNote('노트 형식으로 요약')).toBe(false);
    expect(wantsResearchNote('연구개발 계획서 다듬어줘')).toBe(false);
  });
});

describe('F-5e9c6033 AC-002 — 첨부 본문을 LLM에 넘긴다', () => {
  it('일반 전송 경로와 같은 형식으로 합친다', () => {
    const text = attachmentDocText([
      { kind: 'doc', name: '동향조사.pdf', text: '첫째 문단\n둘째 문단' },
      { kind: 'doc', name: '메모.docx', text: '메모 내용' },
    ]);

    expect(text).toBe(
      '[첨부 문서: 동향조사.pdf]\n첫째 문단\n둘째 문단\n\n[첨부 문서: 메모.docx]\n메모 내용',
    );
  });

  it('이미지 첨부와 본문 없는 첨부는 건너뛴다', () => {
    const text = attachmentDocText([
      { kind: 'image', name: 'shot.png', text: undefined },
      { kind: 'doc', name: '분석중.pdf', text: '' },
      { kind: 'doc', name: '공백뿐.pdf', text: '   \n  ' },
      { kind: 'doc', name: '본문있음.pdf', text: '내용' },
    ]);

    expect(text).toBe('[첨부 문서: 본문있음.pdf]\n내용');
  });

  it('첨부가 없으면 빈 문자열 — 지시문만 보내는 기존 동작으로 남는다', () => {
    expect(attachmentDocText([])).toBe('');
    expect(attachmentDocText([{ kind: 'image', name: 'a.png' }])).toBe('');
  });
});
