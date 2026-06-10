/**
 * 디자인 테마 — 생성 문서의 시각 수치(간격·크기·색)를 사용자 편집 가능한 파일로 분리.
 *
 * Rust(ai/themes.rs)가 앱 데이터 `themes/*.json`을 읽어 넘기고, 여기서 사람이 쓰는
 * pt 단위를 HWP 저장 스케일로 변환(compile)해 ai-apply가 쓴다. 글의 구조·표현은
 * 스킬(.md)이, 수치는 테마(.json)가 담당한다. 부분 테마는 기본 테마 위에 병합되므로
 * 바꾸고 싶은 값만 적으면 된다.
 */

/** 테마 파일의 스타일 하나(모든 수치는 pt — 사람이 읽고 쓰는 단위). */
export interface DocThemeStyle {
  bold?: boolean;
  italic?: boolean;
  /** 글자 크기(pt). */
  fontPt?: number;
  /** 글자 색 #RRGGBB. */
  color?: string;
  /** left | center | right | justify */
  align?: string;
  /** 줄간격(%) — 예: 180. */
  lineSpacingPercent?: number;
  /** 문단 위 간격(pt). */
  beforePt?: number;
  /** 문단 아래 간격(pt). */
  afterPt?: number;
  /** 왼쪽 들여쓰기(pt) — 인용 등. */
  indentPt?: number;
  /** 문서에 정의된 '스타일 이름'(예: "개요 1", "본문"). 지정되어 있고 문서에서 찾으면
   *  수치 서식 대신 그 스타일을 적용한다(한컴 스타일 시스템 — 문서 전체 일관성 유지,
   *  나중에 한컴에서 스타일만 바꿔 전체 모양 변경 가능). 못 찾으면 수치로 폴백. */
  styleName?: string;
}

/** 테마 파일 전체(ai_list_themes가 넘기는 형태, id는 파일명). */
export interface DocTheme {
  id?: string;
  name?: string;
  description?: string;
  styles?: Record<string, DocThemeStyle>;
  table?: {
    /** 표가 든 문단의 위/아래 간격(pt). */
    paraSpacingPt?: number;
    /** 표 머리글 행 배경색. */
    headerFill?: string;
  };
}

/** ai-apply가 그대로 쓰는 컴파일된 테마(저장 스케일 단위). */
export interface CompiledTheme {
  id: string;
  name: string;
  styles: Record<
    string,
    { char?: Record<string, unknown>; para?: Record<string, unknown>; styleName?: string }
  >;
  /** 표 문단 위/아래 간격(저장 단위). */
  tableParaSpacing: number;
  headerFill: string;
}

// HWP 저장 스케일: 글자 크기는 1pt=100(HWPUNIT), 문단 간격/여백은 'HWPUNIT의 2배'로
// 저장된다(렌더러가 /2) → 화면의 1pt = 200. ai-edit-coverage 메모리/serialize.rs
// spacing_probe 단위 계약 테스트 참고.
const FONT_PT = 100;
const SPACING_PT = 200;

/** 번들 기본 테마(themes_default/기본.json과 동일 값 — 파일을 못 읽어도 항상 동작). */
export const DEFAULT_THEME: DocTheme = {
  id: 'default',
  name: '기본',
  styles: {
    title: { bold: true, fontPt: 18, color: '#1A1A1A', align: 'center', beforePt: 8, afterPt: 14 },
    heading: { bold: true, fontPt: 14, color: '#1F3864', beforePt: 16, afterPt: 6 },
    subheading: { bold: true, fontPt: 12, color: '#2F2F2F', beforePt: 12, afterPt: 4 },
    body: { fontPt: 10, align: 'justify', lineSpacingPercent: 180, afterPt: 3 },
    caption: { fontPt: 9, color: '#666666', align: 'center', beforePt: 3, afterPt: 8 },
    quote: { italic: true, color: '#444444', indentPt: 20, lineSpacingPercent: 160 },
    emphasis: { bold: true },
  },
  table: { paraSpacingPt: 8, headerFill: '#E8EEF6' },
};

/** 스타일 하나를 char/para 서식(JSON props)으로 변환한다. */
function compileStyle(style: DocThemeStyle): {
  char?: Record<string, unknown>;
  para?: Record<string, unknown>;
} {
  const char: Record<string, unknown> = {};
  if (style.bold !== undefined) char.bold = style.bold;
  if (style.italic !== undefined) char.italic = style.italic;
  if (typeof style.fontPt === 'number') char.fontSize = Math.round(style.fontPt * FONT_PT);
  if (style.color) char.textColor = style.color;

  const para: Record<string, unknown> = {};
  if (style.align) para.alignment = style.align;
  if (typeof style.lineSpacingPercent === 'number') {
    para.lineSpacingType = 'Percent';
    para.lineSpacing = style.lineSpacingPercent;
  }
  if (typeof style.beforePt === 'number') para.spacingBefore = Math.round(style.beforePt * SPACING_PT);
  if (typeof style.afterPt === 'number') para.spacingAfter = Math.round(style.afterPt * SPACING_PT);
  if (typeof style.indentPt === 'number') para.marginLeft = Math.round(style.indentPt * SPACING_PT);

  return {
    ...(Object.keys(char).length ? { char } : {}),
    ...(Object.keys(para).length ? { para } : {}),
    ...(style.styleName ? { styleName: style.styleName } : {}),
  };
}

/**
 * 테마를 컴파일한다. 기본 테마 위에 스타일 단위로 병합하므로(스타일 안의 키까지 병합)
 * 부분 테마(예: heading 간격만 변경)도 안전하다.
 */
export function compileTheme(raw: DocTheme | null | undefined): CompiledTheme {
  const styles: CompiledTheme['styles'] = {};
  const names = new Set([
    ...Object.keys(DEFAULT_THEME.styles ?? {}),
    ...Object.keys(raw?.styles ?? {}),
  ]);
  for (const name of names) {
    const merged: DocThemeStyle = {
      ...(DEFAULT_THEME.styles?.[name] ?? {}),
      ...(raw?.styles?.[name] ?? {}),
    };
    styles[name] = compileStyle(merged);
  }
  const paraSpacingPt =
    raw?.table?.paraSpacingPt ?? DEFAULT_THEME.table?.paraSpacingPt ?? 8;
  return {
    id: raw?.id ?? DEFAULT_THEME.id ?? 'default',
    name: raw?.name ?? DEFAULT_THEME.name ?? '기본',
    styles,
    tableParaSpacing: Math.round(paraSpacingPt * SPACING_PT),
    headerFill: raw?.table?.headerFill ?? DEFAULT_THEME.table?.headerFill ?? '#E8EEF6',
  };
}

/** 기본 테마의 컴파일 결과(테마 미선택/로드 실패 시 폴백). */
export const DEFAULT_COMPILED_THEME: CompiledTheme = compileTheme(DEFAULT_THEME);
