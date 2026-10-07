import { describe, expect, it } from 'vitest';
import { applyActionScript, type WasmEditing } from './ai-apply';
import { compileTheme, DEFAULT_COMPILED_THEME, type DocTheme } from './doc-theme';
import bundledDefaultTheme from '../../../desktop/src-tauri/src/ai/themes_default/default.json?raw';

describe('compileTheme', () => {
  it('converts pt to HWP storage scale (font ×100, spacing/margin ×200)', () => {
    const compiled = compileTheme({
      id: 't',
      name: '테스트',
      styles: {
        heading: { bold: true, fontPt: 14, color: '#1F3864', beforePt: 16, afterPt: 6 },
        quote: { indentPt: 20, lineSpacingPercent: 160 },
      },
    });
    expect(compiled.styles.heading.char).toEqual({
      bold: true,
      fontSize: 1400,
      textColor: '#1F3864',
    });
    // 테마에 적지 않은 keepWithNext는 기본 테마(제목류 true)에서 병합된다(F-a7b2c7ba).
    expect(compiled.styles.heading.para).toEqual({ spacingBefore: 3200, spacingAfter: 1200, keepWithNext: true });
    expect(compiled.styles.quote.para).toMatchObject({
      marginLeft: 4000,
      lineSpacingType: 'Percent',
      lineSpacing: 160,
    });
  });

  it('merges a partial theme over the default (per-style key merge)', () => {
    // heading 간격만 바꾼 부분 테마 — 굵게/크기/색은 기본값이 유지돼야 한다.
    const compiled = compileTheme({ id: 'p', styles: { heading: { beforePt: 30 } } });
    expect(compiled.styles.heading.para).toMatchObject({ spacingBefore: 6000 });
    expect(compiled.styles.heading.char).toMatchObject({ bold: true, fontSize: 1400 });
    // 건드리지 않은 body는 기본 테마와 동일.
    expect(compiled.styles.body).toEqual(DEFAULT_COMPILED_THEME.styles.body);
  });

  it('carries styleName through compilation alongside numeric fallback', () => {
    const compiled = compileTheme({ id: 's', styles: { heading: { styleName: '개요 1' } } });
    expect(compiled.styles.heading.styleName).toBe('개요 1');
    // 수치 폴백용 기본값도 함께 유지된다(스타일을 못 찾는 문서 대비).
    expect(compiled.styles.heading.char).toMatchObject({ bold: true });
  });

  it('noDefaults skips merging so unspecified styles apply nothing (inherit mode)', () => {
    const compiled = compileTheme({
      id: 'match',
      noDefaults: true,
      styles: { heading: { bold: true, beforePt: 16 }, body: {} },
    });
    // body는 빈 사양 — char/para 모두 없음 → 주변 문단 서식 상속.
    expect(compiled.styles.body).toEqual({});
    // 명시 안 한 caption 같은 역할은 아예 항목이 없다(아무것도 안 입힘).
    expect(compiled.styles.caption).toBeUndefined();
    // heading은 적은 것만: 굵게 + 위 간격. 크기·줄간격은 상속.
    expect(compiled.styles.heading.char).toEqual({ bold: true });
    expect(compiled.styles.heading.para).toEqual({ spacingBefore: 3200 });
  });

  it('falls back to the default theme for null and fills table settings', () => {
    const compiled = compileTheme(null);
    expect(compiled.name).toBe('기본');
    expect(compiled.tableParaSpacing).toBe(1600); // 8pt × 200
    expect(compiled.headerFill).toBe('#E8EEF6');
    // 기본 body: 줄간격 180% + 아래 3pt.
    expect(compiled.styles.body.para).toMatchObject({ lineSpacing: 180, spacingAfter: 600 });
  });
});

/**
 * F-a7b2c7ba AC-f2a7b136 — 기본 테마의 문서 제목·장 제목·소제목(title·heading·subheading)은
 * '다음 문단과 함께'(keepWithNext)가 켜져 쪽 끝에 제목만 홀로 남지 않고, 테마 파일의
 * keepWithNext로 끄고 켤 수 있다.
 */
