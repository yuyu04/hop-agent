<!-- Cladding · Tier C · derived from observed code · Refreshed by: clad init --scan -->

# Project conventions

_Mode: deterministic (no LLM polish). Re-run `clad scan` without `--no-llm` for prose._

## Observed style

| key | value |
|---|---|
| indent | four-space |
| quote | mixed |
| semicolon | mixed |
| naming (exports) | snake_case |
| naming (constants) | camelCase |
| docblock ratio | 1.00 |
| import order | external-first |
| export pattern | default-mixed |
| error handling | throw-primary |
| type def location | mixed |
| test location | tests-and-sibling |
| file header | /// <reference types="vi |

## Doc tag frequency

- `@param`: 1810
- `@returns`: 560
- `@throws`: 0
- `@example`: 4
- `@see`: 0
- `@deprecated`: 0
- `# Safety`: 2

## Module boilerplate (smallest exported module observed)

```
// 컨텍스트 메뉴 관리
// - HWP/HWPX 링크 우클릭 → "rhwp로 열기"

import { openViewer } from './viewer-launcher.js';

const MENU_ID = 'rhwp-open-link';

/**
 * 컨텍스트 메뉴를 등록한다.
 * chrome.runtime.onInstalled 에서 호출.
 */
export function setupContextMenus() {
  // 기존 메뉴 제거 후 재등록 (업데이트 시 중복 방지)
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: chrome.i18n.getMessage('contextMenuOpen'),
      contexts: ['link'],
      targetUrlPatterns: [
        '*://*/*.hwp',
        '*://*/*.hwp?*',
        '*://*/*.hwpx',
        '*://*/*.hwpx?*'
      ]
    });
  });

  chrome.contextMenus.onClicked.addListener(handleMenuClick);
}

function handleMenuClick(info) {
  if (info.menuItemId === MENU_ID && info.linkUrl) {
    openViewer({ url: info.linkUrl });
  }
}

```

## Representative modules

### apps · apps/studio-host/vite.config.ts

```
import { defineConfig, normalizePath } from 'vite';
import { basename, dirname, relative, resolve } from 'node:path';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import type { Plugin } from 'vite';
import { createHopOverrides } from './hop-overrides';

const desktopConfig = JSON.parse(
  readFileSync(resolve(__dirname, '../desktop/src-tauri/tauri.conf.json'), 'utf-8'),
);
const upstreamStudioDir = resolve(__dirname, '../../third_party/rhwp/rhwp-studio');
const upstreamSrc = resolve(__dirname, '../../third_party/rhwp/rhwp-studio/src');
const hopSrc = resolve(__dirname, 'src');
const rhwpWasmModule = normalizePath(resolve(__dirname, 'vendor/rhwp-core/rhwp.js'));
const rhwpWasmDir = dirname(rhwpWasmModule);
const rhwpWasmPackage = JSON.parse(readFileSync(resolve(rhwpWasmDir, 'package.json'), 'utf-8'));
const fontAssetsDir = resolve(__dirname, '../../assets/fonts');

function hopFontAssets(): Plugin {
  return {
    name: 'hop-font-assets',
    configureServer(server) {
      server.middlewares.use('/fonts', (req, res, next) => {
        const fontName = basename(decodePath(req.url?.split('?')[0] ?? ''));
        if (!fontName.endsWith('.woff2')) {
          next();
          return;
        }

        const fontPath = resolve(fontAssetsDir, fontName);
        const relativeFontPath = relative(fontAssetsDir, fontPath);
        if (relativeFontPath.startsWith('..') || relativeFontPath === '' || !existsSync(fontPath)) {
          next();
          return;
        }

        res.setHeader('Content-Type', 'font/woff2');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        createReadStream(fontPath).pipe(res);
      });
    },
    closeBundle() {
      const outDir = resolve(__dirname, 'dist/fonts');
      mkdirSync(outDir, { recursive: true });
      for (const fileName of readdirSync(fontAssetsDir)) {
        const source = resolve(fontAssetsDir, fileName);
        if (!fileName.endsWith('.woff2') || !statSync(source).isFile()) continue;
        copyFileSync(source, resolve(outDir, fileName));
      }
    },
  };
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return '';
  }
}

export default defineConfig({
  base: './',
  plugins: [hopFontAssets()],
  define: {
    __APP_VERSION__: JSON.stringify(rhwpWasmPackage.version),
    __HOP_VERSION__: JSON.stringify(desktopConfig.version),
  },
  resolve: {
    alias: [
      ...createHopOverrides(hopSrc),
      { find: '@wasm/rhwp.js', replacement: rhwpWasmModule },
      { find: '@upstream', replacement: upstreamSrc },
      { find: '@', replacement: upstreamSrc },
    ],
  },
  server: {
    host: '127.0.0.1',
    port: 7700,
    fs: {
      allow: [
```

### desktop:quicklook · apps/desktop/quicklook/rust/src/lib.rs

