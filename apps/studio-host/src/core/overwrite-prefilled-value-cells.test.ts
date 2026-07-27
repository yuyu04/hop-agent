import { describe, it, expect } from 'vitest';
import {
  buildFormFillMapping,
  type FormSourceTable,
  type FormSourceCell,
  type FormFillEntry,
} from './ai-apply';

/**
 * Conformance test for F-f6c643d1 — Overwrite pre-filled value cells.
 *
 * A value cell is rejected as "a label, not a value" ONLY if its text matches a
 * known LABEL NAME (a field label being mapped, or a meta label:
 * 제목/기록자/확인자/기록 일자/확인 일자), NOT merely because it contains text.
 */

function findFillByText(
  mapping: ReturnType<typeof buildFormFillMapping>,
  text: string,
) {
  return mapping.cellFills.find((f) => f.text === text);
}

describe('F-f6c643d1 — AC: overwrite pre-filled value cells', () => {
  // Primary fixture: research-note entry form, fully pre-filled.
  // 6 rows x 3 cols; merged cells appear as ONE representative top-left coord.
  // ALL cells role:'label' because all have text.
  const cells: FormSourceCell[] = [
    { row: 0, col: 0, role: 'label', text: '제목' },
    { row: 0, col: 1, role: 'label', text: '6. LLM Multi-Agent 아키텍처 설계' },
    { row: 1, col: 0, role: 'label', text: 'iOS body sample...' },
    { row: 2, col: 0, role: 'label', text: '기록자' },
    { row: 2, col: 2, role: 'label', text: '확인자' },
    { row: 3, col: 0, role: 'label', text: '홍길동, 박정근, 홍준호, 송주한' },
    { row: 3, col: 2, role: 'label', text: '홍길동' },
    { row: 4, col: 0, role: 'label', text: '기록 일자' },
    { row: 4, col: 2, role: 'label', text: '확인 일자' },
    { row: 5, col: 0, role: 'label', text: '2025.12.01' },
    { row: 5, col: 2, role: 'label', text: '2025.12.30' },
  ];
  const table: FormSourceTable = { cells } as FormSourceTable;

  const entry: FormFillEntry = {
    fields: [
      { label: '제목', value: 'T' },
      { label: '기록자', value: 'R' },
      { label: '확인자', value: 'C' },
      { label: '기록 일자', value: 'D1' },
      { label: '확인 일자', value: 'D2' },
    ],
    body: ['b1', 'b2'],
  };

  it('resolves every field to its value cell even though value cells already contain sample text (skipped is empty)', () => {
    const mapping = buildFormFillMapping(table, entry);
    expect(mapping.skipped).toEqual([]);
  });

  it('places each field value at its expected value cell, overwriting sample text', () => {
    const mapping = buildFormFillMapping(table, entry);

    const expectations: { value: string; row: number; col: number }[] = [
      { value: 'T', row: 0, col: 1 }, // 제목
      { value: 'R', row: 3, col: 0 }, // 기록자: right (2,1) merged-away -> below (3,0)
      { value: 'C', row: 3, col: 2 }, // 확인자
      { value: 'D1', row: 5, col: 0 }, // 기록 일자
      { value: 'D2', row: 5, col: 2 }, // 확인 일자
    ];

    for (const exp of expectations) {
      const fill = findFillByText(mapping, exp.value);
      expect(fill, `cellFill for value "${exp.value}"`).toBeDefined();
      expect({ row: fill!.row, col: fill!.col }).toEqual({
        row: exp.row,
        col: exp.col,
      });
    }
  });
});

describe('F-f6c643d1 — AC: label↔label adjacency protected', () => {
  // 2-col table: (0,0)'기록자' label, (0,1)'확인자' (a field label),
  // (1,0) value cell. Mapping field 기록자 -> the right neighbor (0,1) is a
  // field label so it must NOT be chosen; falls to below (1,0).
  const cells: FormSourceCell[] = [
    { row: 0, col: 0, role: 'label', text: '기록자' },
    { row: 0, col: 1, role: 'label', text: '확인자' },
    { row: 1, col: 0, role: 'label', text: '홍길동 sample' },
  ];
  const table: FormSourceTable = { cells } as FormSourceTable;

  const entry: FormFillEntry = {
    fields: [
      { label: '기록자', value: 'R' },
      { label: '확인자', value: 'C' },
    ],
  };

  it('does not use a candidate whose text equals a field/meta label as the value cell; resolution falls to the cell below', () => {
    const mapping = buildFormFillMapping(table, entry);

    const fill = findFillByText(mapping, 'R');
    expect(fill, 'cellFill for 기록자 value "R"').toBeDefined();
    expect({ row: fill!.row, col: fill!.col }).toEqual({ row: 1, col: 0 });
    // explicitly: NOT placed at the label cell (0,1)
    expect({ row: fill!.row, col: fill!.col }).not.toEqual({ row: 0, col: 1 });
  });
});

describe('F-f6c643d1 — AC: no regression on empty value cells', () => {
  // Same shape concept but value cells empty (role:'input', text:'').
  const cells: FormSourceCell[] = [
    { row: 0, col: 0, role: 'label', text: '제목' },
    { row: 0, col: 1, role: 'input', text: '' },
  ];
  const table: FormSourceTable = { cells } as FormSourceTable;

  const entry: FormFillEntry = {
    fields: [{ label: '제목', value: 'X' }],
  };

  it('still resolves a field whose value cell is empty (empty cells are value targets, not labels)', () => {
    const mapping = buildFormFillMapping(table, entry);

    expect(mapping.skipped.some((s) => s.label === '제목')).toBe(false);

    const fill = findFillByText(mapping, 'X');
    expect(fill, 'cellFill for value "X"').toBeDefined();
    expect({ row: fill!.row, col: fill!.col }).toEqual({ row: 0, col: 1 });
  });
});
