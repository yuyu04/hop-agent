import { detectLocalFontEntries, ensureLocalFontsAvailable } from './local-fonts';
import { isAuthoringBlockedFontFamily } from './font-authoring-policy';
import { FONT_LIST, REGISTERED_FONTS } from './font-catalog';
import type { FontEntry } from './font-catalog';

export { REGISTERED_FONTS } from './font-catalog';
export type { CanvasKitBundledFontSource } from '@/upstream/core';

const CRITICAL_FONTS = new Set(['함초롬바탕', '함초롬돋움']);
const OS_FONT_CANDIDATES = [
  '맑은 고딕', 'Malgun Gothic', '바탕', 'Batang', '돋움', 'Dotum',
  '굴림', 'Gulim', '굴림체', 'GulimChe', '바탕체', 'BatangChe', '궁서', 'Gungsuh',
  'Apple SD Gothic Neo', 'AppleMyungjo', 'AppleGothic',
  'Noto Sans KR', 'Noto Serif KR',
];

let fontFaceRegistered = false;
const loadedFiles = new Set<string>();
const detectedOSFonts = new Set<string>();
let substituteFontStyle: HTMLStyleElement | null = null;

export function getDetectedOSFonts(): ReadonlySet<string> {
  return detectedOSFonts;
}

export async function loadWebFonts(
  docFonts?: string[],
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  const targetSet = new Set([...(docFonts ?? []), ...CRITICAL_FONTS]);
  await hydrateDetectedFonts(targetSet);

  if (!fontFaceRegistered) {
    registerFontFaces();
    fontFaceRegistered = true;
  } else {
    syncRegisteredFontFaces();
  }

  const targetFonts = FONT_LIST.filter((font) => {
    if (!targetSet.has(font.name)) return false;
    return !detectedOSFonts.has(font.name);
  });
  const toLoad = uniqueFonts(targetFonts);

  if (toLoad.length === 0) return;

  const fileToNames = mapFontAliases(toLoad);
  let completed = 0;
  const total = toLoad.length;
  for (const font of toLoad) {
    try {
      for (const name of fileToNames.get(font.file) ?? [font.name]) {
        const face = new FontFace(
          name,
          `url("${font.file}") format("${font.format ?? 'woff2'}")`,
          font.unicodeRange ? { unicodeRange: font.unicodeRange } : undefined,
        );
        document.fonts.add(await face.load());
      }
      loadedFiles.add(font.file);
    } catch {
      // Missing fonts degrade to CSS fallback families; document loading should continue.
    } finally {
      completed += 1;
      onProgress?.(completed, total);
    }
  }
}

async function hydrateDetectedFonts(targetFonts: Set<string>): Promise<void> {
  const localFontEntries = await detectLocalFontEntries().catch(() => []);
  for (const entry of localFontEntries) {
    if (entry.sourceKind !== 'system-installed') continue;
    if (isAuthoringBlockedFontFamily(entry.family)) continue;
    detectedOSFonts.add(entry.family);
  }

  const availableFonts = await ensureLocalFontsAvailable(
    Array.from(targetFonts).filter((family) => !isAuthoringBlockedFontFamily(family)),
  ).catch(() => new Set<string>());
  for (const family of availableFonts) {
    if (isAuthoringBlockedFontFamily(family)) continue;
    detectedOSFonts.add(family);
  }

  if (detectedOSFonts.size === 0) {
    detectFallbackBrowserFonts();
  }
}

function mapFontAliases(fontsToLoad: FontEntry[]): Map<string, string[]> {
  const aliases = new Map<string, string[]>();
  const filesToLoad = new Set(fontsToLoad.map((font) => font.file));
  for (const font of FONT_LIST) {
    if (!filesToLoad.has(font.file) || detectedOSFonts.has(font.name)) continue;
    const names = aliases.get(font.file) ?? [];
    names.push(font.name);
    aliases.set(font.file, names);
  }
  return aliases;
}

function detectFallbackBrowserFonts(): void {
  for (const name of OS_FONT_CANDIDATES) {
    try {
      if (document.fonts.check(`16px "${name}"`)) {
        detectedOSFonts.add(name);
      }
    } catch {
      // Font detection is best-effort only.
    }
  }
}

function registerFontFaces(): void {
  substituteFontStyle = document.createElement('style');
  document.head.appendChild(substituteFontStyle);
  syncRegisteredFontFaces();
}

function syncRegisteredFontFaces(): void {
  if (!substituteFontStyle) return;

  substituteFontStyle.textContent = FONT_LIST
    .filter((font) => !detectedOSFonts.has(font.name))
    .map((font) => {
      const unicodeRange = font.unicodeRange ? ` unicode-range: ${font.unicodeRange};` : '';
      return `@font-face { font-family: "${font.name}"; src: url("${font.file}") format("${font.format ?? 'woff2'}"); font-display: swap;${unicodeRange} }`;
    })
    .join('\n');
}

function uniqueFonts(fonts: FontEntry[]): FontEntry[] {
  const seenFiles = new Set<string>();
  const result: FontEntry[] = [];
  for (const font of fonts) {
    if (loadedFiles.has(font.file) || seenFiles.has(font.file)) continue;
    seenFiles.add(font.file);
    result.push(font);
  }
  return result;
}