```
mod pdf;
#[cfg(test)]
mod tests;

#[cfg(feature = "native-skia")]
use rhwp::document_core::queries::rendering::PngExportOptions;
use rhwp::DocumentCore;
use std::ffi::c_void;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

const HOP_QL_OK: i32 = 0;
const HOP_QL_INVALID_INPUT: i32 = 1;
const HOP_QL_PARSE_FAILED: i32 = 2;
const HOP_QL_EMPTY_DOCUMENT: i32 = 3;
const HOP_QL_RENDER_FAILED: i32 = 4;
const HOP_QL_NO_THUMBNAIL: i32 = 5;
const PREVIEW_MAX_PIXEL_DIMENSION: u32 = 2048;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct HopQuickLookBytes {
    pub ptr: *mut u8,
    pub len: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct HopQuickLookRenderResult {
    pub status: i32,
    pub bytes: HopQuickLookBytes,
    pub page_count: u32,
    pub width: f64,
    pub height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct HopQuickLookThumbnailResult {
    pub status: i32,
    pub bytes: HopQuickLookBytes,
    pub width: u32,
    pub height: u32,
}

#[no_mangle]
#[cfg(feature = "native-skia")]
pub extern "C" fn hop_ql_render_preview_pdf(
    data: *const u8,
    len: usize,
) -> HopQuickLookRenderResult {
    ffi_render_result(|| {
        let bytes = borrowed_bytes(data, len)?;
        let core = DocumentCore::from_bytes(bytes).map_err(|_| HOP_QL_PARSE_FAILED)?;
        let page_count = core.page_count();
        if page_count == 0 {
            return Err(HOP_QL_EMPTY_DOCUMENT);
        }
        let mut png_pages = Vec::with_capacity(page_count as usize);
        let mut first_page_dimensions = None;
        for page in 0..page_count {
            let (width, height) = page_size(&core, page)?;
            if page == 0 {
                first_page_dimensions = Some((width, height));
            }
            png_pages.push(pdf::PngPage {
                png: render_page_png(&core, page, Some(PREVIEW_MAX_PIXEL_DIMENSION))?,
                width,
                height,
            });
        }
        let (width, height) = first_page_dimensions.ok_or(HOP_QL_RENDER_FAILED)?;
        let pdf = pdf::png_pages_to_pdf(png_pages).map_err(|_| HOP_QL_RENDER_FAILED)?;
        Ok(HopQuickLookRenderResult {
            status: HOP_QL_OK,
            bytes: owned_bytes(pdf),
            page_count,
            width,
            height,
        })
```

### desktop:src-tauri · apps/desktop/src-tauri/src/state.rs

```
use crate::pending_open::PendingOpenPaths;
use rhwp::DocumentCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tempfile::NamedTempFile;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DocumentFormat {
    Hwp,
    Hwpx,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentWarning {
    pub code: String,
    pub severity: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentOpenResult {
    pub doc_id: String,
    pub file_name: String,
    pub source_path: Option<String>,
    pub format: DocumentFormat,
    pub page_count: u32,
    pub revision: u64,
    pub dirty: bool,
    pub warnings: Vec<DocumentWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub doc_id: String,
    pub source_path: Option<String>,
    pub format: DocumentFormat,
    pub revision: u64,
    pub dirty: bool,
    pub warnings: Vec<DocumentWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalModificationStatus {
    pub changed: bool,
    pub source_path: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileFingerprint {
    len: u64,
    modified_millis: u64,
    content_hash: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub doc_id: String,
    pub revision: u64,
    pub page_count: u32,
    pub dirty: bool,
    pub cursor: Option<Value>,
    pub warnings: Vec<DocumentWarning>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
```

### scripts · scripts/build-quicklook-macos.mjs

```
#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const quicklookRoot = join(repoRoot, 'apps/desktop/quicklook');
const rustRoot = join(quicklookRoot, 'rust');
const ffiHeader = join(quicklookRoot, 'Sources/Shared/HopQuickLookFFI.h');
const tauriTargetRoot = join(repoRoot, 'apps/desktop/src-tauri/target');
const stagingRoot = join(tauriTargetRoot, 'quicklook');
const plugInsDir = join(stagingRoot, 'PlugIns');
const libDir = join(stagingRoot, 'lib');

if (process.platform !== 'darwin') {
  console.log('[quicklook] non-macOS platform; skipping Quick Look extension build');
  process.exit(0);
}

const target = process.env.HOP_MACOS_TARGET || defaultMacTarget();
const swiftTarget = target === 'x86_64-apple-darwin'
  ? 'x86_64-apple-macosx12.0'
  : 'aarch64-apple-macosx12.0';
const releaseDir = join(rustRoot, 'target', target, 'release');
const staticLib = join(releaseDir, 'libhop_quicklook_ffi.a');
const stagedStaticLib = join(libDir, 'libhop_quicklook_ffi.a');

rmSync(stagingRoot, { recursive: true, force: true });
mkdirSync(plugInsDir, { recursive: true });
mkdirSync(libDir, { recursive: true });

buildRustStaticLibrary({
  features: ['native-skia'],
  output: stagedStaticLib,
});

buildExtension({
  moduleName: 'HopQuickLookPreview',
  appexName: 'HopQuickLookPreview.appex',
  staticLib: stagedStaticLib,
  infoPlist: join(quicklookRoot, 'Resources/Preview/Info.plist'),
  sources: [
    join(quicklookRoot, 'Sources/Shared/HopQuickLookFFI.swift'),
    join(quicklookRoot, 'Sources/Preview/HwpPreviewProvider.swift'),
  ],
  frameworks: [
    'CoreFoundation',
    'CoreGraphics',
    'CoreText',
    'Foundation',
    'QuickLookUI',
    'UniformTypeIdentifiers',
    'OSLog',
  ],
});

buildExtension({
  moduleName: 'HopQuickLookThumbnail',
  appexName: 'HopQuickLookThumbnail.appex',
  staticLib: stagedStaticLib,
  infoPlist: join(quicklookRoot, 'Resources/Thumbnail/Info.plist'),
  sources: [
    join(quicklookRoot, 'Sources/Shared/HopQuickLookFFI.swift'),
    join(quicklookRoot, 'Sources/Thumbnail/HwpThumbnailProvider.swift'),
  ],
  frameworks: [
    'CoreGraphics',
    'CoreFoundation',
    'CoreText',
    'Foundation',
    'ImageIO',
    'QuickLookThumbnailing',
    'UniformTypeIdentifiers',
    'OSLog',
  ],
});

console.log(`[quicklook] staged extensions in ${plugInsDir}`);

```

