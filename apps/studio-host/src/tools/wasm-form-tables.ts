/**
 * Headless (Node) ports of the document-context builders the desktop app runs in
 * Rust — shared by the docx batch converter (`docx-batch-convert.batch.ts`) and the
 * cladding stage_2.4 smoke probe (`clad-smoke.smoke.ts`).
 *
 * Keeping one copy matters: the smoke probe is only meaningful if it walks the SAME
 * table/anchor discovery the shipped pipeline walks.
 */
import type { HwpDocument } from '@wasm/rhwp.js';
import type { FormSourceTable } from '@/core/ai-apply';

/**
 * Minimal raw-document surface we need off the HwpDocument (getPageTextLayout is not
 * exposed on WasmBridge). `doc` is a private WasmBridge field but survives at runtime.
 */
export type RawDoc = HwpDocument & {
  getPageTextLayout(page: number): string;
  getPageControlLayout(page: number): string;
  pageCount(): number;
  getParagraphCount(sec: number): number;
  getDocumentInfo(): string;
};

/** Reach into a WasmBridge for its raw HwpDocument. */
export function rawDocOf(bridge: unknown): RawDoc {
  return (bridge as { doc: RawDoc }).doc;
}

/** Port of serialize.rs::collect_form_tables against the WASM layout API. */
export function collectFormTables(doc: RawDoc): FormSourceTable[] {
  const cellText = new Map<string, string>();
  const pc = doc.pageCount();
  for (let p = 0; p < pc; p += 1) {
    let tl: { runs?: unknown[] };
    try {
      tl = JSON.parse(doc.getPageTextLayout(p));
    } catch {
      continue;
    }
    for (const runRaw of tl.runs ?? []) {
      const run = runRaw as Record<string, unknown>;
      const path = run.cellPath as unknown[] | undefined;
      if (Array.isArray(path) && path.length > 1) continue; // nested → skip
      const pp = run.parentParaIdx as number | undefined;
      const ci = run.controlIdx as number | undefined;
      const cell = run.cellIdx as number | undefined;
      if (pp == null || ci == null || cell == null) continue;
      const key = `${pp}|${ci}|${cell}`;
      cellText.set(key, (cellText.get(key) ?? '') + ((run.text as string) ?? ''));
    }
  }

  const tables: FormSourceTable[] = [];
  const seen = new Set<string>();
  for (let p = 0; p < pc; p += 1) {
    let cl: { controls?: unknown[] };
    try {
      cl = JSON.parse(doc.getPageControlLayout(p));
    } catch {
      continue;
    }
    for (const ctrlRaw of cl.controls ?? []) {
      const ctrl = ctrlRaw as Record<string, unknown>;
      if (ctrl.type !== 'table') continue;
      const sec = ctrl.secIdx as number | undefined;
      const pp = ctrl.paraIdx as number | undefined;
      const ci = ctrl.controlIdx as number | undefined;
      if (sec == null || pp == null || ci == null) continue;
      const k = `${sec}|${pp}|${ci}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const rows = (ctrl.rowCount as number) ?? 0;
      const cols = (ctrl.colCount as number) ?? 0;
      const cellArr = ctrl.cells as unknown[] | undefined;
      if (!Array.isArray(cellArr)) continue;
      const cells = [];
      for (const cRaw of cellArr) {
        const c = cRaw as Record<string, unknown>;
        const row = c.row as number | undefined;
        const col = c.col as number | undefined;
        if (row == null || col == null) continue;
        const cellIdx = (c.cellIdx as number) ?? 0;
        const text = (cellText.get(`${pp}|${ci}|${cellIdx}`) ?? '').trim();
        cells.push({ row, col, role: text === '' ? 'input' : 'label', text });
      }
      if (rows >= 2 && cols >= 1) {
        cells.sort((a, b) => a.row - b.row || a.col - b.col);
        tables.push({ section: sec, paragraph: pp, control_index: ci, rows, cols, cells });
      }
    }
  }
  tables.sort(
    (a, b) =>
      a.section - b.section || a.paragraph - b.paragraph || a.control_index - b.control_index,
  );
  return tables;
}

/**
 * Reproduce the insertion anchor the app uses. runDocxFormFill calls
 * aiGetDocumentContext(docId, currentSelectionOnly=false, cursor=null, fullDocument=true),
 * which routes to build_full_context (NOT windowed). lastBodyParagraphId then returns
 * the last `sec[s].p[p]` in content — i.e. the last body paragraph of the whole
 * document. Entries are inserted after it, so the cover / overview / TOC front matter
 * is preserved ahead of the appended entries.
 */
export function computeAnchor(doc: RawDoc): string {
  const info = JSON.parse(doc.getDocumentInfo()) as { sectionCount?: number };
  const sc = info.sectionCount ?? 1;
  let last = '';
  for (let s = 0; s < sc; s += 1) {
    const n = doc.getParagraphCount(s);
    for (let p = 0; p < n; p += 1) last = `sec[${s}].p[${p}]`;
  }
  return last;
}
