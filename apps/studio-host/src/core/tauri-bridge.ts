import { WasmBridge } from '@/core/wasm-bridge';
import type { DocumentInfo } from '@/core/types';
import { remove, stat } from '@tauri-apps/plugin-fs';
import { finiteFileSize, readFileInChunks, writeFileInChunks } from './chunked-fs';
import type { DocumentContext } from './ai-bridge';

type DocumentFormat = 'hwp' | 'hwpx';

interface NativeOpenResult {
  docId: string;
  fileName: string;
  sourcePath?: string | null;
  format: DocumentFormat;
  pageCount: number;
  revision: number;
  dirty: boolean;
  warnings: unknown[];
}

interface SourceFingerprint {
  len: number;
  modifiedMillis: number;
  contentHash: number;
}

interface ExternalModificationStatus {
  changed: boolean;
  sourcePath?: string | null;
  reason?: string | null;
}

export type DesktopUpdateState =
  | { status: 'idle' }
  | {
      status: 'available';
      version: string;
    }
  | {
      status: 'downloading';
      version: string;
      downloadedBytes: number;
      totalBytes?: number | null;
    }
  | {
      status: 'ready';
      version: string;
    }
  | {
      status: 'error';
      version: string;
      message: string;
    };

export interface DesktopSaveResult {
  docId: string;
  sourcePath?: string | null;
  format: DocumentFormat;
  revision: number;
  dirty: boolean;
  warnings: unknown[];
}

export interface RecentDocument {
  path: string;
  fileName: string;
}

export interface DesktopLoadPayload {
  docInfo: DocumentInfo;
  message: string;
}

export interface DesktopBridgeApi {
  openDocumentFromDialog(): Promise<DesktopLoadPayload | null>;
  openDocumentByPath(path: string): Promise<DesktopLoadPayload | null>;
  takePendingOpenPaths(): Promise<string[]>;
  createNewDocumentAsync(): Promise<DesktopLoadPayload | null>;
  createNewWindow(): Promise<string>;
  saveDocumentFromCommand(): Promise<DesktopSaveResult | null>;
  saveDocumentAsFromCommand(): Promise<DesktopSaveResult | null>;
  exportPdfFromCommand(): Promise<string | null>;
  printCurrentWebview(): Promise<void>;
  destroyCurrentWindow(): Promise<void>;
  cancelAppQuit(): Promise<void>;
  revealInFolder(): Promise<void>;
  listRecentDocuments(): Promise<RecentDocument[]>;
  clearRecentDocuments(): Promise<void>;
  renderDocumentPreview(path: string): Promise<string>;
  getUpdateState(): Promise<DesktopUpdateState>;
  startUpdateInstall(): Promise<void>;
  restartToApplyUpdate(): Promise<void>;
  hasUnsavedChanges(): boolean;
  markDocumentDirty(): void;
  confirmWindowClose(): Promise<boolean>;
}

/** AI Agent 인라인 편집 브리지(스펙 1장). */
/** vision provider에 전달하는 첨부 이미지(base64, data URL 접두사 없이). */
export interface AiImageInput {
  mimeType: string;
  dataBase64: string;
}

