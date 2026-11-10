import path from 'node:path';
import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// Reuse the workspace's existing DOM renderer and React deduplication for
// mobile component tests; native playback itself remains covered separately.
const require = createRequire(import.meta.url);
export default defineConfig({
  ...base,
  resolve: {
    ...base.resolve,
    alias: {
      '@': path.resolve(import.meta.dirname, '../frame-faith-mobile'),
      '@testing-library/react': require.resolve('@testing-library/react'),
      'vitest': path.join(path.dirname(require.resolve('vitest/package.json')), 'dist/index.js'),
    },
  },
  test: {
    ...base.test,
    include: ['../frame-faith-mobile/test/**/*.test.tsx'],
    setupFiles: ['test/setup.ts'],
  },
});
