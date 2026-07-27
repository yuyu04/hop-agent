/**
 * Headless docx→HWP batch converter (approach B).
 *
 * Reproduces the desktop app's deterministic "docx 일괄 변환" pipeline
 * (agent-sidebar.ts `runDocxFormFill`) without the GUI:
 *   1. Parse each 연구노트 .docx into a ResearchNoteDoc via the SAME Rust parser
 *      the app uses (ai::docx::parse_docx_structure), exposed as a tiny CLI.
 *   2. Load the base HWP form into rhwp WASM (WasmBridge) in plain Node.
 *   3. Rebuild the document context (form_tables + insertion anchor) exactly like
 *      Rust serialize.rs::collect_form_tables / build_windowed_context.
 *   4. Clone the entry form table per entry + regenerate the TOC, apply via the
 *      real ai-apply pipeline, run the same post-processing WASM cleanup.
 *   5. Export HWP bytes and write <name>.hwp next to the source docx.
 *
 * Run: pnpm --filter studio-host exec vitest run --config vitest.batch.config.ts
 * (paths are passed via BATCH_FORM / BATCH_DOCX_DIR / BATCH_DOCX_PARSE_BIN env vars).
 */
import { readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'vitest';

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
  applyActionScript,
  applyCoverFill,
  pickCoverHeaderTable,
  pickCoverTable,
  pickEntryFormTable,
  pickTocTable,
  entryRecordToFormFillEntry,
  buildFormFillEdits,
  buildTocRegenEdits,
  type WasmEditing,
} from '@/core/ai-apply';
import { DEFAULT_COMPILED_THEME } from '@/core/doc-theme';
import type { ResearchNoteDoc, ActionScript, Edit } from '@/core/ai-bridge';
import { collectFormTables, computeAnchor, rawDocOf } from './wasm-form-tables';

const REPO = resolve(__dirname, '../../../..');
const RHWP_WASM = resolve(__dirname, '../../vendor/rhwp-core/rhwp_bg.wasm');

const FORM = process.env.BATCH_FORM
  ?? join(REPO, '2026-연구노트-RS-2026-00000000-001-docx-01.hwp');
const DOCX_DIR = process.env.BATCH_DOCX_DIR ?? join(REPO, '연구노트');
const PARSE_BIN = process.env.BATCH_DOCX_PARSE_BIN!;
// Applies the app's save-time byte fixes: fix_linesegs(fix_table_headers(bytes)).
const HWP_FIX_BIN = process.env.BATCH_HWP_FIX_BIN!;

function parseDocx(docxPath: string): ResearchNoteDoc {
  const json = execFileSync(PARSE_BIN, [docxPath], {
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
  });
  return JSON.parse(json) as ResearchNoteDoc;
}

