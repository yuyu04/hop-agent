// Keep HOP clipboard commands insulated from rhwp-studio's internal module layout.
import {
  prepareRhwpInternalClipboardHtml,
  writeTextHtmlToClipboard as writeUpstreamTextHtmlToClipboard,
} from '@upstream/engine/input-handler-keyboard';

export { prepareRhwpInternalClipboardHtml };

/**
 * Preserve rich rhwp clipboard data when the WebView supports it, while still
 * allowing copy/cut on WebViews that only permit plain-text clipboard writes.
 */
export async function writeTextHtmlToClipboard(text: string, html: string): Promise<void> {
  try {
    await writeUpstreamTextHtmlToClipboard(text, html);
  } catch (richClipboardError) {
    const clipboard = globalThis.navigator?.clipboard;
    const writeText = clipboard?.writeText;
    if (!writeText) throw richClipboardError;
    await writeText.call(clipboard, text);
  }
}
