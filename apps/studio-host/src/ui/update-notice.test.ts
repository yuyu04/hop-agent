// 회귀 테스트: 원본 HOP에서 이어받은 데스크톱 앱 셸이 HOP AI에서도 그대로 동작한다 (F-4848212d).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateNotice } from './update-notice';

class FakeElement {
  className = '';
  textContent = '';
  hidden = false;
  disabled = false;
  type = '';
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  private listeners = new Map<string, Array<() => void>>();

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = [...children];
  }

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  click(): void {
    this.listeners.get('click')?.forEach((listener) => {
      listener();
    });
  }
}

class FakeDocument {
  body = new FakeElement();

  createElement(): FakeElement {
    return new FakeElement();
  }
}

function getNoticeRoot(document: FakeDocument): FakeElement {
  const root = document.body.children[0];
  if (!root) throw new Error('missing notice root');
  return root;
}

describe('UpdateNotice', () => {
  let fakeDocument: FakeDocument;

  beforeEach(() => {
    fakeDocument = new FakeDocument();
    (globalThis as { document?: Document }).document = fakeDocument as unknown as Document;
  });

  afterEach(() => {
    delete (globalThis as { document?: Document }).document;
  });

  it('renders available state and starts install when requested', () => {
    const startUpdateInstall = vi.fn().mockResolvedValue(undefined);
    const notice = new UpdateNotice({ startUpdateInstall });

    notice.setState({ status: 'available', version: '0.1.4' });

    const root = getNoticeRoot(fakeDocument);
    const [title, body, meta, error, actions] = root.children;
    const [primaryButton, secondaryButton] = actions.children;

    expect(root.hidden).toBe(false);
    expect(root.dataset.state).toBe('available');
    expect(title.textContent).toBe('새 버전 0.1.4 사용 가능');
    expect(body.textContent).toBe('원할 때 업데이트하고 다시 시작할 수 있습니다.');
    expect(meta.textContent).toBe('업데이트는 명시적으로 시작할 때만 진행됩니다.');
    expect(meta.hidden).toBe(false);
    expect(error.hidden).toBe(true);
    expect(primaryButton.textContent).toBe('업데이트');
    expect(secondaryButton.textContent).toBe('닫기');

    primaryButton.click();

    expect(startUpdateInstall).toHaveBeenCalledTimes(1);
  });

  it('hides the meta row when no supplemental text is needed', () => {
    const notice = new UpdateNotice();

    notice.setState({ status: 'ready', version: '0.1.4' });

    const root = getNoticeRoot(fakeDocument);
    const [, , meta] = root.children;

    expect(meta.textContent).toBe('');
    expect(meta.hidden).toBe(true);
  });

  it('shows action errors inline after a rejected install request', async () => {
    const startUpdateInstall = vi.fn().mockRejectedValue(new Error('dirty documents'));
    const notice = new UpdateNotice({ startUpdateInstall });

    notice.setState({ status: 'available', version: '0.1.4' });

    const root = getNoticeRoot(fakeDocument);
    const [, , , error, actions] = root.children;
    const [primaryButton] = actions.children;

    primaryButton.click();
    await Promise.resolve();

    expect(startUpdateInstall).toHaveBeenCalledTimes(1);
    expect(error.hidden).toBe(false);
    expect(error.textContent).toBe('dirty documents');
  });

  it('keeps a dismissed notice hidden for the same version and state', () => {
    const notice = new UpdateNotice();

    notice.setState({ status: 'available', version: '0.1.4' });

    const root = getNoticeRoot(fakeDocument);
    const [, , , , actions] = root.children;
    const [, dismissButton] = actions.children;

    dismissButton.click();
    expect(root.hidden).toBe(true);

    notice.setState({ status: 'available', version: '0.1.4' });
    expect(root.hidden).toBe(true);

    notice.setState({ status: 'available', version: '0.1.5' });
    expect(root.hidden).toBe(false);
  });
});
