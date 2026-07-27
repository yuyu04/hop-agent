import { describe, it, expect } from 'vitest';
import {
  entryRecordToFormFillEntry,
  pickEntryFormTable,
  type FormSourceTable,
} from './ai-apply';
import type { ResearchNoteEntry } from './ai-bridge';

// --- Fixtures (spec-driven, no implementation knowledge) ---

const sampleEntry: ResearchNoteEntry = {
  title: '테스트 제목',
  body_paragraphs: ['문단1', '문단2', '문단3'],
  recorders: ['홍길동', '박정근'],
  confirmer: '홍길동',
  record_date: '2026.01.02',
  confirm_date: '2026.01.30',
  images: [],
};

// Realistic entry-form table (research-note 표#10, 6 rows x 3 cols).
// Merged cells appear as one representative top-left cell.
const entryFormTable: FormSourceTable = {
  section: 0,
  paragraph: 0,
  control_index: 10,
  rows: 6,
  cols: 3,
  cells: [
    { row: 0, col: 0, text: '제목' },
    { row: 0, col: 1, text: '' },
    { row: 1, col: 0, text: '' },
    { row: 2, col: 0, text: '기록자' },
    { row: 2, col: 2, text: '확인자' },
    { row: 3, col: 0, text: '' },
    { row: 4, col: 0, text: '기록 일자' },
    { row: 4, col: 2, text: '확인 일자' },
    { row: 5, col: 0, text: '' },
  ],
};

// Non-entry table: 대외비 box (must NOT be picked)
const confidentialBox: FormSourceTable = {
  section: 0,
  paragraph: 0,
  control_index: 1,
  rows: 2,
  cols: 1,
  cells: [
    { row: 0, col: 0, text: '대외비(Confidential)' },
    { row: 1, col: 0, text: '관리번호 : RS-2026-00000000-001' },
  ],
};

// Non-entry table: 목차 table (must NOT be picked)
const tocTable: FormSourceTable = {
  section: 0,
  paragraph: 0,
  control_index: 2,
  rows: 3,
  cols: 3,
  cells: [
    { row: 0, col: 0, text: '일련번호' },
    { row: 0, col: 1, text: '제목(내용)' },
    { row: 0, col: 2, text: '비고' },
    { row: 1, col: 0, text: '1' },
    { row: 1, col: 1, text: '과제명' },
    { row: 1, col: 2, text: '' },
    { row: 2, col: 0, text: '2' },
    { row: 2, col: 1, text: '개요' },
    { row: 2, col: 2, text: '' },
  ],
};

// --- AC-5bc13234 [ubiquitous] ---
describe('AC-5bc13234 entryRecordToFormFillEntry maps EntryRecord -> FormFillEntry', () => {
  const entry = entryRecordToFormFillEntry(sampleEntry);

  const fieldValue = (label: string): string | undefined =>
    entry.fields.find((f) => f.label === label)?.value;

  it('AC-5bc13234: title -> field label 제목', () => {
    expect(fieldValue('제목')).toBe('테스트 제목');
  });

  it("AC-5bc13234: recorders (string[]) joined with ', ' -> field label 기록자", () => {
    expect(fieldValue('기록자')).toBe('홍길동, 박정근');
  });

  it('AC-5bc13234: confirmer -> field label 확인자', () => {
    expect(fieldValue('확인자')).toBe('홍길동');
  });

  it('AC-5bc13234: record_date -> field label 기록 일자', () => {
    expect(fieldValue('기록 일자')).toBe('2026.01.02');
  });

  it('AC-5bc13234: confirm_date -> field label 확인 일자', () => {
    expect(fieldValue('확인 일자')).toBe('2026.01.30');
  });

  it('AC-5bc13234: body_paragraphs (string[]) -> entry.body', () => {
    expect(entry.body).toEqual(['문단1', '문단2', '문단3']);
  });
});

// --- AC-d4d08e14 [ubiquitous] ---
describe('AC-d4d08e14 pickEntryFormTable selects the entry-form table', () => {
  it('AC-d4d08e14: picks the table whose cells include 기록자 AND 기록 일자', () => {
    expect(pickEntryFormTable([entryFormTable])).toBe(entryFormTable);
  });

  it('AC-d4d08e14: does NOT pick 대외비/목차 tables lacking the combination', () => {
    expect(pickEntryFormTable([confidentialBox, tocTable])).toBeNull();
  });

  it('AC-d4d08e14: among mixed tables, picks the entry-form table', () => {
    expect(
      pickEntryFormTable([confidentialBox, tocTable, entryFormTable]),
    ).toBe(entryFormTable);
  });
});

// --- AC-9e3c4903 [unwanted] ---
describe('AC-9e3c4903 pickEntryFormTable returns null when no entry-form table exists', () => {
  it('AC-9e3c4903: given only non-entry tables, returns null (no arbitrary pick)', () => {
    expect(pickEntryFormTable([confidentialBox, tocTable])).toBeNull();
  });

  it('AC-9e3c4903: empty input returns null', () => {
    expect(pickEntryFormTable([])).toBeNull();
  });
});
