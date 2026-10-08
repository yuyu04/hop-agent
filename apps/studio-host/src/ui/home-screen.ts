// 문서를 열지 않았을 때의 시작 화면(새 문서·열기·최근 문서).
import type { DesktopBridgeApi, RecentDocument } from '@/core/tauri-bridge';
import { parsePreviewSvg } from '@/ui/preview-svg';

type HomeScreenBridge = Partial<Pick<
  DesktopBridgeApi,
  'listRecentDocuments' | 'openDocumentByPath' | 'renderDocumentPreview'
>>;
const RECENT_DOCUMENTS_PER_PAGE = 5;

interface HomeScreenActions {
  openFile(): void;
  createNewDocument(): void;
  onDocumentLoaded(payload: unknown): void;
  setMessage(message: string): void;
}

export class HomeScreen {
  private root: HTMLElement;
  private recentSection: HTMLElement;
  private recentTrack: HTMLElement;
  private recentHint: HTMLElement;
  private recentPagination: HTMLElement;
  private recentPageLabel: HTMLElement;
  private prevButton: HTMLButtonElement;
  private nextButton: HTMLButtonElement;
  private readonly bridge: HomeScreenBridge;
  private currentPage = 0;
  private recentDocuments: RecentDocument[] = [];

  constructor(
    private container: HTMLElement,
    bridge: unknown,
    private actions: HomeScreenActions,
  ) {
    this.bridge = (bridge && typeof bridge === 'object') ? bridge as HomeScreenBridge : {};
    this.root = this.build();
    this.recentSection = this.root.querySelector('.home-recent') as HTMLElement;
    this.recentTrack = this.root.querySelector('.home-recent-track') as HTMLElement;
    this.recentHint = this.root.querySelector('.home-recent-hint') as HTMLElement;
    this.recentPagination = this.root.querySelector('.home-recent-pagination') as HTMLElement;
    this.recentPageLabel = this.root.querySelector('.home-recent-page-label') as HTMLElement;
    this.prevButton = this.root.querySelector('.home-recent-page-prev') as HTMLButtonElement;
    this.nextButton = this.root.querySelector('.home-recent-page-next') as HTMLButtonElement;
    this.container.appendChild(this.root);
  }

  async refresh(hasDocument: boolean): Promise<void> {
    this.root.hidden = hasDocument;
    this.container.classList.toggle('home-visible', !hasDocument);
    if (hasDocument) return;

    const recentDocuments = await this.loadRecentDocuments();
    this.renderRecentDocuments(recentDocuments);
  }

  private build(): HTMLElement {
    const root = document.createElement('section');
    root.className = 'home-screen';
    root.hidden = true;
    root.append(this.createHero(), this.createRecentSection(), this.createDropHint());
    return root;
  }

  private createHero(): HTMLElement {
    const hero = document.createElement('div');
    hero.className = 'home-hero';
    const title = document.createElement('h1');
    title.className = 'home-title';
    title.textContent = '최근에 작업한 문서를 바로 이어서 열어보세요';
    const subtitle = document.createElement('p');
    subtitle.className = 'home-subtitle';
    subtitle.textContent = 'HWP/HWPX 문서를 열거나 새 문서를 만들고, 드래그 앤 드롭으로 바로 시작할 수 있습니다.';
    const actions = document.createElement('div');
    actions.className = 'home-actions';
    actions.append(
      this.createActionButton('문서 열기', '홈 화면에서 파일 선택', () => {
        this.actions.openFile();
      }),
      this.createActionButton('새 문서', '빈 HWP 문서 만들기', () => {
        this.actions.createNewDocument();
      }),
    );
    hero.append(title, subtitle, actions);
    return hero;
  }

  private createRecentSection(): HTMLElement {
    const recentSection = document.createElement('section');
    recentSection.className = 'home-recent';
    const recentHeader = document.createElement('div');
    recentHeader.className = 'home-section-header';
    const recentTitle = document.createElement('h2');
    recentTitle.className = 'home-section-title';
    recentTitle.textContent = '최근 문서';
    const recentPagination = document.createElement('div');
    recentPagination.className = 'home-recent-pagination';
    const prevButton = document.createElement('button');
    prevButton.type = 'button';
    prevButton.className = 'home-recent-page-btn home-recent-page-prev';
    prevButton.textContent = '이전';
    prevButton.addEventListener('click', () => {
      this.changePage(-1);
    });
    const pageLabel = document.createElement('span');
    pageLabel.className = 'home-recent-page-label';
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'home-recent-page-btn home-recent-page-next';
    nextButton.textContent = '다음';
    nextButton.addEventListener('click', () => {
      this.changePage(1);
    });
    recentPagination.append(prevButton, pageLabel, nextButton);
    const recentHint = document.createElement('p');
    recentHint.className = 'home-recent-hint';
    const recentTrack = document.createElement('div');
    recentTrack.className = 'home-recent-track';
    recentHeader.append(recentTitle, recentPagination);
    recentSection.append(recentHeader, recentHint, recentTrack);
    return recentSection;
  }

  private createDropHint(): HTMLElement {
    const dropHint = document.createElement('div');
    dropHint.className = 'home-drop-hint';
    dropHint.textContent = '파일을 이 창으로 끌어다 놓아도 열 수 있습니다.';
    return dropHint;
  }