### site · site/downloads.js

```
const repository = "golbin/hop";
const releasesUrl = `https://github.com/${repository}/releases`;
const latestReleaseApiUrl = `https://api.github.com/repos/${repository}/releases/latest`;

const downloadLinks = Array.from(
  document.querySelectorAll("[data-download-asset]"),
);
const downloadStatus = document.querySelector("#download-status");

function pointToReleases(message) {
  for (const link of downloadLinks) {
    link.href = releasesUrl;
    link.dataset.available = "false";
  }

  if (downloadStatus) {
    downloadStatus.textContent = message;
  }
}

async function hydrateDownloadLinks() {
  if (downloadLinks.length === 0) {
    return;
  }

  const response = await fetch(latestReleaseApiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  });

  if (response.status === 404) {
    pointToReleases(
      "아직 공개된 최신 릴리즈가 없습니다. 릴리즈 목록에서 준비 상태를 확인할 수 있습니다.",
    );
    return;
  }

  if (!response.ok) {
    return;
  }

  const release = await response.json();
  const assets = new Map(
    release.assets.map((asset) => [asset.name, asset.browser_download_url]),
  );
  let linkedCount = 0;

  for (const link of downloadLinks) {
    const assetName = link.dataset.downloadAsset;
    const downloadUrl = assets.get(assetName);

    if (downloadUrl) {
      link.href = downloadUrl;
      link.dataset.available = "true";
      linkedCount += 1;
    } else {
      link.href = releasesUrl;
      link.dataset.available = "false";
    }
  }

  if (!downloadStatus) {
    return;
  }

  if (linkedCount === downloadLinks.length) {
    downloadStatus.textContent = `${release.name || release.tag_name} 파일로 연결됩니다.`;
  } else {
    downloadStatus.textContent =
      "일부 플랫폼 파일이 아직 준비되지 않았습니다. 릴리즈 목록에서 전체 파일을 확인할 수 있습니다.";
  }
}

hydrateDownloadLinks().catch(() => {
  // Keep the static latest/download URLs when the API cannot be reached.
});

```

### studio-host · apps/studio-host/src/main.ts

```
import { createBridge, isTauriRuntime } from '@/core/bridge-factory';
import {
  applyDesktopChromePlatformState,
  installNonEditorContextMenuGuards,
} from '@/core/desktop-chrome';
import type { DocumentInfo } from '@/core/types';
import { EventBus } from '@/core/event-bus';
import { createDesktopDocument, setupDesktopEvents } from '@/core/desktop-events';
import { detectDesktopPlatform, hasPrimaryModifier, hydrateDesktopPlatform } from '@/core/platform';
import { CanvasView } from '@/view/canvas-view';
import { InputHandler } from '@upstream/engine/input-handler';
import { Toolbar } from '@/ui/toolbar';
import { MenuBar } from '@/ui/menu-bar';
import { AgentSidebar } from '@/ui/agent-sidebar';
import { loadWebFonts } from '@/core/font-loader';
import { isSupportedDocumentPath } from '@/core/document-files';
import { CommandRegistry } from '@/command/registry';
import { CommandDispatcher } from '@/command/dispatcher';
import type { EditorContext, CommandServices } from '@/command/types';
import { fileCommands } from '@/command/commands/file';
import { confirmSaveBeforeReplacingDocument } from '@upstream/command/commands/file';
import { editCommands } from '@/command/commands/edit';
import { viewCommands } from '@/command/commands/view';
import { formatCommands } from '@/command/commands/format';
import { insertCommands } from '@/command/commands/insert';
import { tableCommands } from '@upstream/command/commands/table';
import { pageCommands } from '@/command/commands/page';
import { toolCommands } from '@/command/commands/tool';
import { ContextMenu } from '@/ui/context-menu';
import { CommandPalette } from '@/ui/command-palette';
import { showValidationModalIfNeeded } from '@/ui/validation-modal';
import { DocumentDirtyState } from '@/core/document-dirty-state';
import { CellSelectionRenderer } from '@upstream/engine/cell-selection-renderer';
import { TableObjectRenderer } from '@upstream/engine/table-object-renderer';
import { TableResizeRenderer } from '@upstream/engine/table-resize-renderer';
import { Ruler } from '@/view/ruler';
import { enhanceCustomSelects } from '@/ui/custom-select';
import { UpdateNotice, type UpdateNoticeActions } from '@/ui/update-notice';
import { HomeScreen } from '@/ui/home-screen';
import type { DesktopBridgeApi } from '@/core/tauri-bridge';

