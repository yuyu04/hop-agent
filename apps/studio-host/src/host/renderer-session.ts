import { RendererSession } from '@/upstream/view';

/** Compose rhwp's renderer lifecycle with HOP's fixed Canvas2D product policy. */
export function createRendererSession(): RendererSession {
  return new RendererSession(
    { backend: 'canvas2d', source: 'default' },
    { mode: 'default', source: 'default' },
    { preference: 'auto', requested: 'auto' },
    'screen',
    async () => {
      throw new Error('CanvasKit is not enabled by the HOP renderer policy');
    },
  );
}
