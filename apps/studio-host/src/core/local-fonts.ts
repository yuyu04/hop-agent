import { upstreamLocalFonts } from '@/upstream/local-fonts';
import type {
  DetectLocalFontsOptions,
  GetLocalFontsOptions,
  HostFontData,
  HostFontProvider,
  LocalFontRecord,
  LocalFontSnapshot,
  LocalFontState,
  LocalFontStyleRequest,
} from '@/upstream/local-fonts';
import {
  clearStoredDesktopFonts,
  detectDesktopFontEntries,
  detectDesktopFonts,
  ensureDesktopFontsAvailable,
  getDesktopFontRecords,
  getDesktopFonts,
  getDesktopFontState,
  getDetectedDesktopFonts,
  isDesktopTauriRuntime,
  loadDesktopFontBytes,
  loadDesktopFontBytesFor,
  loadStoredDesktopFonts,
  resetDesktopFonts,
  resolveDesktopFont,
} from './desktop-local-fonts';
import type { LocalFontEntry } from './desktop-local-fonts';
import { isAuthoringBlockedFontFamily } from './font-authoring-policy';

export type {
  DetectLocalFontsOptions,
  GetLocalFontsOptions,
  LocalFontDetectionSource,
  LocalFontRecord,
  LocalFontSnapshot,
  LocalFontState,
  LocalFontStorageKind,
  LocalFontStyleRequest,
} from '@/upstream/local-fonts';
export type { LocalFontEntry } from './desktop-local-fonts';

export function isLocalFontAccessSupported(): boolean {
  return isDesktopTauriRuntime() || upstreamLocalFonts.isLocalFontAccessSupported();
}

export function isFontPresenceProbeSupported(): boolean {
  return upstreamLocalFonts.isFontPresenceProbeSupported();
}

export function getLocalFontDetectionMethod(): 'local-font-access' | 'font-presence-probe' | null {
  return isDesktopTauriRuntime() ? 'local-font-access' : upstreamLocalFonts.getLocalFontDetectionMethod();
}

export function isLocalFontSupported(): boolean {
  return isDesktopTauriRuntime() || upstreamLocalFonts.isLocalFontSupported();
}

export function loadStoredLocalFonts(): Promise<LocalFontSnapshot | null> {
  return isDesktopTauriRuntime()
    ? loadStoredDesktopFonts()
    : upstreamLocalFonts.loadStoredLocalFonts();
}

export async function clearStoredLocalFonts(): Promise<void> {
  if (isDesktopTauriRuntime()) clearStoredDesktopFonts();
  else await upstreamLocalFonts.clearStoredLocalFonts();
}

/** Returns only already-authorized browser records; it never opens a permission prompt. */
export async function detectLocalFontEntries(force = false): Promise<LocalFontEntry[]> {
  if (isDesktopTauriRuntime()) return detectDesktopFontEntries(force);
  return upstreamLocalFonts.getLocalFontRecords({ includeRegistered: true }).map(recordToEntry);
}

export function detectLocalFonts(options: DetectLocalFontsOptions = {}): Promise<string[]> {
  return isDesktopTauriRuntime()
    ? detectDesktopFonts(options)
    : upstreamLocalFonts.detectLocalFonts(options);
}

export function getLocalFontRecords(options: GetLocalFontsOptions = {}): LocalFontRecord[] {
  return isDesktopTauriRuntime()
    ? getDesktopFontRecords(options)
    : upstreamLocalFonts.getLocalFontRecords(options);
}

export function getLocalFonts(options: GetLocalFontsOptions = {}): string[] {
  return isDesktopTauriRuntime() ? getDesktopFonts(options) : upstreamLocalFonts.getLocalFonts(options);
}

export function getDetectedLocalFonts(): string[] {
  return isDesktopTauriRuntime() ? getDetectedDesktopFonts() : upstreamLocalFonts.getDetectedLocalFonts();
}

