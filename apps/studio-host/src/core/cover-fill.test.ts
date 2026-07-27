import { describe, it, expect } from 'vitest';
import {
  pickCoverTable,
  pickCoverHeaderTable,
  applyCoverFill,
  type FormSourceTable,
  type WasmEditing,
} from './ai-apply';
import type { ResearchNoteCover } from './ai-bridge';

// ── 픽스처: 연구노트 표지 표(자간 공백 라벨 "기 관 명" 등) ─────────────────────
//
// 실제 표지는 11×4이지만 판정 로직(라벨 정규화·인접 값칸·row-major 슬롯)에 필요한
// 최소 구조(8×2)로 축약한다. 기록자 라벨 뒤에 명단 슬롯 4칸(템플릿 샘플 이름):
//   (5,1) "홍길동"(번호 없음), (6,0) "2. 임꺽정", (6,1) "3. 홍준호", (7,0) "4. 박정근".
const COVER_TABLE: FormSourceTable = {
  section: 0,
  paragraph: 5,
  control_index: 0,
  rows: 8,
  cols: 2,
  cells: [
    { row: 0, col: 0, role: 'label', text: '기 관 명' },
    { row: 0, col: 1, role: 'label', text: '한국전자기술연구원' }, // 프리필 샘플 값
    { row: 1, col: 0, role: 'label', text: '부 서 명' },
    { row: 1, col: 1, role: 'input', text: '' }, // 빈 값칸(delete 불필요 경로)
    { row: 2, col: 0, role: 'label', text: '연구과제명' },
    { row: 2, col: 1, role: 'label', text: '샘플 과제명' },
    { row: 3, col: 0, role: 'label', text: '연구 기간' },
    { row: 3, col: 1, role: 'label', text: '2025.01.01 ~ 2025.12.31' },
    { row: 4, col: 0, role: 'label', text: '연구책임자' },
    { row: 4, col: 1, role: 'label', text: '김책임' },
    { row: 5, col: 0, role: 'label', text: '기 록 자' },
    { row: 5, col: 1, role: 'label', text: '홍길동' },
    { row: 6, col: 0, role: 'label', text: '2. 임꺽정' },
    { row: 6, col: 1, role: 'label', text: '3. 홍준호' },
    { row: 7, col: 0, role: 'label', text: '4. 박정근' },
  ],
};

// 표지 상단 관리번호 표(2×1). 셀 0의 문단 구성: p0="관리번호 : …-001", p1="(Serial No.)".
const HEADER_P0 = '관리번호 : RS-2026-25465309-001';
const HEADER_P1 = '(Serial No.)';
const HEADER_TABLE: FormSourceTable = {
  section: 0,
  paragraph: 1,
  control_index: 0,
  rows: 2,
  cols: 1,
  cells: [
    { row: 0, col: 0, text: `${HEADER_P0}${HEADER_P1}` },
    { row: 1, col: 0, text: '국가연구개발 연구노트' },
  ],
};

// 표지 표와 무관한 엔트리 양식(제목/기록자만 — 기관명·연구과제명 없음).
const ENTRY_TABLE: FormSourceTable = {
  section: 0,
  paragraph: 9,
  control_index: 0,
  rows: 2,
  cols: 2,
  cells: [
    { row: 0, col: 0, role: 'label', text: '제목' },
    { row: 0, col: 1, role: 'input', text: '' },
    { row: 1, col: 0, role: 'label', text: '기록자' },
    { row: 1, col: 1, role: 'input', text: '' },
  ],
};

const COVER: ResearchNoteCover = {
  manage_no: '관리번호 : RS-2026-25465309-002',
  org: '한국기술연구원',
  dept: '융합연구부',
  project: '차세대 문서 자동화 연구',
  period: '2026.01.01 ~ 2026.12.31',
  lead: '홍길동',
  recorders: ['가나다', '라마바'],
};

type Bbox = { cellIdx: number; col: number; row: number; colSpan: number };

// (row,col)→cellIdx: 픽스처 cells의 row-major 순서 그대로 부여한다.
const COVER_BBOXES: Bbox[] = COVER_TABLE.cells.map((c, i) => ({
  cellIdx: i,
  col: c.col,
  row: c.row,
  colSpan: 1,
}));
const HEADER_BBOXES: Bbox[] = HEADER_TABLE.cells.map((c, i) => ({
  cellIdx: i,
  col: c.col,
  row: c.row,
  colSpan: 1,
}));

function coverIdx(row: number, col: number): number {
  const b = COVER_BBOXES.find((x) => x.row === row && x.col === col);
  if (!b) throw new Error(`fixture error: no bbox at (${row},${col})`);
  return b.cellIdx;
}