export interface AiBridgeApi {
  /** 현재 문서를 직렬화한 LLM 컨텍스트를 반환한다(스펙 2장). `cursorPath`는 Sliding Window 기준(4장).
   *  `fullDocument`가 참이면 윈도우 없이 전체(본문+표 셀)를 직렬화한다(교정 패스 등 전수 스캔용). */
  aiGetDocumentContext(
    docId: string,
    currentSelectionOnly: boolean,
    cursorPath?: string | null,
    fullDocument?: boolean,
  ): Promise<DocumentContext>;
  /** 편집 요청을 시작하고 request_id를 반환한다. 결과는 `hop-ai-*` 이벤트로 전달된다.
   *  `baseUrl`은 `openai-compat`(커스텀 OpenAI 호환 엔드포인트)에서만 쓰인다.
   *  `images`는 vision 지원 provider에 전달되는 첨부 이미지(base64).
   *  `targetIds`가 있으면 그 노드들만 직렬화·허용하는 스코프 요청이 된다(구간 교정용). */
  aiRequestEdit(
    docId: string,
    userPrompt: string,
    providerId: string,
    modelId: string,
    cursorPath?: string | null,
    baseUrl?: string | null,
    images?: AiImageInput[] | null,
    documents?: AiImageInput[] | null,
    filePaths?: string[] | null,
    targetIds?: string[] | null,
    /** Some이면 '양식 이어쓰기' 모드(F-ae778890): AI가 표를 그리지 않고 라벨→값 내용만
     *  반환하도록 전용 프롬프트·스키마를 쓴다. labels는 소스 양식 표의 필드 라벨. */
    formFillLabels?: string[] | null,
  ): Promise<string>;
  /** HWP/HWPX 파일의 평문 텍스트를 추출한다(첨부용). */
  aiExtractText(path: string): Promise<string>;
  /** URL에서 이미지를 내려받아 base64+MIME로 반환한다(웹뷰 CORS 우회). */
  aiFetchImage(url: string): Promise<{ dataBase64: string; mime: string }>;
  /** PDF에서 내장 이미지를 추출해 base64+MIME 목록으로 반환한다. */
  aiExtractPdfImages(path: string): Promise<{ dataBase64: string; mime: string }[]>;
  /** PDF에서 요청(query)과 관련된 페이지를 렌더해 base64 PNG 목록으로 반환한다(그래프 등). */
  aiRenderPdfFigurePages(
    path: string,
    query: string,
  ): Promise<{ dataBase64: string; mime: string; page?: number; figureOnly?: boolean }[]>;
  /** 글쓰기 스킬 목록(문서 유형별 작성 지침 .md). */
  aiListSkills(): Promise<
    { id: string; name: string; description: string; triggers: string[]; body: string }[]
  >;
  /** 스킬 폴더를 OS 파일 탐색기로 연다(사용자가 .md 추가/편집). */
  aiOpenSkillsDir(): Promise<void>;
  /** 디자인 테마 목록(간격·크기·색 수치 .json — core/doc-theme이 해석). */
  aiListThemes(): Promise<import('./doc-theme').DocTheme[]>;
  /** 테마 폴더를 OS 파일 탐색기로 연다(사용자가 .json 추가/편집). */
  aiOpenThemesDir(): Promise<void>;
  /** 진행 중인 요청을 취소한다(스펙 7장). */
  aiCancelRequest(requestId: string): Promise<void>;
  /** provider API 키를 OS 보안 저장소에 저장한다(스펙 6장). */
  aiSetApiKey(providerId: string, apiKey: string): Promise<void>;
  /** provider 키가 저장돼 있는지 확인한다. 키 자체는 반환하지 않는다. */
  aiHasApiKey(providerId: string): Promise<boolean>;
  /** 저장된 provider 키를 삭제한다. */
  aiDeleteApiKey(providerId: string): Promise<void>;
  /** 문서를 민감(기밀)으로 표시/해제한다. 표시 시 외부 provider 전송이 차단된다(스펙 6장). */
  aiSetDocumentSensitivity(docId: string, sensitive: boolean): Promise<void>;
}

export class TauriBridge extends WasmBridge implements DesktopBridgeApi, AiBridgeApi {
  private docId: string | null = null;
  private sourcePath: string | null = null;
  private sourceFormat: DocumentFormat = 'hwp';
  private revision = 0;
  private dirty = false;

  /** 현재 네이티브 문서 세션 ID. AI 커맨드 호출에 사용한다. */
  currentDocId(): string | null {
    return this.docId;
  }

  async openDocumentFromDialog(): Promise<DesktopLoadPayload | null> {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({
      multiple: false,
      filters: [{ name: 'HWP/HWPX 문서', extensions: ['hwp', 'hwpx'] }],
    });
    if (!selected || Array.isArray(selected)) return null;
    return this.openDocumentByPath(selected);
  }

  async openDocumentByPath(path: string): Promise<DesktopLoadPayload | null> {
    if (!(await this.confirmReadyForDocumentReplacement())) return null;

    await this.invoke<void>('prepare_document_open', { path });
    const { bytes, sourceFingerprint } = await this.readFileForOpen(path);
    const result = await this.invoke<NativeOpenResult>('open_document_tracking', {
      path,
      sourceFingerprint,
    });
    const previousDocId = this.docId;
    try {
      const info = super.loadDocument(bytes, result.fileName);
      this.applyNativeOpenResult(result, this.normalizedSourceFormat(super.getSourceFormat()));
      await this.noteFinderRecentDocument(path);
      await this.recordRecentDocument(path);
      await this.closeReplacedDocument(previousDocId, result.docId);
      return {
        docInfo: info,
        message: `${result.fileName} — ${info.pageCount}페이지`,
      };
    } catch (error) {
      await this.closeNativeDocument(result.docId);
      throw error;
    }
  }