describe('F-a7b2c7ba AC-f2a7b136: 제목류 keepWithNext', () => {
  const HEADINGS = ['title', 'heading', 'subheading'] as const;

  it('AC-f2a7b136: 기본 테마(코드 내장)는 title·heading·subheading에 keepWithNext=true, 본문류에는 없다', () => {
    for (const theme of [DEFAULT_COMPILED_THEME, compileTheme(null)]) {
      for (const role of HEADINGS) expect(theme.styles[role].para?.keepWithNext, role).toBe(true);
      for (const role of ['body', 'caption', 'quote', 'emphasis']) {
        expect(theme.styles[role].para?.keepWithNext, role).toBeUndefined();
      }
    }
  });

  it('AC-f2a7b136: 앱에 번들된 기본 테마 파일(themes_default/default.json)도 제목류에 keepWithNext를 직접 담는다', () => {
    const file = JSON.parse(bundledDefaultTheme) as DocTheme;
    for (const role of HEADINGS) expect(file.styles?.[role]?.keepWithNext, role).toBe(true);
    // 내장 기본값과 병합하지 않아도(noDefaults) 파일 값만으로 켜진다.
    const fileOnly = compileTheme({ ...file, noDefaults: true });
    for (const role of HEADINGS) expect(fileOnly.styles[role].para?.keepWithNext, role).toBe(true);
    expect(fileOnly.styles.body.para?.keepWithNext).toBeUndefined();
  });

  it('AC-f2a7b136: 테마 파일에서 keepWithNext:false로 끌 수 있고, 다른 제목류는 기본값(true)을 유지한다', () => {
    const compiled = compileTheme({ id: 't', styles: { heading: { keepWithNext: false } } });
    expect(compiled.styles.heading.para?.keepWithNext).toBe(false);
    expect(compiled.styles.title.para?.keepWithNext).toBe(true);
    expect(compiled.styles.subheading.para?.keepWithNext).toBe(true);
  });

  it('AC-f2a7b136: 테마 파일에서 다른 역할(body)에 keepWithNext:true를 켤 수도 있다', () => {
    const compiled = compileTheme({ id: 't', styles: { body: { keepWithNext: true } } });
    expect(compiled.styles.body.para?.keepWithNext).toBe(true);
  });

  it('AC-f2a7b136: 테마에 keepWithNext를 적지 않으면 기본 테마 값(true)을 물려받는다', () => {
    const compiled = compileTheme({ id: 't', styles: { heading: { bold: true, fontPt: 20 } } });
    expect(compiled.styles.heading.para?.keepWithNext).toBe(true);
  });

  it('AC-f2a7b136: AI가 heading 문단을 넣으면 엔진에 보내는 문단 서식에 keepWithNext=true가 실리고, body 문단에는 없다', () => {
    const { wasm, paraFormats } = recordingWasm();
    applyActionScript(wasm, {
      edits: [
        { command: 'INSERT_AFTER', target_id: 'sec[0].p[0]', payload: { type: 'paragraph', text: '1. 추진 배경', style: 'heading' } },
        { command: 'INSERT_AFTER', target_id: 'sec[0].p[1]', payload: { type: 'paragraph', text: '본문 설명', style: 'body' } },
      ],
    });
    // 내림차순 적용: p[1] 뒤(body, 새 문단 2) 먼저, p[0] 뒤(heading, 새 문단 1) 나중.
    const byPara = new Map(paraFormats.map((f) => [f.para, f.props]));
    expect(byPara.get(1)?.keepWithNext).toBe(true);
    expect(byPara.get(2)).toBeDefined();
    expect(byPara.get(2)).not.toHaveProperty('keepWithNext');
  });

  it('AC-f2a7b136: 테마에서 끈 keepWithNext:false가 실제 heading 문단 서식으로 전달된다', () => {
    const { wasm, paraFormats } = recordingWasm();
    const theme = compileTheme({ id: 't', styles: { heading: { keepWithNext: false } } });
    applyActionScript(
      wasm,
      { edits: [{ command: 'INSERT_AFTER', target_id: 'sec[0].p[0]', payload: { type: 'paragraph', text: '제목', style: 'heading' } }] },
      [],
      theme,
    );
    expect(paraFormats).toHaveLength(1);
    expect(paraFormats[0]).toMatchObject({ para: 1, props: { keepWithNext: false } });
  });
});

/** 문단 서식 호출만 기록하는 최소 엔진 목(나머지 표면은 쓰이지 않는다). */
function recordingWasm(): { wasm: WasmEditing; paraFormats: Array<{ para: number; props: Record<string, unknown> }> } {
  const paraFormats: Array<{ para: number; props: Record<string, unknown> }> = [];
  const noop = () => '';
  const wasm = {
    getParagraphLength: () => 3,
    insertText: noop,
    deleteText: noop,
    splitParagraph: noop,
    mergeParagraph: noop,
    insertPageBreak: noop,
    applyCharFormat: noop,
    applyParaFormat: (_sec: number, para: number, json: string) => {
      paraFormats.push({ para, props: JSON.parse(json) as Record<string, unknown> });
      return '';
    },
  } as unknown as WasmEditing;
  return { wasm, paraFormats };
}