function convertOne(bridge: WasmBridge, formBytes: Uint8Array, docxPath: string): string {
  const doc = parseDocx(docxPath);
  const entries = doc.entries ?? [];
  if (!entries.length) throw new Error(`no entries parsed from ${docxPath}`);

  // Fresh load of the base form for every file so conversions don't accumulate.
  bridge.loadDocument(formBytes, 'form.hwp');
  const raw = rawDocOf(bridge);

  const tables = collectFormTables(raw);
  const source = pickEntryFormTable(tables);
  if (!source) throw new Error('entry form table not found in base form');
  const anchor = computeAnchor(raw);

  const fillEntries = entries.map(entryRecordToFormFillEntry);
  // pageBreak=false: docx 일괄 변환은 항목마다 강제 쪽나눔을 넣지 않는다. 강제 나눔은 표 앞에
  // 고아 빈 문단을 남겨 한컴에서 항목 사이/구역 시작에 빈 페이지를 만든다(p1/p2). 대신
  // treatAsChar=false로 표가 페이지 경계에서 자연스럽게 흐르게 한다(F-form-fill-page-layout 설계).
  const plans = buildFormFillEdits(source, fillEntries, anchor, false);

  const tocTable = pickTocTable(tables);
  const tocItems = (doc.toc ?? []).map((t, i) => ({ no: t.no || String(i + 1), title: t.title }));
  const tocEdits = buildTocRegenEdits(tocTable, tocItems);

  const script: ActionScript = { edits: [...plans.map((p) => p.edit), ...tocEdits] };
  const result = applyActionScript(bridge as never, script, [], DEFAULT_COMPILED_THEME);

  // 표지 채움(F-cover-fill) — 앱 runDocxFormFill과 동일하게 applyActionScript 직후.
  const coverRes = applyCoverFill(
    bridge as unknown as WasmEditing,
    pickCoverTable(tables),
    pickCoverHeaderTable(tables),
    doc.cover,
  );

  const wasm = bridge as unknown as {
    setTableProperties?: (s: number, p: number, c: number, props: unknown) => unknown;
    removeOrphanParasBeforePageBreaks?: (s: number) => { removed: number };
    removeSourceFormTable?: (s: number, p: number, c: number) => unknown;
    trimTrailingParasAfterLastTable?: (s: number) => { removed: number };
  };

  // Post-processing — identical order to runDocxFormFill.
  if (tocTable && tocEdits.length) {
    try {
      wasm.setTableProperties?.(tocTable.section, tocTable.paragraph, tocTable.control_index, {
        pageBreak: 2,
        treatAsChar: false,
        textWrap: 'TopAndBottom',
      });
    } catch { /* ignore — toc content unaffected */ }
  }
  const sections = new Set<number>([source.section]);
  const m = /sec\[(\d+)\]/.exec(anchor);
  if (m) sections.add(Number(m[1]));
  for (const s of sections) {
    try {
      wasm.removeOrphanParasBeforePageBreaks?.(s);
    } catch { /* ignore */ }
  }
  try {
    wasm.removeSourceFormTable?.(source.section, source.paragraph, source.control_index);
  } catch { /* ignore */ }
  // 구역 끝 '마지막 표 뒤' 빈 문단 제거(문서 끝 빈 페이지 방지) — 앱 후처리와 동일.
  try {
    wasm.trimTrailingParasAfterLastTable?.(source.section);
  } catch { /* ignore */ }
  // 항목 표 쪽 나눔(p4/p5 수정): 복제된 엔트리 표는 소스에서 treatAsChar=true(인라인)를
  // 물려받아 페이지 경계에서 안 나뉘고 클립/밀림된다. 목차에 적용한 것과 동일하게
  // treatAsChar=false + 셀 단위 쪽나눔(pageBreak=1)으로 바꿔 긴 항목이 여러 쪽으로 흐르게 한다.
  try {
    const setProps = (bridge as unknown as {
      setTableProperties?: (s: number, p: number, c: number, props: unknown) => unknown;
    }).setTableProperties;
    if (setProps) {
      const rawd = raw as unknown as {
        applyParaFormat: (s: number, p: number, j: string) => string;
        pageCount: () => number;
        getPageControlLayout: (p: number) => string;
      };
      const entryTables = collectFormTables(raw)
        .filter((t) => t.section === source.section && t.rows === source.rows && t.cols === source.cols)
        .sort((a, b) => a.paragraph - b.paragraph);

      // 하이브리드 판정: 내용 기반(한컴에서 한 페이지를 넘길 만한 '무거운' 항목만 부동).
      //   - 무거움 = 인라인 이미지 있음 | 본문 데이터 표 있음 | 본문 문단 다수(>22).
      //     rhwp 높이 계산(텍스트폭 근사)은 한컴과 달라 신뢰 불가하므로, 클립을 유발하는
      //     실제 원인(그림/표/많은 문단)을 내용에서 직접 본다.
      //   - 무거운 항목 = 부동(treatAsChar=false)으로 페이지 경계에서 흐르게 한다.
      //   - 가벼운 항목 = 인라인(treatAsChar=true): 깔끔·빈 페이지 없음·클립 없음.
      //   - 모든 항목은 pageBreakBefore로 새 페이지에서 시작(첫 항목 제외, 빈 문단 삽입 없음).
      // entryTables는 문단 오름차순 = 문서 순서 = entries 입력 순서라 i로 매핑된다(개수 일치 시).
      const heavy = (e: { images?: unknown[]; body_tables?: unknown[]; body_paragraphs?: unknown[] } | undefined): boolean =>
        !!e && (((e.images?.length ?? 0) > 0) || ((e.body_tables?.length ?? 0) > 0) || ((e.body_paragraphs?.length ?? 0) > 22));
      const mapByOrder = entryTables.length === entries.length;
      const PBB = JSON.stringify({ pageBreakBefore: true });
      let inlineN = 0;
      let flowN = 0;
      entryTables.forEach((t, i) => {
        // 실험1(p1 구역 경계 빈 페이지): 첫 항목은 구역1 첫 페이지에서 밀려나 빈 페이지가 생긴다.
        // 첫 항목을 부동(흐름)으로 두고 앞 간격을 0으로 없애 페이지1 맨 위에서 시작·흐르게 한다.
        const isFirst = i === 0;
        const isHeavy = isFirst || (mapByOrder ? heavy(entries[i] as never) : true);
        if (isHeavy) {
          setProps.call(bridge, t.section, t.paragraph, t.control_index, { treatAsChar: false, pageBreak: 1, textWrap: 'TopAndBottom' });
          flowN += 1;
        } else {
          setProps.call(bridge, t.section, t.paragraph, t.control_index, { treatAsChar: true, pageBreak: 1 });
          inlineN += 1;
        }
        if (isFirst) {
          try { rawd.applyParaFormat(t.section, t.paragraph, JSON.stringify({ spacingBefore: 0 })); } catch { /* skip */ }
        } else {
          try { rawd.applyParaFormat(t.section, t.paragraph, PBB); } catch { /* skip */ }
        }
      });
      // eslint-disable-next-line no-console
      console.log(`  · 항목 표: 인라인(가벼움) ${inlineN} / 부동(무거움·흐름) ${flowN} · 순서매핑=${mapByOrder}`);
    }
  } catch { /* ignore — 항목 내용은 정상 */ }

  // p3 수정(영어 글자단위 줄나눔)은 exportHwp 후 hwp-fix 바이너리가 DocInfo의 PARA_SHAPE
  // attr1(bit5-6)을 일괄 패치해 전 문단에 적용한다 — 문단별 applyParaFormat은 느리고(재배치)
  // 셀 좌표가 중간에 무효화돼 일부만 적용되므로 바이트 단위 전역 패치가 맞다.

  // p1/p2 수정(한컴 정답지 diff로 확인): 구역 시작 문단의 '새 쪽 번호'(nwno) 조판부호가
  // 한컴에서 구역 경계에 빈 페이지를 만든다. 이 컨트롤을 제거하고, 쪽번호 재시작은
  // SectionDef.pageNum=1로 대신한다 → 빈 페이지 없이 '본문 1쪽부터'를 유지.
  try {
    const rawd = raw as unknown as {
      getParagraphLength: (s: number, p: number) => number;
      getTextRange: (s: number, p: number, o: number, n: number) => string;
      deleteText: (s: number, p: number, o: number, n: number) => string;
      deleteParagraph: (s: number, p: number) => string;
      getSectionDef: (s: number) => string;
      setSectionDef: (s: number, j: string) => string;
      pageCount: () => number;
      getPageControlLayout: (p: number) => string;
    };
    const sec = source.section;
    // (1) 구역 첫 문단 offset0의 '새 쪽 번호'(nwno) 제어문자(code<=32) 제거 — 표는 그 뒤라 안전.
    if (rawd.getParagraphLength(sec, 0) >= 1) {
      const ch = rawd.getTextRange(sec, 0, 0, 1);
      if (ch && ch.codePointAt(0)! <= 32) rawd.deleteText(sec, 0, 0, 1);
    }
    // (2) 구역 첫 빈 분리 문단(p1) 제거 — 한컴 정답지(_after) 구조와 일치시켜 경계 빈 페이지 제거.
    //     안전: p1이 표를 품지 않고 비어 있을 때만 삭제.
    const tblParas = new Set<number>();
    for (let p = 0; p < rawd.pageCount(); p += 1) {
      let cl: { controls?: { type?: string; secIdx?: number; paraIdx?: number }[] };
      try { cl = JSON.parse(rawd.getPageControlLayout(p)); } catch { continue; }
      for (const c of cl.controls ?? []) if (c.type === 'table' && c.secIdx === sec) tblParas.add(c.paraIdx as number);
    }
    if (rawd.getParagraphLength(sec, 1) === 0 && !tblParas.has(1)) {
      rawd.deleteParagraph(sec, 1);
    }
    // (3) 쪽번호 재시작(pageNum=1)은 넣지 않는다 — 한컴에서 부동 표가 2쪽으로 넘칠 때
    //     넘침 쪽 번호를 깨뜨린다(정답지 _after는 pageNum=0으로 번호 정상, 시작만 6). 본문을
    //     1쪽부터 시작시키는 건 한컴 정답지 diff로 올바른 인코딩을 확인한 뒤 별도로 반영한다.
    // eslint-disable-next-line no-console
    console.log('  · 구역 시작 새쪽번호 제거 + 빈 문단 제거 (한컴 정답지 _after 구조 일치)');
  } catch { /* ignore — 내용은 정상 */ }

  // 구역 0(표지/개요/목차) 쪽 나눔 앞 고아 문단·마지막 표 뒤 정리(보조).
  try {
    wasm.removeOrphanParasBeforePageBreaks?.(0);
    wasm.trimTrailingParasAfterLastTable?.(0);
  } catch { /* ignore */ }

  const outBytes = bridge.exportHwp();
  const outName = basename(docxPath).replace(/\.docx$/i, '.hwp');
  const outPath = join(DOCX_DIR, outName);
  // Replicate commit_staged_hwp_save: write staged export, then apply the
  // Rust save-time fixes (table header 48-byte + page-relative linesegs).
  const stagedPath = `${outPath}.staged`;
  writeFileSync(stagedPath, Buffer.from(outBytes));
  execFileSync(HWP_FIX_BIN, [stagedPath, outPath], { maxBuffer: 512 * 1024 * 1024 });
  rmSync(stagedPath, { force: true });

  const skips = plans.flatMap((p) => p.skipped);
  // eslint-disable-next-line no-console
  console.log(
    `✓ ${basename(docxPath)} → ${outName} | 항목 ${entries.length}개(적용 ${result.applied}) ` +
      `목차 ${tocItems.length} | 표지 ${coverRes.filled}칸(건너뜀 ${coverRes.skipped.length}) | ` +
      `소스표 sec${source.section}.p${source.paragraph}.tbl${source.control_index} ` +
      `(${source.rows}×${source.cols}) anchor=${anchor} skips=${skips.length} bytes=${outBytes.length}`,
  );
  return outPath;
}

test('convert all 연구노트 docx → hwp', async () => {
  await init({ module_or_path: readFileSync(RHWP_WASM) });
  const bridge = new WasmBridge();
  await bridge.initialize();
  // eslint-disable-next-line no-console
  console.log(`rhwp ${version()} initialized (headless Node)`);

  const formBytes = new Uint8Array(readFileSync(FORM));
  const docxFiles = readdirSync(DOCX_DIR)
    .filter((f) => /\.docx$/i.test(f) && !f.startsWith('~$'))
    .sort()
    .map((f) => join(DOCX_DIR, f));

  // eslint-disable-next-line no-console
  console.log(`form=${basename(FORM)} · ${docxFiles.length} docx files`);
  for (const f of docxFiles) {
    convertOne(bridge, formBytes, f);
  }
});