  async takePendingOpenPaths(): Promise<string[]> {
    return this.invoke<string[]>('take_pending_open_paths');
  }

  async createNewDocumentAsync(): Promise<DesktopLoadPayload | null> {
    if (!(await this.confirmReadyForDocumentReplacement())) return null;

    const result = await this.invoke<NativeOpenResult>('create_document');
    const previousDocId = this.docId;
    try {
      const info = super.createNewDocument();
      this.applyNativeOpenResult(result);
      await this.closeReplacedDocument(previousDocId, result.docId);
      return {
        docInfo: info,
        message: `새 문서.hwp — ${info.pageCount}페이지`,
      };
    } catch (error) {
      await this.closeNativeDocument(result.docId);
      throw error;
    }
  }

  async createNewWindow(): Promise<string> {
    return this.invoke<string>('create_editor_window');
  }

  getSourceFormat(): string {
    return this.sourceFormat;
  }

  async saveDocumentFromCommand(): Promise<DesktopSaveResult | null> {
    const docId = this.ensureDocumentLoaded();
    if (!this.sourcePath) {
      return this.saveDocumentAsFromCommand();
    }
    if (this.sourceFormat === 'hwpx') {
      throw new Error('HWPX 원본 저장은 아직 안전하게 지원하지 않습니다. 다른 이름으로 저장에서 HWP 파일로 저장하세요.');
    }
    return this.saveHwpThroughStaging(docId, null);
  }

  async saveDocumentAsFromCommand(): Promise<DesktopSaveResult | null> {
    const docId = this.ensureDocumentLoaded();
    const targetPath = await this.selectSavePath(this.suggestedHwpName(), 'HWP 문서', ['hwp']);
    if (!targetPath) return null;
    return this.saveHwpThroughStaging(docId, this.withExtension(targetPath, 'hwp'));
  }

  async exportPdfFromCommand(): Promise<string | null> {
    this.ensureDocumentLoaded();
    const targetPath = await this.selectSavePath(this.suggestedPdfName(), 'PDF 문서', ['pdf']);
    if (!targetPath) return null;
    const finalPath = this.withExtension(targetPath, 'pdf');
    const stagedPath = await this.invoke<string>('prepare_staged_hwp_pdf_export', {
      targetPath: finalPath,
    });
    try {
      await this.writeCurrentHwpToPath(stagedPath);
      return await this.invoke<string>('export_pdf_from_hwp_path', {
        stagedPath,
        targetPath: finalPath,
        pageRange: null,
        openAfter: true,
      });
    } finally {
      await remove(stagedPath).catch(() => undefined);
    }
  }

  async printCurrentWebview(): Promise<void> {
    await this.invoke<void>('print_webview');
  }

  async destroyCurrentWindow(): Promise<void> {
    await this.invoke<void>('destroy_current_window');
  }

  async cancelAppQuit(): Promise<void> {
    await this.invoke<void>('cancel_app_quit');
  }

  async revealInFolder(): Promise<void> {
    if (!this.sourcePath) return;
    await this.invoke<void>('reveal_in_folder', { path: this.sourcePath });
  }

  async listRecentDocuments(): Promise<RecentDocument[]> {
    return this.invoke<RecentDocument[]>('list_recent_documents');
  }

  async clearRecentDocuments(): Promise<void> {
    await this.invoke<void>('clear_recent_documents');
  }

  async renderDocumentPreview(path: string): Promise<string> {
    return this.invoke<string>('render_document_preview', { path });
  }

  async getUpdateState(): Promise<DesktopUpdateState> {
    return this.invoke<DesktopUpdateState>('get_update_state');
  }

  async startUpdateInstall(): Promise<void> {
    await this.invoke<void>('start_update_install');
  }

  async restartToApplyUpdate(): Promise<void> {
    await this.invoke<void>('restart_to_apply_update');
  }

  hasUnsavedChanges(): boolean {
    return Boolean(this.docId && this.dirty);
  }