// 셀 문단 길이 맵: `${parentPara}:${cellIdx},${cellParaIdx}` → 길이.
function buildParaLens(): Record<string, number> {
  const lens: Record<string, number> = {};
  COVER_TABLE.cells.forEach((c, i) => {
    lens[`${COVER_TABLE.paragraph}:${i},0`] = (c.text ?? '').length;
  });
  // 관리번호 셀은 두 문단: p0="관리번호 : …-001", p1="(Serial No.)".
  lens[`${HEADER_TABLE.paragraph}:0,0`] = HEADER_P0.length;
  lens[`${HEADER_TABLE.paragraph}:0,1`] = HEADER_P1.length;
  lens[`${HEADER_TABLE.paragraph}:1,0`] = (HEADER_TABLE.cells[1].text ?? '').length;
  return lens;
}

/** WasmEditing 목 — applyCoverFill이 만지는 셀 채움 API만 기록한다. */
class FakeCoverWasm {
  log: string[] = [];
  deletes: { para: number; cellIdx: number; cellParaIdx: number; charOffset: number; count: number }[] = [];
  inserts: { para: number; cellIdx: number; cellParaIdx: number; charOffset: number; text: string }[] = [];
  bboxCalls = 0;

  private bboxesByPara: Record<number, Bbox[]> = {
    [COVER_TABLE.paragraph]: COVER_BBOXES,
    [HEADER_TABLE.paragraph]: HEADER_BBOXES,
  };
  private paraLens = buildParaLens();

  getTableCellBboxes(_sec: number, parentPara: number): Bbox[] {
    this.bboxCalls += 1;
    const boxes = this.bboxesByPara[parentPara];
    if (!boxes) throw new Error(`no bboxes for para ${parentPara}`);
    return boxes;
  }
  getCellParagraphLength(
    _sec: number,
    parentPara: number,
    _ci: number,
    cellIdx: number,
    cellParaIdx: number,
  ): number {
    return this.paraLens[`${parentPara}:${cellIdx},${cellParaIdx}`] ?? 0;
  }
  deleteTextInCell(
    _sec: number,
    parentPara: number,
    _ci: number,
    cellIdx: number,
    cellParaIdx: number,
    charOffset: number,
    count: number,
  ): string {
    this.deletes.push({ para: parentPara, cellIdx, cellParaIdx, charOffset, count });
    this.log.push(`del(${parentPara}:${cellIdx},${cellParaIdx})`);
    return '{"ok":true}';
  }
  insertTextInCell(
    _sec: number,
    parentPara: number,
    _ci: number,
    cellIdx: number,
    cellParaIdx: number,
    charOffset: number,
    text: string,
  ): string {
    this.inserts.push({ para: parentPara, cellIdx, cellParaIdx, charOffset, text });
    this.log.push(`ins(${parentPara}:${cellIdx},${cellParaIdx})=${text}`);
    return '{"ok":true}';
  }
  splitParagraphInCell(): string {
    this.log.push('split');
    return '{"ok":true}';
  }
}

function asWasm(w: unknown): WasmEditing {
  return w as WasmEditing;
}

describe('F-cover-fill pickCoverTable / pickCoverHeaderTable', () => {
  it('자간 공백 라벨("기 관 명")이어도 기관명+연구과제명을 함께 가진 표를 고른다', () => {
    expect(pickCoverTable([ENTRY_TABLE, COVER_TABLE, HEADER_TABLE])).toBe(COVER_TABLE);
  });

  it('기관명·연구과제명 쌍이 없으면 null (엔트리 양식/관리번호 표만 있는 경우)', () => {
    expect(pickCoverTable([ENTRY_TABLE, HEADER_TABLE])).toBeNull();
    expect(pickCoverTable([])).toBeNull();
  });

  it('pickCoverHeaderTable은 관리번호 셀이 있는 표를 고른다', () => {
    expect(pickCoverHeaderTable([ENTRY_TABLE, COVER_TABLE, HEADER_TABLE])).toBe(HEADER_TABLE);
  });

  it('관리번호 셀이 어디에도 없으면 null', () => {
    expect(pickCoverHeaderTable([ENTRY_TABLE, COVER_TABLE])).toBeNull();
  });
});