const wasm = createBridge();
const eventBus = new EventBus();
const documentState = new DocumentDirtyState(eventBus);
documentState.installBeforeUnload(window);
let desktopPlatform = detectDesktopPlatform();

type DirtyAwareBridge = {
  markDocumentDirty?(): void;
  hasUnsavedChanges?(): boolean;
};

// E2E 테스트용 전역 노출 (개발 모드 전용)
if (import.meta.env.DEV) {
  (window as any).__wasm = wasm;
  (window as any).__eventBus = eventBus;
  (window as any).__documentState = documentState;
}
let canvasView: CanvasView | null = null;
let inputHandler: InputHandler | null = null;
let toolbar: Toolbar | null = null;
let ruler: Ruler | null = null;
let homeScreen: HomeScreen | null = null;
let agentSidebar: AgentSidebar | null = null;


// ─── 커맨드 시스템 ─────────────────────────────
const registry = new CommandRegistry();

function getContext(): EditorContext {
  const hasDocument = wasm.pageCount > 0;
  return {
    hasDocument,
    hasSelection: inputHandler?.hasSelection() ?? false,
    inTable: inputHandler?.isInTable() ?? false,
    inCellSelectionMode: inputHandler?.isInCellSelectionMode() ?? false,
    inTableObjectSelection: inputHandler?.isInTableObjectSelection() ?? false,
    inPictureObjectSelection: inputHandler?.isInPictureObjectSelection() ?? false,
    inField: inputHandler?.isInField() ?? false,
    isEditable: true,
```

### studio-host:command · apps/studio-host/src/command/commands/file.ts

```
import { fileCommands as upstreamFileCommands } from '@upstream/command/commands/file';
import type { CommandDef, CommandServices } from '@/command/types';
import type { DesktopBridgeApi } from '@/core/tauri-bridge';
import { openPrintDialog } from '@/ui/print-dialog';
import { openRecentDocumentsDialog } from '@/ui/recent-documents-dialog';

type DesktopFileBridge = Pick<
  DesktopBridgeApi,
  | 'openDocumentFromDialog'
  | 'createNewWindow'
  | 'saveDocumentFromCommand'
  | 'saveDocumentAsFromCommand'
  | 'exportPdfFromCommand'
  | 'printCurrentWebview'
>;

type DesktopRecentBridge = Pick<
  DesktopBridgeApi,
  | 'openDocumentByPath'
  | 'listRecentDocuments'
  | 'clearRecentDocuments'
>;

const upstreamById = new Map(upstreamFileCommands.map((command) => [command.id, command]));

function desktopBridge(wasm: unknown): DesktopFileBridge | null {
  if (!wasm || typeof wasm !== 'object') return null;
  const candidate = wasm as Partial<DesktopFileBridge>;
  return typeof candidate.openDocumentFromDialog === 'function'
    && typeof candidate.createNewWindow === 'function'
    && typeof candidate.saveDocumentFromCommand === 'function'
    && typeof candidate.saveDocumentAsFromCommand === 'function'
    && typeof candidate.exportPdfFromCommand === 'function'
    && typeof candidate.printCurrentWebview === 'function'
    ? candidate as DesktopFileBridge
    : null;
}

function recentBridge(wasm: unknown): DesktopRecentBridge | null {
  if (!wasm || typeof wasm !== 'object') return null;
  const candidate = wasm as Partial<DesktopRecentBridge>;
  return typeof candidate.openDocumentByPath === 'function'
    && typeof candidate.listRecentDocuments === 'function'
    && typeof candidate.clearRecentDocuments === 'function'
    ? candidate as DesktopRecentBridge
    : null;
}

function upstream(id: string): CommandDef {
  const command = upstreamById.get(id);
  if (!command) throw new Error(`Upstream file command is missing: ${id}`);
  return command;
}

function withDesktopOverride(id: string, execute: CommandDef['execute']): CommandDef {
  return {
    ...upstream(id),
    execute,
  };
}

function emitStatus(services: CommandServices, message: string): void {
  services.eventBus.emit('desktop-status', message);
}

function reportCommandError(services: CommandServices, action: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  emitStatus(services, `${action} 실패: ${message}`);
  alert(`${action}에 실패했습니다:\n${message}`);
}

const desktopCommands = new Map<string, CommandDef>([
  ['file:open', withDesktopOverride('file:open', async (services) => {
    const desktop = desktopBridge(services.wasm);
    if (!desktop) return upstream('file:open').execute(services);

    const payload = await desktop.openDocumentFromDialog();
    if (payload) services.eventBus.emit('desktop-document-loaded', payload);
  })],
  ['file:save', withDesktopOverride('file:save', async (services) => {
```

### studio-host:command test · apps/studio-host/src/command/commands/file.test.ts

```
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fileCommands } from './file';

const upstreamOpen = vi.hoisted(() => vi.fn());
const upstreamSave = vi.hoisted(() => vi.fn());
const openPrintDialog = vi.hoisted(() => vi.fn());
const openRecentDocumentsDialog = vi.hoisted(() => vi.fn());

vi.mock('@upstream/command/commands/file', () => ({
  fileCommands: [
    { id: 'file:open', label: 'Open', execute: upstreamOpen },
    { id: 'file:save', label: 'Save', execute: upstreamSave },
    { id: 'file:print', label: 'Print', execute: vi.fn() },
  ],
}));

vi.mock('@/ui/print-dialog', () => ({
  openPrintDialog,
}));

vi.mock('@/ui/recent-documents-dialog', () => ({
  openRecentDocumentsDialog,
}));

describe('file command desktop overrides', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openPrintDialog.mockReset();
    openRecentDocumentsDialog.mockReset();
    (globalThis as { alert?: unknown }).alert = vi.fn();
    (globalThis as { window?: unknown }).window = { location: { href: 'http://localhost/' }, open: vi.fn() };
    (globalThis as { document?: unknown }).document = {
      getElementById: vi.fn(() => ({ textContent: 'ready' })),
    };
  });

  it('falls back to upstream open when no desktop bridge is available', async () => {
    await command('file:open').execute(services({ wasm: {} }) as never);

    expect(upstreamOpen).toHaveBeenCalled();
  });

  it('falls back to upstream save when no desktop bridge is available', async () => {
    await command('file:save').execute(services({ wasm: {} }) as never);

    expect(upstreamSave).toHaveBeenCalled();
  });

  it('emits saved events and status when desktop save succeeds', async () => {
    const result = {
      docId: 'doc-1',
      sourcePath: '/tmp/doc.hwp',
      format: 'hwp',
      revision: 2,
      dirty: false,
      warnings: [],
    };
    const eventBus = { emit: vi.fn() };
    const wasm = desktopBridge({
      saveDocumentFromCommand: vi.fn().mockResolvedValue(result),
```

### studio-host:core · apps/studio-host/src/core/ai-apply.ts

```
/**
 * Action Script를 라이브 WASM 문서 엔진에 적용한다(스펙 4장 — 승인 시점).
 *
 * 화면 문서는 WASM rhwp 엔진이 그리므로, 승인된 편집은 이 엔진에 적용한 뒤
 * `eventBus.emit('document-changed')`로 재렌더한다(적용은 호출 측에서 트리거).
 * 여기서는 순수하게 편집 변환만 수행해 테스트 가능하게 한다.
 */

import type { ActionScript, Edit } from './ai-bridge';

/** `applyActionScript`가 의존하는 최소 WASM 편집 표면(WasmBridge가 구조적으로 충족). */
export interface WasmEditing {
  getParagraphLength(sec: number, para: number): number;
  insertText(sec: number, para: number, charOffset: number, text: string): string;
  deleteText(sec: number, para: number, charOffset: number, count: number): string;
  splitParagraph(sec: number, para: number, charOffset: number): string;
  mergeParagraph(sec: number, para: number): string;
  insertPageBreak(sec: number, para: number, charOffset: number): string;
  /** 표를 생성한다. 생성된 표가 놓인 문단/컨트롤 인덱스를 반환한다. */
  createTable(
    sec: number,
    para: number,
    charOffset: number,
    rows: number,
    cols: number,
  ): { ok: boolean; paraIdx: number; controlIdx: number };
  /** 표 셀 영역을 병합한다(0-기준 행/열, 끝 포함). */
  mergeTableCells(
    sec: number,
    parentPara: number,
    controlIdx: number,
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
  ): { ok: boolean; cellCount: number };
  // 최상위 표 셀 편집(플랫). by-path와 달리 셀 줄 재배치(reflow)를 수행해
  // 긴 텍스트가 줄바꿈되고 셀 높이가 늘어난다.
  getCellParagraphLength(
    sec: number,
    parentPara: number,
    controlIdx: number,
    cellIdx: number,
    cellParaIdx: number,
  ): number;
  insertTextInCell(
    sec: number,
    parentPara: number,
    controlIdx: number,
    cellIdx: number,
    cellParaIdx: number,
    charOffset: number,
    text: string,
  ): string;
  deleteTextInCell(
    sec: number,
    parentPara: number,
    controlIdx: number,
    cellIdx: number,
    cellParaIdx: number,
    charOffset: number,
    count: number,
  ): string;
  // 표 셀 편집(중첩 포함, 스펙 2장). pathJson은 `[{controlIndex,cellIndex,cellParaIndex}, …]`.
  getCellParagraphLengthByPath(sec: number, parentPara: number, pathJson: string): number;
  insertTextInCellByPath(
    sec: number,
    parentPara: number,
    pathJson: string,
    charOffset: number,
    text: string,
  ): string;
  splitParagraphInCellByPath(
    sec: number,
    parentPara: number,
    pathJson: string,
    charOffset: number,
  ): string;
  deleteTextInCellByPath(
    sec: number,
```

### studio-host:core test · apps/studio-host/src/core/ai-apply.test.ts

```
import { describe, expect, it } from 'vitest';
import { applyActionScript, type WasmEditing } from './ai-apply';
import type { ActionScript } from './ai-bridge';

class FakeWasm implements WasmEditing {
  calls: string[] = [];
  lengths: Record<string, number> = {};

  getParagraphLength(sec: number, para: number): number {
    this.calls.push(`getParagraphLength(${sec},${para})`);
    return this.lengths[`${sec}.${para}`] ?? 0;
  }
  insertText(sec: number, para: number, charOffset: number, text: string): string {
    this.calls.push(`insertText(${sec},${para},${charOffset},"${text}")`);
    return '';
  }
  deleteText(sec: number, para: number, charOffset: number, count: number): string {
    this.calls.push(`deleteText(${sec},${para},${charOffset},${count})`);
    return '';
  }
  splitParagraph(sec: number, para: number, charOffset: number): string {
    this.calls.push(`splitParagraph(${sec},${para},${charOffset})`);
    return '';
  }
  mergeParagraph(sec: number, para: number): string {
    this.calls.push(`mergeParagraph(${sec},${para})`);
    return '';
  }
  insertPageBreak(sec: number, para: number, charOffset: number): string {
    this.calls.push(`insertPageBreak(${sec},${para},${charOffset})`);
    return '';
  }
  createTable(sec: number, para: number, charOffset: number, rows: number, cols: number) {
    this.calls.push(`createTable(${sec},${para},${charOffset},${rows},${cols})`);
    return { ok: true, paraIdx: para, controlIdx: 0 };
  }
  mergeTableCells(s: number, pp: number, ci: number, sr: number, sc: number, er: number, ec: number) {
    this.calls.push(`mergeTableCells(${s},${pp},${ci},${sr},${sc},${er},${ec})`);
    return { ok: true, cellCount: 1 };
  }
  tableWidth = 0;
  bboxes: Array<{ cellIdx: number; col: number; row: number; colSpan: number }> = [];
  getTableProperties(s: number, pp: number, ci: number) {
    this.calls.push(`getTableProperties(${s},${pp},${ci})`);
    return { tableWidth: this.tableWidth };
  }
  getTableCellBboxes(s: number, pp: number, ci: number) {
    this.calls.push(`getTableCellBboxes(${s},${pp},${ci})`);
    return this.bboxes;
  }
  setCellProperties(s: number, pp: number, ci: number, cell: number, props: { width?: number }) {
    this.calls.push(`setCellProperties(${s},${pp},${ci},${cell},w=${props.width})`);
    return { ok: true };
  }
  applyParaFormatInCell(s: number, pp: number, ci: number, cell: number, cp: number, json: string) {
    this.calls.push(`applyParaFormatInCell(${s},${pp},${ci},${cell},${cp},${json})`);
    return '';
  }
  setTableProperties(s: number, pp: number, ci: number, props: { pageBreak?: number }) {
    this.calls.push(`setTableProperties(${s},${pp},${ci},pageBreak=${props.pageBreak})`);
```

### studio-host:ui · apps/studio-host/src/ui/agent-sidebar.ts

```
/**
 * AI Agent Sidebar — Cursor IDE식 대화형 편집 패널(스펙 1·4·7장).
 *
 * 대화 스레드(유저/AI 버블) + 하단 입력 컴포저(모델 선택 · 이미지/문서 첨부)로
 * 구성된다. 지시 → `aiRequestEdit` → `hop-ai-*` 이벤트 → 어시스턴트 버블에서
 * 스트리밍/가상 Diff 미리보기 → 승인 시에만 라이브 WASM 문서에 적용한다.
 * 데스크톱(Tauri) 런타임 전용.
 */

import '@/styles/agent-sidebar.css';
import {
  interpretAiFailure,
  listenAiEvents,
  parseActionScript,
  type ActionScript,
  type Edit,
  type AiEditFailed,
  type AiEditReady,
  type AiEventUnsubscribe,
  type AiStreamDelta,
  type DocumentContext,
} from '@/core/ai-bridge';
import type { AiBridgeApi, AiImageInput } from '@/core/tauri-bridge';
import {
  applyActionScript,
  parseCellTarget,
  parseParagraphTarget,
  type ApplyResult,
  type ChangedPara,
  type ImageForInsert,
  type WasmEditing,
} from '@/core/ai-apply';
import { buildDiffModel, type DiffItem } from '@/core/ai-diff';
import { AiSessionMachine } from '@/core/ai-session';
import {
  deleteConversation,
  loadConversations,
  upsertConversation,
  type StoredConversation,
  type StoredMessage,
} from '@/core/conversation-store';
import { clearInlineDiff, showInlineDiff, type InlineDiffEntry } from '@/ui/ai-inline-diff';
import type { CursorRect, PageInfo } from '@/core/types';

type AgentBridge = AiBridgeApi &
  WasmEditing & {
    currentDocId(): string | null;
    getCursorRect(sec: number, para: number, charOffset: number): CursorRect;
    getCursorRectByPath(sec: number, parentPara: number, pathJson: string, charOffset: number): CursorRect;
    getPageInfo(pageIndex: number): PageInfo;
    /** 현재 캐럿 위치 — Sliding Window 기준(스펙 4장). 없으면 문서 앞쪽 기준. */
    getCaretPosition?(): { sectionIndex: number; paragraphIndex: number } | null;
    /** 대량/구조 편집 후 줄·페이지 재배치를 강제한다(없으면 무시). */
    reflowLinesegs?(): number;
    markDocumentDirty?(): void;
    // 낙관적 적용(승인 전 미리 반영) + 거절 시 복원용 스냅샷.
    getSourceFormat?(): string;
    exportHwp?(): Uint8Array;
    exportHwpx?(): Uint8Array;
    loadDocument?(data: Uint8Array, fileName?: string): unknown;
    readonly fileName?: string;
  };

interface CanvasViewLike {
  getVirtualScroll(): { getPageOffset(pageIndex: number): number };
  getViewportManager(): { getZoom(): number };
}

export interface AgentSidebarDeps {
  bridge: AgentBridge;
  eventBus: { emit(name: string, payload?: unknown): void };
  getCanvasView(): CanvasViewLike | null;
  scrollContent: HTMLElement;
  scrollContainer: HTMLElement;
  /** 에디터에서 현재 선택된 텍스트(없으면 null). 선택 영역 인식 편집용. */
  getSelectedText?(): string | null;
}

/** 커스텀 OpenAI 호환 엔드포인트(Groq/OpenRouter/Together/LM Studio/게이트웨이). 스펙 5.3장. */
const CUSTOM_PROVIDER = 'openai-compat';
```

### studio-host:ui test · apps/studio-host/src/ui/agent-sidebar.test.ts

```
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiEventHandlers } from '@/core/ai-bridge';

/**
 * AgentSidebar(스펙 PR4) UI 동작 검증.
 *
 * 네이티브 `hop-ai-*` 이벤트는 `listenAiEvents`를 통해 들어오므로, 그 구독을
 * 가로채(captured) 테스트가 직접 델타/완료/실패 이벤트를 흘려보낸다. 실제
 * `parseActionScript`/`interpretAiFailure`는 그대로 사용한다.
 */

let captured: AiEventHandlers | null = null;

vi.mock('@/core/ai-bridge', async (importActual) => {
  const actual = await importActual<typeof import('@/core/ai-bridge')>();
  return {
    ...actual,
    listenAiEvents: vi.fn(async (handlers: AiEventHandlers) => {
      captured = handlers;
      return () => {
        captured = null;
      };
    }),
  };
});

import { AgentSidebar, type AgentSidebarDeps } from './agent-sidebar';

class FakeElement {
  tagName: string;
  className = '';
  private _textContent: string | null = '';
  title = '';
  value = '';
  type = '';
  rows = 0;
  placeholder = '';
  disabled = false;
  checked = false;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  private classes = new Set<string>();
  private attrs = new Map<string, string>();

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
  }

  // 실제 DOM처럼 textContent 설정 시 자식 노드를 제거한다.
  get textContent(): string | null {
    return this._textContent;
  }
  set textContent(value: string | null) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this._textContent = value;
  }
```

### studio-host:view · apps/studio-host/src/view/ruler.ts

```
import { EventBus } from '@/core/event-bus';
import { WasmBridge } from '@/core/wasm-bridge';
import type { ParaProperties } from '@/core/types';
import { VirtualScroll } from '@upstream/view/virtual-scroll';
import { ViewportManager } from '@upstream/view/viewport-manager';
import { resolvePageLeft } from './page-left';

/** 1mm = 96 / 25.4 px (at 96dpi, zoom=1) */
const PX_PER_MM = 96 / 25.4;

/** 눈금자 높이/너비 (CSS px) */
const RULER_SIZE = 20;

/** 눈금자 배경색 (여백 영역) */
const BG_MARGIN = '#d0d0d0';
/** 본문 영역 배경색 */
const BG_BODY = '#ffffff';
/** 눈금선 색상 */
const TICK_COLOR = '#555555';
/** 숫자 색상 */
const TEXT_COLOR = '#333333';
/** 문단 마커 색상 */
const MARKER_COLOR = '#4080c0';
/** 문단 마커 크기 (CSS px) */
const MARKER_SIZE = 6;

export class Ruler {
  private hCtx: CanvasRenderingContext2D | null;
  private vCtx: CanvasRenderingContext2D | null;
  private rafId = 0;
  private unsubscribers: (() => void)[] = [];

  /** 현재 커서 문단의 왼쪽 여백 (px, zoom=1 기준) */
  private paraMarginLeftPx = 0;
  /** 현재 커서 문단의 오른쪽 여백 (px, zoom=1 기준) */
  private paraMarginRightPx = 0;
  /** 현재 커서 문단의 첫 줄 들여쓰기 (px, zoom=1 기준, 음수 = 내어쓰기) */
  private paraIndentPx = 0;
  /** 문단 정보가 유효한지 여부 */
  private hasParaInfo = false;

  /** 셀 내부 여부 및 셀 좌표 (px, zoom=1, 페이지 좌표 기준) */
  private inCell = false;
  private cellX = 0;
  private cellWidth = 0;

  /** 커서의 x 좌표 (px, zoom=1, 페이지 좌표 기준) — 다단에서 현재 단 결정용 */
  private cursorColumnX = 0;

  constructor(
    private hCanvas: HTMLCanvasElement,
    private vCanvas: HTMLCanvasElement,
    private container: HTMLElement,
    private eventBus: EventBus,
    private wasm: WasmBridge,
    private virtualScroll: VirtualScroll,
    private viewportManager: ViewportManager,
  ) {
    this.hCtx = hCanvas.getContext('2d');
    this.vCtx = vCanvas.getContext('2d');

    this.unsubscribers.push(
      eventBus.on('viewport-scroll', () => this.scheduleUpdate()),
      eventBus.on('zoom-changed', () => this.scheduleUpdate()),
      eventBus.on('viewport-resize', () => { this.resize(); this.scheduleUpdate(); }),
      eventBus.on('document-changed', () => this.scheduleUpdate()),
      eventBus.on('cursor-para-changed', (props) => this.onParaChanged(props as ParaProperties)),
      eventBus.on('cursor-cell-changed', (data) => this.onCellChanged(data as { inCell: boolean; cellX?: number; cellWidth?: number })),
      eventBus.on('cursor-rect-updated', (rect: any) => {
        if (rect && typeof rect.x === 'number') {
          this.cursorColumnX = rect.x;
          this.scheduleUpdate();
        }
      }),
    );

    this.resize();
  }

  /** Canvas 물리 크기를 컨테이너에 맞춰 설정 */
```

### third_party · third_party/rhwp/src/renderer/font_metrics_data.rs

```
//! 폰트 메트릭 데이터 (자동 생성)
//!
//! font-metric-gen 도구로 TTF 파일에서 추출.
//! 수동 편집 금지.

#[derive(Debug)]
pub struct HangulMetric {
    pub cho_groups: u8,
    pub jung_groups: u8,
    pub jong_groups: u8,
    pub cho_map: &'static [u8],
    pub jung_map: &'static [u8],
    pub jong_map: &'static [u8],
    pub widths: &'static [u16],
}

#[derive(Debug)]
pub struct FontMetric {
    pub name: &'static str,
    pub bold: bool,
    pub italic: bool,
    pub em_size: u16,
    pub latin_ranges: &'static [LatinRange],
    pub hangul: Option<&'static HangulMetric>,
}

#[derive(Debug)]
pub struct LatinRange {
    pub start: u32,
    pub end: u32,
    pub widths: &'static [u16],
}

impl FontMetric {
    pub fn get_width(&self, ch: char) -> Option<u16> {
        let code = ch as u32;
        // 한글 음절 (U+AC00~U+D7A3)
        if code >= 0xAC00 && code <= 0xD7A3 {
            if let Some(h) = self.hangul {
                let idx = code - 0xAC00;
                let cho = (idx / (21 * 28)) as usize;
                let jung = ((idx % (21 * 28)) / 28) as usize;
                let jong = (idx % 28) as usize;
                let gi = h.cho_map[cho] as usize * h.jung_groups as usize * h.jong_groups as usize
                    + h.jung_map[jung] as usize * h.jong_groups as usize
                    + h.jong_map[jong] as usize;
                return h.widths.get(gi).copied();
            }
            return None;
        }
        // Latin 및 기타 범위
        for range in self.latin_ranges {
            if code >= range.start && code <= range.end {
                let w = range.widths[(code - range.start) as usize];
                return if w > 0 { Some(w) } else { None };
            }
        }
        None
    }
}

/// find_metric의 반환값: 메트릭 + 폴백 정보
pub struct MetricMatch {
    pub metric: &'static FontMetric,
    /// Bold 요청했으나 Bold 메트릭이 없어 Regular로 폴백됨
    /// → Faux Bold 폭 보정이 필요한 경우 true
    pub bold_fallback: bool,
}

/// 한국어 폰트 이름 → 내장 메트릭 영문 이름 별칭.
///
/// 계층:
/// 1. style_resolver.rs 가 한국어 별칭 → 한국어 정규명 (예: 한양중고딕 → HY중고딕)
/// 2. 본 함수가 한국어 정규명 → 영문 DB 이름 (예: HY중고딕 → HYGothic-Medium)
/// 3. find_metric 이 FONT_METRICS 에서 영문 이름으로 조회
///
/// 본한글/본명조 는 정식 메트릭 DB 엔트리가 없어 Pretendard/Noto Serif KR 로
/// 근사. 근거: 같은 한글 원천 (Source Han Sans KR), 이미 번들, OFL 호환.
/// 한계: Latin 폭 미세 차이, weight 축은 2단계로 근사 (본한글vf 는 wght 중간값을
/// Regular/Bold 중 가까운 쪽으로). CJK 폰트는 weight 별 한글 폭 차이가 작으므로
```