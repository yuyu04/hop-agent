import { afterEach, describe, expect, it, vi } from 'vitest';

const { writeUpstreamTextHtmlToClipboard } = vi.hoisted(() => ({
  writeUpstreamTextHtmlToClipboard: vi.fn(),
}));

vi.mock('@upstream/engine/input-handler-keyboard', () => ({
  prepareRhwpInternalClipboardHtml: vi.fn(),
  writeTextHtmlToClipboard: writeUpstreamTextHtmlToClipboard,
}));

import { writeTextHtmlToClipboard } from './clipboard';

describe('writeTextHtmlToClipboard', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves the upstream rich clipboard write when it succeeds', async () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    writeUpstreamTextHtmlToClipboard.mockResolvedValue(undefined);

    await writeTextHtmlToClipboard('plain', '<b>rich</b>');

    expect(writeUpstreamTextHtmlToClipboard).toHaveBeenCalledWith('plain', '<b>rich</b>');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to plain text when a WebView rejects the rich clipboard write', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    writeUpstreamTextHtmlToClipboard.mockRejectedValue(new Error('rich clipboard unsupported'));

    await writeTextHtmlToClipboard('plain', '<b>rich</b>');

    expect(writeText).toHaveBeenCalledWith('plain');
  });

  it('preserves the original error when plain-text clipboard writes are unavailable', async () => {
    const error = new Error('clipboard denied');
    vi.stubGlobal('navigator', { clipboard: {} });
    writeUpstreamTextHtmlToClipboard.mockRejectedValue(error);

    await expect(writeTextHtmlToClipboard('plain', '<b>rich</b>')).rejects.toBe(error);
  });

  it('reports a failed plain-text fallback to keep cut operations non-destructive', async () => {
    const fallbackError = new Error('plain clipboard denied');
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(fallbackError) },
    });
    writeUpstreamTextHtmlToClipboard.mockRejectedValue(new Error('rich clipboard unsupported'));

    await expect(writeTextHtmlToClipboard('plain', '<b>rich</b>')).rejects.toBe(fallbackError);
  });
});
