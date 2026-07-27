/**
 * Cladding stage_2.4 functional smoke probe (`project.smoke` in spec.yaml).
 *
 * HOP ships as a Tauri 2 GUI, so the deliverable binary itself cannot be smoked
 * headlessly (it opens a window and never exits — `is_safe_to_smoke: false`). An
 * exit-only probe would only prove liveness, not that the shipped pipeline still
 * produces a correct result. So this probe drives the SAME code the app drives —
 * the rhwp WASM core plus `@/core/ai-apply` — end to end in plain Node:
 *
 *   createNewDocument → build a 연구노트 cover form (관리번호 표 + 표지 표)
 *     → exportHwp → reload (round-trip #1: does the form survive serialization?)
 *     → collectFormTables + pickCoverTable/pickCoverHeaderTable (real discovery)
 *     → applyCoverFill with a docx-shaped CoverMeta      [F-1e6d84d6 AC-0f4d1836]
 *     → exportHwp → reload (round-trip #2)
 *     → re-read the cells and assert the docx values are actually in the bytes
 *
 * On success it prints the AC token the gate greps for. Any failure — WASM broken,
 * cover table no longer discoverable, values not persisted — fails the gate.
 *
 * Run: pnpm --filter @golbin/hop-studio-host exec vitest run --config vitest.smoke.config.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from 'vitest';

// Shim text measurement BEFORE any WASM init (no DOM in Node). WasmBridge's
// installMeasureTextWidth() early-returns when this is already set.
const g = globalThis as Record<string, unknown>;
if (!g.measureTextWidth) {
  g.measureTextWidth = (font: string, text: string): number => {
    const m = /([\d.]+)px/.exec(font);
    const size = m ? parseFloat(m[1]) : 12;
    let w = 0;
    for (const ch of text) w += (ch.codePointAt(0)! > 0x2000 ? 1.0 : 0.55) * size;
    return w;
  };
}

import init, { version } from '@wasm/rhwp.js';
import { WasmBridge } from '@/core/wasm-bridge';
import {
  applyCoverFill,
  pickCoverHeaderTable,
  pickCoverTable,
  type FormSourceTable,
  type WasmEditing,
} from '@/core/ai-apply';
import type { ResearchNoteCover } from '@/core/ai-bridge';
import { collectFormTables, rawDocOf } from './wasm-form-tables';

const RHWP_WASM = resolve(__dirname, '../../vendor/rhwp-core/rhwp_bg.wasm');

/** The token the gate greps for in stdout (spec.yaml → project.smoke[].expect.token). */
const OK_TOKEN = 'CLAD_SMOKE_OK cover_fill';

/**
 * A 연구노트 표지 form, as the base HWP template lays it out: a 관리번호 header table
 * plus a label/value cover table. Labels carry the template's 자간 공백 ('기 관 명') so
 * the probe also exercises normalized label matching. After the 기록자 label the cells
 * are a grid of numbered name slots, pre-filled with the template's sample names.
 */
const HEADER_ROWS = [['관리번호 RS-2026-00000000-001'], ['(Serial No.)']];
const COVER_ROWS = [
  ['기 관 명', '베이스양식기관'],
  ['부 서 명', '베이스양식부서'],
  ['연구과제명', '베이스양식과제'],
  ['연구 기간', '2026.01.01 ~ 2026.12.31'],
  ['연구책임자', '양식책임자'],
  ['기록자', '1. 양식기록자A'],
  ['2. 양식기록자B', '3. 양식기록자C'],
  ['4. 양식기록자D', '5. 양식기록자E'],
];

/** docx 표지에서 뽑혀 나온 CoverMeta 모양 (ai::docx::parse_cover 출력). */
const COVER: ResearchNoteCover = {
  manage_no: 'RS-2026-00000000-002',
  org: '가나다연구소',
  dept: '기술개발부',
  project: 'HOP 문서 편집 엔진 고도화',
  period: '2026.01.01 ~ 2026.12.31',
  lead: '성춘향',
  recorders: ['홍길동', '임꺽정'],
};

/** 표를 만들고 matrix 텍스트로 채운다. 생성된 표의 (paraIdx, controlIdx)를 돌려준다. */
function createFilledTable(
  bridge: WasmBridge,
  para: number,
  matrix: string[][],
): { paraIdx: number; controlIdx: number } {
  const rows = matrix.length;
  const cols = matrix[0].length;
  const made = bridge.createTable(0, para, 0, rows, cols);
  expect(made.ok, `createTable(${rows}x${cols}) failed`).toBe(true);
  const boxes = bridge.getTableCellBboxes(0, made.paraIdx, made.controlIdx);
  const byRc = new Map(boxes.map((b) => [`${b.row},${b.col}`, b.cellIdx]));
  matrix.forEach((row, r) => {
    row.forEach((text, c) => {
      if (!text) return;
      const cellIdx = byRc.get(`${r},${c}`);
      expect(cellIdx, `cell (${r},${c}) has no bbox`).not.toBeUndefined();
      bridge.insertTextInCell(0, made.paraIdx, made.controlIdx, cellIdx!, 0, 0, text);
    });
  });
  return { paraIdx: made.paraIdx, controlIdx: made.controlIdx };
}

