import { describe, expect, it } from 'vitest';
import { createRendererSession } from './renderer-session';

describe('createRendererSession', () => {
  it('uses the upstream revision protocol with a fixed Canvas2D policy', async () => {
    const session = createRendererSession();
    session.beginDocument('document-a');

    const selection = await session.resolve({
      getCanvasKitDocumentPreflight: () => {
        throw new Error('Canvas2D selection must not request a CanvasKit preflight');
      },
    });

    expect(selection.backend).toBe('canvas2d');
    expect(selection.diagnostics.selectionReason).toBe('defaultCanvas2d');
    expect(selection.diagnostics.documentDigest).toBe('document-a');
  });
});
