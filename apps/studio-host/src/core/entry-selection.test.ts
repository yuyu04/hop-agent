import { describe, it, expect } from 'vitest';
import { parseEntrySelection } from './ai-apply';

const set = (...n: number[]) => new Set(n);

describe('parseEntrySelection — docx 부분 선택 명령 파싱', () => {
  it('선택 표현 없으면 null(=전체)', () => {
    expect(parseEntrySelection('연구노트 docx를 양식으로 변환해줘', 45)).toBeNull();
    expect(parseEntrySelection('', 45)).toBeNull();
  });
  it('단일 번호 "8번만"', () => {
    expect(parseEntrySelection('8번만 양식에 추가해줘', 45)).toEqual(set(8));
  });
  it('여러 번호 "3, 5, 9번"', () => {
    expect(parseEntrySelection('3, 5, 9번 항목 넣어줘', 45)).toEqual(set(3, 5, 9));
  });
  it('범위 "3~7"', () => {
    expect(parseEntrySelection('3~7 항목만 변환', 45)).toEqual(set(3, 4, 5, 6, 7));
  });
  it('범위 "3번부터 7번까지"', () => {
    expect(parseEntrySelection('3번부터 7번까지만 넣어줘', 45)).toEqual(set(3, 4, 5, 6, 7));
  });
  it('범위 "10에서 12"', () => {
    expect(parseEntrySelection('10에서 12 추가', 45)).toEqual(set(10, 11, 12));
  });
  it('처음 K개', () => {
    expect(parseEntrySelection('처음 5개만 양식 추가', 45)).toEqual(set(1, 2, 3, 4, 5));
  });
  it('마지막 K개', () => {
    expect(parseEntrySelection('마지막 3개만 넣어줘', 45)).toEqual(set(43, 44, 45));
  });
  it('범위는 total로 클램프', () => {
    expect(parseEntrySelection('40~99번', 45)).toEqual(set(40, 41, 42, 43, 44, 45));
  });
  it('역순 범위도 정규화', () => {
    expect(parseEntrySelection('7~3번', 45)).toEqual(set(3, 4, 5, 6, 7));
  });
  it('first/last 영문', () => {
    expect(parseEntrySelection('first 2', 45)).toEqual(set(1, 2));
    expect(parseEntrySelection('last 2', 45)).toEqual(set(44, 45));
  });
});