describe('F-cover-fill applyCoverFill — 라벨 인접 값칸 채움', () => {
  it('org/dept/project/period/lead를 라벨 오른쪽 값칸(cellIdx)에 기입한다', () => {
    const wasm = new FakeCoverWasm();
    const result = applyCoverFill(asWasm(wasm), COVER_TABLE, HEADER_TABLE, COVER);

    const expectFilled = (row: number, col: number, text: string): void => {
      const idx = coverIdx(row, col);
      const ins = wasm.inserts.find(
        (i) => i.para === COVER_TABLE.paragraph && i.cellIdx === idx,
      );
      expect(ins, `(${row},${col}) cellIdx=${idx}`).toBeDefined();
      expect(ins).toMatchObject({ cellParaIdx: 0, charOffset: 0, text });
    };
    expectFilled(0, 1, COVER.org);
    expectFilled(1, 1, COVER.dept);
    expectFilled(2, 1, COVER.project);
    expectFilled(3, 1, COVER.period);
    expectFilled(4, 1, COVER.lead);

    // 라벨칸 자체는 절대 건드리지 않는다(열 0의 라벨들).
    const labelIdxs = [0, 1, 2, 3, 4].map((r) => coverIdx(r, 0));
    for (const idx of labelIdxs) {
      expect(wasm.inserts.some((i) => i.para === COVER_TABLE.paragraph && i.cellIdx === idx)).toBe(false);
      expect(wasm.deletes.some((d) => d.para === COVER_TABLE.paragraph && d.cellIdx === idx)).toBe(false);
    }

    // 총 채움: 라벨 값 5 + 기록자 슬롯 4(명단 2 + 비움 2) + 관리번호 1.
    expect(result.filled).toBe(10);
    expect(result.skipped).toEqual([]);
  });

  it('프리필 값칸은 기존 텍스트를 먼저 지운 뒤 넣는다(delete → insert 순서)', () => {
    const wasm = new FakeCoverWasm();
    applyCoverFill(asWasm(wasm), COVER_TABLE, HEADER_TABLE, COVER);

    const idx = coverIdx(0, 1); // "한국전자기술연구원" 프리필
    const p = COVER_TABLE.paragraph;
    const delAt = wasm.log.indexOf(`del(${p}:${idx},0)`);
    const insAt = wasm.log.indexOf(`ins(${p}:${idx},0)=${COVER.org}`);
    expect(delAt).toBeGreaterThanOrEqual(0);
    expect(insAt).toBeGreaterThan(delAt);
    const del = wasm.deletes.find((d) => d.para === p && d.cellIdx === idx)!;
    expect(del).toMatchObject({ cellParaIdx: 0, charOffset: 0, count: '한국전자기술연구원'.length });
  });

  it('빈 값칸(부서명)은 delete 없이 insert만 한다', () => {
    const wasm = new FakeCoverWasm();
    applyCoverFill(asWasm(wasm), COVER_TABLE, HEADER_TABLE, COVER);

    const idx = coverIdx(1, 1); // 빈 입력칸
    expect(wasm.deletes.some((d) => d.para === COVER_TABLE.paragraph && d.cellIdx === idx)).toBe(false);
    expect(
      wasm.inserts.filter((i) => i.para === COVER_TABLE.paragraph && i.cellIdx === idx),
    ).toEqual([
      { para: COVER_TABLE.paragraph, cellIdx: idx, cellParaIdx: 0, charOffset: 0, text: COVER.dept },
    ]);
  });

  it('docx 빈 값 필드는 건드리지 않는다(양식 값 보존, skipped에도 안 남음)', () => {
    const wasm = new FakeCoverWasm();
    const partial: ResearchNoteCover = {
      manage_no: '',
      org: '',
      dept: '',
      project: '차세대 문서 자동화 연구',
      period: '',
      lead: '',
      recorders: [],
    };
    const result = applyCoverFill(asWasm(wasm), COVER_TABLE, HEADER_TABLE, partial);

    expect(result.filled).toBe(1); // 연구과제명만
    expect(result.skipped).toEqual([]);
    const touched = new Set(
      [...wasm.inserts, ...wasm.deletes]
        .filter((c) => c.para === COVER_TABLE.paragraph)
        .map((c) => c.cellIdx),
    );
    expect([...touched]).toEqual([coverIdx(2, 1)]);
    // 관리번호 표도 건드리지 않는다.
    expect(wasm.inserts.some((i) => i.para === HEADER_TABLE.paragraph)).toBe(false);
  });
});

