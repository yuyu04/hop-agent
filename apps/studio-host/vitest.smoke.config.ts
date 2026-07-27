import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { createHopOverrides } from './hop-overrides';

// Dedicated config for the cladding stage_2.4 smoke probe (src/tools/*.smoke.ts).
// Mirrors vitest.batch.config so the probe resolves WasmBridge + ai-apply exactly as
// the app does; kept out of vitest.config's include so stage_2.1 doesn't run it twice.
const upstreamSrc = resolve(__dirname, '../../third_party/rhwp/rhwp-studio/src');
const hopSrc = resolve(__dirname, 'src');
const rhwpWasmModule = resolve(__dirname, 'vendor/rhwp-core/rhwp.js');

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/tools/*.smoke.ts'],
    // The gate greps stdout for the AC token, so console output must reach stdout
    // verbatim instead of being buffered into the reporter's per-test panel.
    disableConsoleIntercept: true,
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