  private createActionButton(label: string, description: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'home-action';
    const title = document.createElement('span');
    title.className = 'home-action-title';
    title.textContent = label;
    const subtitle = document.createElement('span');
    subtitle.className = 'home-action-description';
    subtitle.textContent = description;
    button.append(title, subtitle);
    button.addEventListener('click', action);
    return button;
  }

  private async loadRecentDocuments(): Promise<RecentDocument[]> {
    if (!this.bridge.listRecentDocuments) return [];
    try {
      return await this.bridge.listRecentDocuments();
    } catch (error) {
      console.warn('[home-screen] recent document load failed:', error);
      return [];
    }
  }

  private renderRecentDocuments(documents: RecentDocument[]): void {
    this.recentDocuments = documents;
    const totalPages = this.totalPages();
    this.currentPage = totalPages === 0 ? 0 : Math.min(this.currentPage, totalPages - 1);
    this.recentTrack.replaceChildren();
    if (documents.length === 0) {
      this.recentSection.classList.add('is-empty');
      this.recentHint.textContent = '아직 최근 문서가 없습니다. 문서를 한 번 열면 여기에 바로 나타납니다.';
      this.updatePagination();
      return;
    }

    this.recentSection.classList.remove('is-empty');
    this.recentHint.textContent = '앱을 실행하자마자 이어서 작업할 수 있도록 최근에 연 문서를 보여줍니다.';

    const pageStart = this.currentPage * RECENT_DOCUMENTS_PER_PAGE;
    const pageItems = documents.slice(pageStart, pageStart + RECENT_DOCUMENTS_PER_PAGE);
    for (const documentInfo of pageItems) {
      this.recentTrack.appendChild(this.createRecentCard(documentInfo));
    }
    for (let index = pageItems.length; index < RECENT_DOCUMENTS_PER_PAGE; index += 1) {
      this.recentTrack.appendChild(this.createPlaceholderCard());
    }
    this.updatePagination();
  }

  private createRecentCard(documentInfo: RecentDocument): HTMLButtonElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'home-recent-card';
    const meta = document.createElement('div');
    meta.className = 'home-recent-meta';
    const fileName = document.createElement('div');
    fileName.className = 'home-recent-name';
    fileName.textContent = documentInfo.fileName;

    const filePath = document.createElement('div');
    filePath.className = 'home-recent-path';
    filePath.textContent = documentInfo.path;

    meta.append(fileName, filePath);

    const preview = document.createElement('div');
    preview.className = 'home-recent-preview';
    preview.append(
      this.createPreviewLine('home-preview-line is-wide'),
      this.createPreviewLine('home-preview-line'),
      this.createPreviewLine('home-preview-line is-short'),
      this.createPreviewLine('home-preview-line is-wide'),
      this.createPreviewGrid(),
    );
    void this.loadRecentPreview(preview, documentInfo.path);

    card.append(meta, preview);
    card.addEventListener('click', () => {
      void this.openRecentDocument(documentInfo);
    });
    return card;
  }

  private createPlaceholderCard(): HTMLElement {
    const placeholder = document.createElement('div');
    placeholder.className = 'home-recent-card is-placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    const meta = document.createElement('div');
    meta.className = 'home-recent-meta';
    const preview = document.createElement('div');
    preview.className = 'home-recent-preview';
    placeholder.append(meta, preview);
    return placeholder;
  }

  private async loadRecentPreview(preview: HTMLElement, path: string): Promise<void> {
    if (!this.bridge.renderDocumentPreview) return;

    try {
      const svgMarkup = await this.bridge.renderDocumentPreview(path);
      const svgNode = parsePreviewSvg(svgMarkup);
      if (!svgNode) return;

      preview.replaceChildren(svgNode);
      preview.classList.add('is-loaded');
    } catch (error) {
      console.warn('[home-screen] recent preview render failed:', error);
    }
  }

  private createPreviewLine(className: string): HTMLElement {
    const line = document.createElement('div');
    line.className = className;
    return line;
  }

  private createPreviewGrid(): HTMLElement {
    const grid = document.createElement('div');
    grid.className = 'home-preview-grid';
    for (let index = 0; index < 6; index += 1) {
      const cell = document.createElement('div');
      cell.className = 'home-preview-cell';
      grid.appendChild(cell);
    }
    return grid;
  }

  private async openRecentDocument(documentInfo: RecentDocument): Promise<void> {
    if (!this.bridge.openDocumentByPath) return;

    try {
      this.actions.setMessage('파일 로딩 중...');
      const payload = await this.bridge.openDocumentByPath(documentInfo.path);
      if (payload) this.actions.onDocumentLoaded(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.actions.setMessage(`파일 로드 실패: ${message}`);
      console.error('[home-screen] recent document open failed:', error);
    }
  }

  private changePage(direction: -1 | 1): void {
    const nextPage = this.currentPage + direction;
    if (nextPage < 0 || nextPage >= this.totalPages()) return;
    this.currentPage = nextPage;
    this.renderRecentDocuments(this.recentDocuments);
  }

  private updatePagination(): void {
    const totalPages = this.totalPages();
    const hasPages = totalPages > 1;
    this.recentPagination.hidden = !hasPages;
    this.recentPageLabel.textContent = totalPages === 0 ? '' : `${this.currentPage + 1} / ${totalPages}`;
    this.prevButton.disabled = this.currentPage === 0;
    this.nextButton.disabled = totalPages === 0 || this.currentPage >= totalPages - 1;
  }

  private totalPages(): number {
    return Math.ceil(this.recentDocuments.length / RECENT_DOCUMENTS_PER_PAGE);
  }
}