export function resolveLocalFont(fontName: string): LocalFontRecord | null {
  return isDesktopTauriRuntime() ? resolveDesktopFont(fontName) : upstreamLocalFonts.resolveLocalFont(fontName);
}

export function localFontFaceKey(
  record: Pick<LocalFontRecord, 'family' | 'fullName' | 'postscriptName' | 'hostReference'>,
): string {
  return upstreamLocalFonts.localFontFaceKey(record);
}

export function loadLocalFontBytesFor(fontNames: readonly string[]): Promise<Map<string, ArrayBuffer>> {
  return isDesktopTauriRuntime()
    ? loadDesktopFontBytesFor(fontNames)
    : upstreamLocalFonts.loadLocalFontBytesFor(fontNames);
}

export function loadLocalFontBytes(fontName: string): Promise<ArrayBuffer | null> {
  return isDesktopTauriRuntime()
    ? loadDesktopFontBytes(fontName)
    : upstreamLocalFonts.loadLocalFontBytes(fontName);
}

export function getLocalFontState(): LocalFontState {
  return isDesktopTauriRuntime() ? getDesktopFontState() : upstreamLocalFonts.getLocalFontState();
}

// Host font provider(rhwp 0.8.7+) — upstream이 상태를 소유한다(upstream 내부 모듈은 상대 경로로
// 같은 인스턴스를 쓴다). HOP는 위임만 하고, provider가 없을 때 데스크톱 렌더러 조회만 네이티브로 돌린다.
export function setHostFontProvider(provider: HostFontProvider | null): Promise<void> {
  return upstreamLocalFonts.setHostFontProvider(provider);
}

export function onHostFontsChanged(listener: () => void): () => void {
  return upstreamLocalFonts.onHostFontsChanged(listener);
}

export function hasHostFontProvider(): boolean {
  return upstreamLocalFonts.hasHostFontProvider();
}

export function prepareHostFontCatalog(): Promise<void> {
  return upstreamLocalFonts.prepareHostFontCatalog();
}

export function getHostFontState(): ReturnType<typeof upstreamLocalFonts.getHostFontState> {
  return upstreamLocalFonts.getHostFontState();
}

export function resolveRendererLocalFont(
  name: string,
  style?: LocalFontStyleRequest,
): LocalFontRecord | null {
  if (isDesktopTauriRuntime() && !upstreamLocalFonts.hasHostFontProvider()) {
    return resolveDesktopFont(name);
  }
  return upstreamLocalFonts.resolveRendererLocalFont(name, style);
}

export async function loadRendererLocalFont(record: LocalFontRecord): Promise<HostFontData | null> {
  if (!record.hostReference && isDesktopTauriRuntime()) {
    const bytes = await loadDesktopFontBytes(record.postscriptName || record.fullName || record.family);
    return bytes ? { bytes, faceIndex: 0 } : null;
  }
  return upstreamLocalFonts.loadRendererLocalFont(record);
}

export function resetLocalFontsForTests(): void {
  upstreamLocalFonts.resetLocalFontsForTests();
  resetDesktopFonts();
}

export async function ensureLocalFontsAvailable(targetFamilies?: Iterable<string>): Promise<Set<string>> {
  if (isDesktopTauriRuntime()) return ensureDesktopFontsAvailable(targetFamilies);
  const requested = targetFamilies ? new Set(targetFamilies) : null;
  return new Set(upstreamLocalFonts.getLocalFontRecords({ includeRegistered: true })
    .map((record) => record.family)
    .filter((family) => !requested || requested.has(family))
    .filter((family) => !isAuthoringBlockedFontFamily(family)));
}

function recordToEntry(record: LocalFontRecord): LocalFontEntry {
  return {
    family: record.family,
    postScriptName: record.postscriptName || record.family,
    style: record.style || 'normal',
    sourceKind: 'system-installed',
  };
}
