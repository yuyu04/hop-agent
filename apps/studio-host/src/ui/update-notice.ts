// 새 버전 알림(자동 업데이트 확인·설치 안내).
import type { DesktopBridgeApi, DesktopUpdateState } from '@/core/tauri-bridge';

export type UpdateNoticeActions = Partial<
  Pick<DesktopBridgeApi, 'startUpdateInstall' | 'restartToApplyUpdate'>
>;

export class UpdateNotice {
  private readonly actions: UpdateNoticeActions;
  private readonly root: HTMLDivElement;
  private readonly titleEl: HTMLHeadingElement;
  private readonly bodyEl: HTMLParagraphElement;
  private readonly metaEl: HTMLParagraphElement;
  private readonly errorEl: HTMLParagraphElement;
  private readonly actionsEl: HTMLDivElement;
  private state: DesktopUpdateState = { status: 'idle' };
  private dismissedKey: string | null = null;
  private actionPending = false;
  private actionError: string | null = null;

  constructor(actions: UpdateNoticeActions = {}) {
    this.actions = actions;
    this.root = document.createElement('div');
    this.root.className = 'update-notice';
    this.root.hidden = true;

    this.titleEl = document.createElement('h2');
    this.titleEl.className = 'update-notice__title';

    this.bodyEl = document.createElement('p');
    this.bodyEl.className = 'update-notice__body';

    this.metaEl = document.createElement('p');
    this.metaEl.className = 'update-notice__meta';

    this.errorEl = document.createElement('p');
    this.errorEl.className = 'update-notice__error';

    this.actionsEl = document.createElement('div');
    this.actionsEl.className = 'update-notice__actions';

    this.root.append(this.titleEl, this.bodyEl, this.metaEl, this.errorEl, this.actionsEl);
    document.body.appendChild(this.root);
  }

  setState(state: DesktopUpdateState): void {
    this.state = state;
    this.actionPending = false;
    this.actionError = null;
    this.render();
  }

  private render(): void {
    if (this.state.status === 'idle') {
      this.root.hidden = true;
      return;
    }

    const key = this.noticeKey(this.state);
    if (key && key === this.dismissedKey) {
      this.root.hidden = true;
      return;
    }

    this.root.hidden = false;
    this.root.dataset.state = this.state.status;
    this.actionsEl.replaceChildren();

    switch (this.state.status) {
      case 'available':
        this.titleEl.textContent = `새 버전 ${this.state.version} 사용 가능`;
        this.bodyEl.textContent = '원할 때 업데이트하고 다시 시작할 수 있습니다.';
        this.setOptionalText(this.metaEl, '업데이트는 명시적으로 시작할 때만 진행됩니다.');
        this.errorEl.hidden = true;
        this.actionsEl.append(
          this.createActionButton('업데이트', true, () => this.startInstall()),
          this.createActionButton('닫기', false, () => this.dismiss()),
        );
        break;

      case 'downloading':
        this.titleEl.textContent = `버전 ${this.state.version} 준비 중`;
        this.bodyEl.textContent = '업데이트 파일을 내려받고 있습니다.';
        this.setOptionalText(this.metaEl, this.progressText(
          this.state.downloadedBytes,
          this.state.totalBytes ?? null,
        ));
        this.errorEl.hidden = true;
        break;

      case 'ready':
        this.titleEl.textContent = `버전 ${this.state.version} 준비 완료`;
        this.bodyEl.textContent = '다시 시작하면 새 버전이 적용됩니다.';
        this.setOptionalText(this.metaEl, null);
        this.errorEl.hidden = true;
        this.actionsEl.append(
          this.createActionButton('지금 다시 시작', true, () => this.restartToApply()),
          this.createActionButton('나중에', false, () => this.dismiss()),
        );
        break;

      case 'error':
        this.titleEl.textContent = `버전 ${this.state.version} 업데이트 실패`;
        this.bodyEl.textContent = this.state.message;
        this.setOptionalText(this.metaEl, null);
        this.errorEl.hidden = true;
        this.actionsEl.append(
          this.createActionButton('다시 시도', true, () => this.startInstall()),
          this.createActionButton('닫기', false, () => this.dismiss()),
        );
        break;
    }

    if (this.actionError) {
      this.errorEl.hidden = false;
      this.errorEl.textContent = this.actionError;
    } else {
      this.errorEl.hidden = true;
      this.errorEl.textContent = '';
    }
  }

  private createActionButton(
    label: string,
    primary: boolean,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `update-notice__button${primary ? ' update-notice__button--primary' : ''}`;
    button.textContent = label;
    button.disabled = this.actionPending;
    button.addEventListener('click', () => {
      onClick();
    });
    return button;
  }

  private async startInstall(): Promise<void> {
    await this.runAction(this.actions.startUpdateInstall);
  }

  private async restartToApply(): Promise<void> {
    await this.runAction(this.actions.restartToApplyUpdate);
  }

  private async runAction(action: (() => Promise<void>) | undefined): Promise<void> {
    if (!action || this.actionPending) return;
    this.actionPending = true;
    this.actionError = null;
    this.render();

    try {
      await action();
    } catch (error) {
      this.actionPending = false;
      this.actionError = this.errorText(error);
      this.render();
    }
  }

  private dismiss(): void {
    this.dismissedKey = this.noticeKey(this.state);
    this.root.hidden = true;
  }

  private noticeKey(state: DesktopUpdateState): string | null {
    if (state.status === 'idle') return null;
    return `${state.status}:${state.version}`;
  }

  private progressText(downloadedBytes: number, totalBytes: number | null): string {
    if (totalBytes && totalBytes > 0) {
      const percent = Math.max(0, Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)));
      return `${this.formatBytes(downloadedBytes)} / ${this.formatBytes(totalBytes)} (${percent}%)`;
    }
    return `${this.formatBytes(downloadedBytes)} 다운로드됨`;
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${Math.round(bytes / 1024)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  private setOptionalText(element: HTMLElement, text: string | null): void {
    element.textContent = text ?? '';
    element.hidden = !text;
  }

  private errorText(error: unknown): string {
    if (error instanceof Error && error.message) return error.message;
    return String(error);
  }
}
