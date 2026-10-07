import { afterEach, describe, expect, it, vi } from 'vitest';

const { prepareRhwpInternalClipboardHtml, writeTextHtmlToClipboard } = vi.hoisted(() => ({
  writeTextHtmlToClipboard: vi.fn(),
  prepareRhwpInternalClipboardHtml: vi.fn((_handler, html: string) => `marked:${html}`),
}));

vi.mock('@/upstream/commands', () => ({
  editCommands: [
    { id: 'edit:cut', label: '오려 두기', execute: vi.fn() },
    { id: 'edit:copy', label: '복사하기', execute: vi.fn() },
    { id: 'edit:paste', label: '붙이기', execute: vi.fn() },
    { id: 'edit:find', label: '찾기', execute: vi.fn() },
  ],
}));

vi.mock('@/upstream/clipboard', () => ({
  prepareRhwpInternalClipboardHtml,
  writeTextHtmlToClipboard,
}));

import { editCommands } from './edit';

const bodySelection = {
  start: { sectionIndex: 0, paragraphIndex: 1, charOffset: 2 },
  end: { sectionIndex: 0, paragraphIndex: 3, charOffset: 4 },
};

function command(id: string) {
  return editCommands.find((item) => item.id === id);
}

async function flushClipboardAction(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function textSelectionServices(overrides: Record<string, unknown> = {}) {
  const inputHandler = {
    getSelection: vi.fn(() => bodySelection),
    performDelete: vi.fn(),
  };
  const wasm = {
    copySelection: vi.fn(),
    exportSelectionHtml: vi.fn(() => '<b>selected</b>'),
    getClipboardText: vi.fn(() => 'selected'),
  };
  return {
    services: {
      getContext: () => ({ inPictureObjectSelection: false, inTableObjectSelection: false }),
      getInputHandler: () => inputHandler,
      wasm,
      ...overrides,
    },
    inputHandler,
    wasm,
  };
}

describe('edit command overrides', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('writes a body text selection through the async Clipboard API', async () => {
    writeTextHtmlToClipboard.mockResolvedValue(undefined);
    const { services, wasm } = textSelectionServices();

    command('edit:copy')?.execute(services as never);
    await flushClipboardAction();

    expect(wasm.copySelection).toHaveBeenCalledWith(0, 1, 2, 3, 4);
    expect(prepareRhwpInternalClipboardHtml).toHaveBeenCalledWith(
      expect.anything(),
      '<b>selected</b>',
      'selected',
    );
    expect(writeTextHtmlToClipboard).toHaveBeenCalledWith('selected', 'marked:<b>selected</b>');
  });

  it('keeps plain-text copy available when optional HTML export fails', async () => {
    writeTextHtmlToClipboard.mockResolvedValue(undefined);
    const { services, wasm } = textSelectionServices();
    wasm.exportSelectionHtml.mockImplementation(() => {
      throw new Error('HTML export unavailable');
    });

    command('edit:copy')?.execute(services as never);
    await flushClipboardAction();

    expect(writeTextHtmlToClipboard).toHaveBeenCalledWith('selected', 'marked:');
  });

  it('uses the cell clipboard APIs for a table-cell text selection', async () => {
    writeTextHtmlToClipboard.mockResolvedValue(undefined);
    const cellSelection = {
      start: {
        sectionIndex: 0,
        paragraphIndex: 4,
        charOffset: 1,
        parentParaIndex: 4,
        controlIndex: 2,
        cellIndex: 3,
        cellParaIndex: 0,
      },
      end: {
        sectionIndex: 0,
        paragraphIndex: 4,
        charOffset: 5,
        parentParaIndex: 4,
        controlIndex: 2,
        cellIndex: 3,
        cellParaIndex: 1,
      },
    };
    const copySelectionInCell = vi.fn();
    const exportSelectionInCellHtml = vi.fn(() => '<table></table>');
    const services = {
      getContext: () => ({ inPictureObjectSelection: false, inTableObjectSelection: false }),
      getInputHandler: () => ({ getSelection: () => cellSelection }),
      wasm: {
        copySelectionInCell,
        exportSelectionInCellHtml,
        getClipboardText: () => 'cell text',
      },
    };

    command('edit:copy')?.execute(services as never);
    await flushClipboardAction();

    expect(copySelectionInCell).toHaveBeenCalledWith(0, 4, 2, 3, 0, 1, 1, 5);
    expect(exportSelectionInCellHtml).toHaveBeenCalledWith(0, 4, 2, 3, 0, 1, 1, 5);
    expect(writeTextHtmlToClipboard).toHaveBeenCalledWith('cell text', 'marked:<table></table>');
  });

  it('deletes a cut selection only after clipboard writing succeeds', async () => {
    writeTextHtmlToClipboard.mockResolvedValue(undefined);
    const { services, inputHandler } = textSelectionServices();

    command('edit:cut')?.execute(services as never);
    expect(inputHandler.performDelete).not.toHaveBeenCalled();
    await flushClipboardAction();

    expect(inputHandler.performDelete).toHaveBeenCalledOnce();
  });

  it('keeps the selection when clipboard writing fails', async () => {
    const error = new Error('clipboard denied');
    writeTextHtmlToClipboard.mockRejectedValue(error);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { services, inputHandler } = textSelectionServices();

    command('edit:cut')?.execute(services as never);
    await flushClipboardAction();

    expect(inputHandler.performDelete).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith('[edit:cut] 오려 두기 실패:', error);
  });

  it('does not delete a different selection after an asynchronous cut', async () => {
    let finishWrite: (() => void) | undefined;
    writeTextHtmlToClipboard.mockImplementation(() => new Promise<void>((resolve) => {
      finishWrite = resolve;
    }));
    const { services, inputHandler } = textSelectionServices();

    command('edit:cut')?.execute(services as never);
    inputHandler.getSelection.mockReturnValue({
      start: { sectionIndex: 0, paragraphIndex: 5, charOffset: 0 },
      end: { sectionIndex: 0, paragraphIndex: 5, charOffset: 3 },
    });
    finishWrite?.();
    await flushClipboardAction();

    expect(inputHandler.performDelete).not.toHaveBeenCalled();
  });

  it('delegates object copy and cut to the upstream input handler paths', () => {
    const performCopy = vi.fn();
    const performCut = vi.fn();
    const services = {
      getContext: () => ({ inPictureObjectSelection: true, inTableObjectSelection: false }),
      getInputHandler: () => ({ performCopy, performCut }),
    };

    command('edit:copy')?.execute(services as never);
    command('edit:cut')?.execute(services as never);

    expect(performCopy).toHaveBeenCalledOnce();
    expect(performCut).toHaveBeenCalledOnce();
    expect(writeTextHtmlToClipboard).not.toHaveBeenCalled();
  });

  it('routes paste through the input handler instead of document.execCommand', () => {
    const performPaste = vi.fn();

    command('edit:paste')?.execute({ getInputHandler: () => ({ performPaste }) } as never);

    expect(performPaste).toHaveBeenCalledOnce();
  });

  it('handles asynchronous paste failures', async () => {
    const error = new Error('clipboard denied');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    command('edit:paste')?.execute({
      getInputHandler: () => ({ performPaste: vi.fn().mockRejectedValue(error) }),
    } as never);
    await flushClipboardAction();

    expect(warning).toHaveBeenCalledWith('[edit:paste] 붙이기 실패:', error);
  });

  it('keeps unrelated upstream edit commands available', () => {
    expect(editCommands.some((item) => item.id === 'edit:find')).toBe(true);
  });
});
