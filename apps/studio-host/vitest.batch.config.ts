import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { createHopOverrides } from './hop-overrides';

// Dedicated config for the headless docx→hwp batch converter (src/tools/*.batch.ts).
// Mirrors vite.config aliases so WasmBridge + ai-apply resolve exactly as the app does,
// and additionally wires @wasm/rhwp.js to the vendored WASM glue (vitest.config omits it).
const upstreamSrc = resolve(__dirname, '../../third_party/rhwp/rhwp-studio/src');
const hopSrc = resolve(__dirname, 'src');
const rhwpWasmModule = resolve(__dirname, 'vendor/rhwp-core/rhwp.js');

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/tools/docx-batch-convert.batch.ts'],
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
  },
  resolve: {
    alias: [
      ...createHopOverrides(hopSrc),
      { find: '@wasm/rhwp.js', replacement: rhwpWasmModule },
      { find: '@upstream', replacement: upstreamSrc },
      { find: '@', replacement: upstreamSrc },
    ],
  },
});