  markDocumentDirty(): void {
    if (!this.docId || this.dirty) return;
    this.dirty = true;
    void this.invoke<void>('mark_document_dirty', { docId: this.docId }).catch((error: unknown) => {
      console.warn('[TauriBridge] native dirty state update failed:', error);
    });
    this.updateDocumentTitle();
  }

  async confirmWindowClose(): Promise<boolean> {
    const canClose = await this.confirmReadyForDocumentReplacement();
    if (canClose) await this.releaseCurrentNativeDocument();
    return canClose;
  }

  async aiGetDocumentContext(
    docId: string,
    currentSelectionOnly: boolean,
    cursorPath?: string | null,
    fullDocument?: boolean,
  ): Promise<DocumentContext> {
    return this.invoke<DocumentContext>('ai_get_document_context', {
      docId,
      currentSelectionOnly,
      cursorPath: cursorPath ?? null,
      fullDocument: fullDocument ?? null,
    });
  }

  async aiRequestEdit(
    docId: string,
    userPrompt: string,
    providerId: string,
    modelId: string,
    cursorPath?: string | null,
    baseUrl?: string | null,
    images?: AiImageInput[] | null,
    documents?: AiImageInput[] | null,
    filePaths?: string[] | null,
    targetIds?: string[] | null,
    formFillLabels?: string[] | null,
  ): Promise<string> {
    return this.invoke<string>('ai_request_edit', {
      docId,
      userPrompt,
      providerId,
      modelId,
      cursorPath: cursorPath ?? null,
      baseUrl: baseUrl ?? null,
      images: images ?? null,
      documents: documents ?? null,
      filePaths: filePaths ?? null,
      targetIds: targetIds ?? null,
      formFillLabels: formFillLabels ?? null,
    });
  }

  async aiExtractText(path: string): Promise<string> {
    return this.invoke<string>('ai_extract_text', { path });
  }

  async aiFetchImage(url: string): Promise<{ dataBase64: string; mime: string }> {
    const json = await this.invoke<string>('ai_fetch_image', { url });
    return JSON.parse(json) as { dataBase64: string; mime: string };
  }

  async aiExtractPdfImages(path: string): Promise<{ dataBase64: string; mime: string }[]> {
    const json = await this.invoke<string>('ai_extract_pdf_images', { path });
    return JSON.parse(json) as { dataBase64: string; mime: string }[];
  }

  async aiRenderPdfFigurePages(
    path: string,
    query: string,
  ): Promise<{ dataBase64: string; mime: string; page?: number; figureOnly?: boolean }[]> {
    const json = await this.invoke<string>('ai_render_pdf_figure_pages', { path, query });
    return JSON.parse(json) as {
      dataBase64: string;
      mime: string;
      page?: number;
      figureOnly?: boolean;
    }[];
  }

  async aiListSkills(): Promise<
    { id: string; name: string; description: string; triggers: string[]; body: string }[]
  > {
    const json = await this.invoke<string>('ai_list_skills');
    return JSON.parse(json) as {
      id: string;
      name: string;
      description: string;
      triggers: string[];
      body: string;
    }[];
  }

  async aiOpenSkillsDir(): Promise<void> {
    await this.invoke<void>('ai_open_skills_dir');
  }

  async aiListThemes(): Promise<import('./doc-theme').DocTheme[]> {
    const json = await this.invoke<string>('ai_list_themes');
    return JSON.parse(json) as import('./doc-theme').DocTheme[];
  }

  async aiOpenThemesDir(): Promise<void> {
    await this.invoke<void>('ai_open_themes_dir');
  }

  async aiCancelRequest(requestId: string): Promise<void> {
    await this.invoke<void>('ai_cancel_request', { requestId });
  }

