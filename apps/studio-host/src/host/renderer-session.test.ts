// 회귀 테스트: 원본 HOP에서 이어받은 데스크톱 앱 셸이 HOP AI에서도 그대로 동작한다 (F-4848212d).
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