/** exportHwp → loadDocument. Returns the tables discovered in the reloaded document. */
function roundTrip(bridge: WasmBridge, label: string): FormSourceTable[] {
  const bytes = bridge.exportHwp();
  expect(bytes.length, `${label}: exportHwp produced no bytes`).toBeGreaterThan(0);
  bridge.loadDocument(bytes, 'clad-smoke.hwp');
  return collectFormTables(rawDocOf(bridge));
}

/** 표 안에서 (row,col) 셀의 텍스트를 읽는다. */
function cellText(table: FormSourceTable, row: number, col: number): string {
  return table.cells.find((c) => c.row === row && c.col === col)?.text ?? '';
}

/** 같은 표를 좌표로 다시 집는다 — 채운 뒤에는 라벨 텍스트가 사라질 수 있다. */
function sameTable(tables: FormSourceTable[], like: FormSourceTable): FormSourceTable | undefined {
  return tables.find(
    (t) =>
      t.section === like.section &&
      t.paragraph === like.paragraph &&
      t.control_index === like.control_index,
  );
}

test('shipped cover-fill pipeline fills a 연구노트 표지 and survives an HWP round-trip', async () => {
  await init({ module_or_path: readFileSync(RHWP_WASM) });
  const bridge = new WasmBridge();
  await bridge.initialize();

  // 1) Build the base form in a fresh document, then round-trip it.
  //    createNewDocument() is the app's own "새 문서" path (blank2010 template).
  bridge.createNewDocument();
  createFilledTable(bridge, 0, HEADER_ROWS);
  createFilledTable(bridge, 0, COVER_ROWS);

  const formTables = roundTrip(bridge, 'form');
  const coverTable = pickCoverTable(formTables);
  const headerTable = pickCoverHeaderTable(formTables);
  expect(coverTable, '표지 표(기관명+연구과제명)를 찾지 못함').not.toBeNull();
  expect(headerTable, '관리번호 표를 찾지 못함').not.toBeNull();

  // 2) The actual AC: fill the cover from docx-shaped metadata.
  const result = applyCoverFill(
    bridge as unknown as WasmEditing,
    coverTable,
    headerTable,
    COVER,
  );
  expect(result.skipped, `표지 채움 skip: ${JSON.stringify(result.skipped)}`).toEqual([]);
  // 5 label fields + 5 recorder slots (2 filled, 3 cleared) + 관리번호.
  expect(result.filled).toBe(11);

  // 3) Round-trip again — the docx values must be in the exported bytes, not just
  //    in the in-memory model.
  const filledTables = roundTrip(bridge, 'filled');
  // 관리번호 셀은 값으로 교체돼 '관리번호' 라벨이 사라지므로 좌표로 다시 집는다.
  const cover = sameTable(filledTables, coverTable!);
  const header = sameTable(filledTables, headerTable!);
  expect(cover, '채움 후 표지 표가 사라짐').not.toBeUndefined();
  expect(header, '채움 후 관리번호 표가 사라짐').not.toBeUndefined();

  expect(cellText(cover!, 0, 1)).toBe(COVER.org);
  expect(cellText(cover!, 1, 1)).toBe(COVER.dept);
  expect(cellText(cover!, 2, 1)).toBe(COVER.project);
  expect(cellText(cover!, 4, 1)).toBe(COVER.lead);
  // 기록자 슬롯: 번호 접두사 유지, docx 명단보다 많은 잔여 슬롯은 비워진다.
  expect(cellText(cover!, 5, 1)).toBe('1. 홍길동');
  expect(cellText(cover!, 6, 0)).toBe('2. 임꺽정');
  expect(cellText(cover!, 6, 1)).toBe('');
  expect(cellText(cover!, 7, 0)).toBe('');
  expect(cellText(cover!, 7, 1)).toBe('');
  // 관리번호: 첫 문단만 교체되고 '(Serial No.)' 뒤 문단은 보존된다.
  expect(cellText(header!, 0, 0)).toBe(COVER.manage_no);
  expect(cellText(header!, 1, 0)).toBe('(Serial No.)');

  // eslint-disable-next-line no-console
  console.log(
    `${OK_TOKEN} rhwp=${version()} filled=${result.filled} ` +
      `tables=${filledTables.length} manage_no=${cellText(header!, 0, 0)}`,
  );
});