describe('F-cover-fill applyCoverFill — 기록자 명단 슬롯', () => {
  // 슬롯(row-major): (5,1)"홍길동" → (6,0)"2. 임꺽정" → (6,1)"3. 홍준호" → (7,0)"4. 박정근".
  it('슬롯 1은 이름만(템플릿에 번호 없음), 슬롯 2는 "2. 이름"(템플릿 번호 상속)', () => {
    const wasm = new FakeCoverWasm();
    applyCoverFill(asWasm(wasm), COVER_TABLE, HEADER_TABLE, COVER);

    const slot1 = wasm.inserts.find(
      (i) => i.para === COVER_TABLE.paragraph && i.cellIdx === coverIdx(5, 1),
    );
    expect(slot1).toMatchObject({ cellParaIdx: 0, charOffset: 0, text: '가나다' });

    const slot2 = wasm.inserts.find(
      (i) => i.para === COVER_TABLE.paragraph && i.cellIdx === coverIdx(6, 0),
    );
    expect(slot2).toMatchObject({ cellParaIdx: 0, charOffset: 0, text: '2. 라마바' });
  });

  it('명단보다 많은 슬롯 3·4는 비운다(delete만, 텍스트 insert 없음 — 샘플 이름 잔존 방지)', () => {
    const wasm = new FakeCoverWasm();
    applyCoverFill(asWasm(wasm), COVER_TABLE, HEADER_TABLE, COVER);

    for (const [row, col, tmpl] of [
      [6, 1, '3. 홍준호'],
      [7, 0, '4. 박정근'],
    ] as [number, number, string][]) {
      const idx = coverIdx(row, col);
      const dels = wasm.deletes.filter(
        (d) => d.para === COVER_TABLE.paragraph && d.cellIdx === idx,
      );
      expect(dels, `slot (${row},${col})`).toEqual([
        { para: COVER_TABLE.paragraph, cellIdx: idx, cellParaIdx: 0, charOffset: 0, count: tmpl.length },
      ]);
      // 빈 줄은 insert를 아예 호출하지 않는다(fillCellLinesFlat의 falsy 줄 생략).
      expect(
        wasm.inserts.some((i) => i.para === COVER_TABLE.paragraph && i.cellIdx === idx),
      ).toBe(false);
    }
  });
});

describe('F-cover-fill applyCoverFill — 관리번호(헤더 표)', () => {
  it('관리번호 셀의 첫 문단만 교체하고 "(Serial No.)" 등 뒤 문단은 보존한다', () => {
    const wasm = new FakeCoverWasm();
    applyCoverFill(asWasm(wasm), COVER_TABLE, HEADER_TABLE, COVER);

    const p = HEADER_TABLE.paragraph;
    // p0: 기존 길이만큼 delete 후 manage_no insert.
    expect(wasm.deletes.filter((d) => d.para === p)).toEqual([
      { para: p, cellIdx: 0, cellParaIdx: 0, charOffset: 0, count: HEADER_P0.length },
    ]);
    expect(wasm.inserts.filter((i) => i.para === p)).toEqual([
      { para: p, cellIdx: 0, cellParaIdx: 0, charOffset: 0, text: COVER.manage_no },
    ]);
    // 뒤 문단(cellParaIdx 1)·다른 셀(cellIdx 1)은 어떤 호출도 받지 않는다.
    const other = [...wasm.deletes, ...wasm.inserts].filter(
      (c) => c.para === p && (c.cellParaIdx !== 0 || c.cellIdx !== 0),
    );
    expect(other).toEqual([]);
  });
});

describe('F-cover-fill applyCoverFill — no-op/skip 보고', () => {
  it('표지·헤더 표가 모두 없으면 채우지 않고 사유를 skipped로 보고한다', () => {
    const wasm = new FakeCoverWasm();
    const result = applyCoverFill(asWasm(wasm), null, null, COVER);

    expect(result.filled).toBe(0);
    expect(result.skipped).toEqual([
      { label: '표지', reason: '표지 표를 찾지 못함' },
      { label: '관리번호', reason: '관리번호 표를 찾지 못함' },
    ]);
    expect(wasm.inserts).toEqual([]);
    expect(wasm.deletes).toEqual([]);
  });

  it('cover가 없으면(null) wasm을 전혀 호출하지 않고 {filled: 0}을 반환한다', () => {
    const wasm = new FakeCoverWasm();
    const result = applyCoverFill(asWasm(wasm), COVER_TABLE, HEADER_TABLE, null);

    expect(result).toEqual({ filled: 0, skipped: [] });
    expect(wasm.bboxCalls).toBe(0);
    expect(wasm.log).toEqual([]);
  });

  it('getTableCellBboxes가 없으면 사유와 함께 전체를 건너뛴다', () => {
    const bare = {} as unknown as WasmEditing;
    const result = applyCoverFill(bare, COVER_TABLE, HEADER_TABLE, COVER);

    expect(result.filled).toBe(0);
    expect(result.skipped).toEqual([{ label: '표지', reason: '셀 좌표 조회 API 없음' }]);
  });
});
