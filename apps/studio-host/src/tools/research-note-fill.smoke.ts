/**
 * F-86317c64 회귀 방지 — "양식 없는 문서 + 연구노트 N개"가 실제 엔진에서 채워지는가.
 *
 * 2026-08-11 사용자 실사용에서 이 경로가 **빈 양식 표 하나만** 남기고 끝났다. 원인은
 * mock으로는 절대 잡히지 않는 종류였다: 복제 앵커가 생성한 표 '앞'이라 문단 분할이
 * 원본 좌표를 밀어냈고(`copyControl` → "컨트롤 0 범위 초과"), 항목이 0개 붙었다.
 * 그래서 이 검증은 rhwp WASM을 그대로 돌려 결과 문서를 읽는다.
 *
 * createNewDocument → createEntryFormTable → (표 뒤 앵커로) 항목 3개 복제·본문 채움
 *   → 빈 원본 제거 → exportHwp/reload 왕복 → 표 3개와 본문 텍스트가 실제로 남아 있는가
 *
 * Run: pnpm --filter @golbin/hop-studio-host exec vitest run --config vitest.smoke.config.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from 'vitest';

// WASM init 전에 텍스트 측정을 shim한다(Node에는 DOM이 없다).
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

import init from '@wasm/rhwp.js';
import { WasmBridge } from '@/core/wasm-bridge';
import {
  applyActionScript,
  buildFormFillEdits,
  createEntryFormTable,
  resolveBodyCell,
  type WasmEditing,
} from '@/core/ai-apply';
import type { ActionScript } from '@/core/ai-bridge';
import { collectFormTables, rawDocOf } from './wasm-form-tables';

const RHWP_WASM = resolve(__dirname, '../../vendor/rhwp-core/rhwp_bg.wasm');

/** LLM이 돌려준 모양의 항목 3개 — 라벨→값 + 라벨 없는 본문 통칸 단락들. */
const ENTRIES = [1, 2, 3].map((n) => ({
  fields: [
    { label: '제목', value: `${n}주차: 그래프 엔지니어링 시스템 구축` },
    { label: '기록자', value: '홍길동' },
    { label: '기록 일자', value: `2026.01.0${n}` },
  ],
  body: [`${n}주차에 읽은 논문의 핵심을 정리했다.`, `${n}주차 실험 결과와 다음 주 계획.`],
}));

test('양식 없는 문서에서 연구노트 3항목이 본문까지 채워지고 빈 양식은 남지 않는다', async () => {
  await init({ module_or_path: readFileSync(RHWP_WASM) });
  const bridge = new WasmBridge();
  await bridge.initialize();
  bridge.createNewDocument();
  const wasm = bridge as unknown as WasmEditing;

  // 1) 앱이 기본 연구노트 양식을 만든다(문서에 양식이 없을 때의 실제 경로).
  const created = createEntryFormTable(wasm, 0, 0);
  expect(resolveBodyCell(created.table, new Set()), '본문 통칸이 해석되어야 한다').not.toBeNull();

  // 2) 앵커는 만든 표 '뒤' 문단이어야 한다 — 앞이면 분할이 원본을 밀어 복제가 전부 실패한다.
  const anchor = `sec[${created.section}].p[${created.paragraph + 1}]`;
  const plans = buildFormFillEdits(created.table, ENTRIES, anchor);
  const script: ActionScript = { edits: plans.map((p) => p.edit) };
  expect(plans.flatMap((p) => p.skipped), '라벨/본문 매핑이 누락 없이 되어야 한다').toEqual([]);

  const result = applyActionScript(wasm, script, []);
  expect(result.skipped, `복제 실패: ${JSON.stringify(result.skipped)}`).toEqual([]);
  expect(result.applied).toBe(3);

  // 3) 빈 원본 템플릿을 제거한다(채워진 항목만 남게).
  wasm.removeSourceFormTable?.(created.section, created.paragraph, created.controlIndex);

  // 4) 저장 왕복 후에도 남아 있는가 — 바이트에 실제로 들어갔는지까지 확인한다.
  bridge.loadDocument(bridge.exportHwp(), 'research-note.hwp');
  const tables = collectFormTables(rawDocOf(bridge));

  expect(tables.length, '항목 표 3개만 남아야 한다(빈 양식 제거)').toBe(3);
  tables.forEach((table, i) => {
    const text = table.cells.map((c) => c.text ?? '').join('\n');
    expect(text, `${i + 1}번째 항목의 제목`).toContain(`${i + 1}주차: 그래프 엔지니어링 시스템 구축`);
    expect(text, `${i + 1}번째 항목의 기록 일자`).toContain(`2026.01.0${i + 1}`);
    // 본문 통칸 — 제목·날짜만 있고 내용이 비면 연구노트가 아니다.
    expect(text, `${i + 1}번째 항목의 본문`).toContain(`${i + 1}주차에 읽은 논문의 핵심을 정리했다.`);
    expect(text, `${i + 1}번째 항목의 본문 둘째 단락`).toContain(`${i + 1}주차 실험 결과와 다음 주 계획.`);
  });
});
