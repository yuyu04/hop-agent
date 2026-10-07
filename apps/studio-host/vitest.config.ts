import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { createHopOverrides } from './hop-overrides.ts';

const upstreamSrc = resolve(import.meta.dirname, '../../third_party/rhwp/rhwp-studio/src');
const hopSrc = resolve(import.meta.dirname, 'src');
const rhwpWasmModule = resolve(import.meta.dirname, 'vendor/rhwp-core/rhwp.js');

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
  resolve: {
    alias: [
      ...createHopOverrides(hopSrc),
      { find: '@wasm/rhwp.js', replacement: rhwpWasmModule },
      { find: '@/upstream', replacement: resolve(hopSrc, 'upstream') },
      { find: '@upstream', replacement: upstreamSrc },
      { find: '@', replacement: upstreamSrc },
    ],
  },
});
