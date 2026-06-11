import { describe, expect, it } from 'vitest';
import { compileTheme, DEFAULT_COMPILED_THEME } from './doc-theme';

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
    expect(compiled.styles.heading.para).toEqual({ spacingBefore: 3200, spacingAfter: 1200 });
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