  async aiSetApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.invoke<void>('ai_set_api_key', { providerId, apiKey });
  }

  async aiHasApiKey(providerId: string): Promise<boolean> {
    return this.invoke<boolean>('ai_has_api_key', { providerId });
  }

  async aiDeleteApiKey(providerId: string): Promise<void> {
    await this.invoke<void>('ai_delete_api_key', { providerId });
  }

  async aiSetDocumentSensitivity(docId: string, sensitive: boolean): Promise<void> {
    await this.invoke<void>('ai_set_document_sensitivity', { docId, sensitive });
  }

  private async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>(command, args);
  }

  private async closeNativeDocument(docId: string): Promise<void> {
    try {
      await this.invoke<void>('close_document', { docId });
    } catch (error) {
      console.warn('[TauriBridge] native document cleanup failed:', error);
    }
  }

  private async recordRecentDocument(path: string): Promise<void> {
    await this.invoke<void>('record_recent_document', { path }).catch((error: unknown) => {
      console.warn('[TauriBridge] recent document update failed:', error);
    });
  }

  private async noteFinderRecentDocument(path: string): Promise<void> {
    await this.invoke<void>('note_finder_recent_document', { path }).catch((error: unknown) => {
      console.warn('[TauriBridge] Finder recent document update failed:', error);
    });
  }

  private async closeReplacedDocument(previousDocId: string | null, nextDocId: string): Promise<void> {
    if (previousDocId && previousDocId !== nextDocId) {
      await this.closeNativeDocument(previousDocId);
    }
  }

  private async releaseCurrentNativeDocument(): Promise<void> {
    if (this.docId) {
      await this.closeNativeDocument(this.docId);
    }
    this.docId = null;
    this.sourcePath = null;
    this.dirty = false;
    this.updateDocumentTitle();
  }

  private ensureDocumentLoaded(): string {
    if (!this.docId) throw new Error('문서가 로드되지 않았습니다');
    return this.docId;
  }

  private async selectSavePath(
    defaultPath: string,
    filterName: string,
    extensions: string[],
  ): Promise<string | null> {
    const { save } = await import('@tauri-apps/plugin-dialog');
    return save({
      defaultPath,
      filters: [{ name: filterName, extensions }],
    });
  }

  private async saveHwpThroughStaging(
    docId: string,
    targetPath: string | null,
  ): Promise<DesktopSaveResult | null> {
    const finalPath = targetPath ?? this.sourcePath;
    if (!finalPath) throw new Error('새 문서는 저장 경로가 필요합니다');

    const allowExternalOverwrite = await this.confirmExternalOverwriteIfNeeded(docId, finalPath);
    if (allowExternalOverwrite === null) return null;

    const stagedPath = await this.invoke<string>('prepare_staged_hwp_save', { targetPath: finalPath });
    try {
      await this.writeCurrentHwpToPath(stagedPath);
      const result = await this.invoke<DesktopSaveResult>('commit_staged_hwp_save', {
        docId,
        stagedPath,
        targetPath: finalPath,
        expectedRevision: this.revision,
        allowExternalOverwrite,
      });
      this.applyNativeSaveResult(result);
      await this.noteFinderRecentDocument(finalPath);
      return result;
    } finally {
      await remove(stagedPath).catch(() => undefined);
    }
  }

  private async confirmExternalOverwriteIfNeeded(
    docId: string,
    targetPath: string | null,
  ): Promise<boolean | null> {
    const effectivePath = targetPath ?? this.sourcePath;
    const status = await this.invoke<ExternalModificationStatus>('check_external_modification', {
      docId,
      targetPath: effectivePath,
    });
    if (!status.changed) return false;

    const { message } = await import('@tauri-apps/plugin-dialog');
    const overwriteLabel = '덮어쓰기';
    const cancelLabel = '저장 취소';
    const result = await message(
      [
        '원본 파일이 HOP 밖에서 변경되었습니다.',
        status.sourcePath ? `파일: ${status.sourcePath}` : '',
        status.reason ?? '',
        '',
        '그대로 저장하면 외부에서 변경된 내용이 사라질 수 있습니다.',
      ].filter(Boolean).join('\n'),
      {
        title: '외부 변경 감지',
        kind: 'warning',
        buttons: {
          yes: overwriteLabel,
          no: cancelLabel,
          cancel: '취소',
        },
      },
    );

    return result === overwriteLabel || result === 'Yes' ? true : null;
  }

  private async confirmReadyForDocumentReplacement(): Promise<boolean> {
    if (!this.hasUnsavedChanges()) return true;

    const decision = await this.promptUnsavedChanges();
    if (decision === 'cancel') return false;
    if (decision === 'discard') return true;

    try {
      const result = await this.saveCurrentDocumentForSafety();
      return result !== null;
    } catch (error) {
      await this.showError('저장 실패', `문서를 저장하지 못했습니다.\n${error}`);
      return false;
    }
  }

  private async saveCurrentDocumentForSafety(): Promise<DesktopSaveResult | null> {
    if (this.sourceFormat === 'hwpx') {
      return this.saveDocumentAsFromCommand();
    }
    return this.saveDocumentFromCommand();
  }

  private async promptUnsavedChanges(): Promise<'save' | 'discard' | 'cancel'> {
    const { message } = await import('@tauri-apps/plugin-dialog');
    const saveLabel = '저장';
    const discardLabel = '저장 안 함';
    const result = await message(
      `${this.fileName || '현재 문서'}의 변경 내용을 저장할까요?`,
      {
        title: '저장 확인',
        kind: 'warning',
        buttons: {
          yes: saveLabel,
          no: discardLabel,
          cancel: '취소',
        },
      },
    );

    if (result === saveLabel || result === 'Yes') return 'save';
    if (result === discardLabel || result === 'No') return 'discard';
    return 'cancel';
  }

  private async showError(title: string, text: string): Promise<void> {
    const { message } = await import('@tauri-apps/plugin-dialog');
    await message(text, {
      title,
      kind: 'error',
      buttons: { ok: '확인' },
    });
  }

  private async writeCurrentHwpToPath(path: string): Promise<void> {
    await writeFileInChunks(path, super.exportHwp());
  }

  private withExtension(path: string, extension: string): string {
    const escaped = extension.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\.${escaped}$`, 'i').test(path) ? path : `${path}.${extension}`;
  }

  private async readFileForOpen(path: string): Promise<{
    bytes: Uint8Array;
    sourceFingerprint?: SourceFingerprint;
  }> {
    const before = await stat(path);
    const { bytes, contentHash } = await readFileInChunks(path, finiteFileSize(before.size));
    const after = await stat(path);
    const beforeFingerprint = this.statFingerprint(before);
    const afterFingerprint = this.statFingerprint(after);
    if (
      beforeFingerprint &&
      afterFingerprint &&
      (beforeFingerprint.len !== afterFingerprint.len ||
        beforeFingerprint.modifiedMillis !== afterFingerprint.modifiedMillis)
    ) {
      throw new Error('파일을 읽는 중 변경되었습니다. 다시 시도하세요.');
    }
    return {
      bytes,
      sourceFingerprint: afterFingerprint
        ? {
            ...afterFingerprint,
            contentHash,
          }
        : undefined,
    };
  }

  private statFingerprint(
    info: Partial<{
      size: number;
      mtime: Date | null;
    }>,
  ): Pick<SourceFingerprint, 'len' | 'modifiedMillis'> | undefined {
    const size = finiteFileSize(info.size);
    const modifiedMillis = info.mtime instanceof Date ? info.mtime.getTime() : undefined;
    if (size === undefined || modifiedMillis === undefined || !Number.isFinite(modifiedMillis)) {
      return undefined;
    }
    return { len: size, modifiedMillis };
  }

  private normalizedSourceFormat(value: string): DocumentFormat {
    return value === 'hwpx' ? 'hwpx' : 'hwp';
  }

  private applyNativeOpenResult(result: NativeOpenResult, sourceFormat = result.format): void {
    this.docId = result.docId;
    this.sourcePath = result.sourcePath ?? null;
    this.sourceFormat = sourceFormat;
    this.revision = result.revision;
    this.dirty = result.dirty;
    this.fileName = result.fileName;
    this.updateDocumentTitle();
  }

  private applyNativeSaveResult(result: DesktopSaveResult): void {
    this.docId = result.docId;
    this.sourcePath = result.sourcePath ?? null;
    this.sourceFormat = result.format;
    this.revision = result.revision;
    this.dirty = result.dirty;
    if (this.sourcePath) {
      this.fileName = this.sourcePath.split(/[\\/]/).pop() || this.fileName;
    }
    this.updateDocumentTitle();
  }

  private suggestedHwpName(): string {
    const name = this.fileName.replace(/\.(hwp|hwpx)$/i, '') || 'document';
    return `${name}.hwp`;
  }

  private suggestedPdfName(): string {
    const name = this.fileName.replace(/\.(hwp|hwpx)$/i, '') || 'document';
    return `${name}.pdf`;
  }

  private updateDocumentTitle(): void {
    const name = this.docId ? this.fileName || '문서' : 'HOP';
    document.title = `${this.dirty ? '• ' : ''}${name} - HOP`;
  }
}
