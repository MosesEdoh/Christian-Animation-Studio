import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Separate from Vite's preview config: tests need neither PORT nor BASE_PATH.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
    dedupe: ['react', 'react-dom', '@tanstack/react-query'],
  },
  test: {
    environment: 'jsdom',
    // Generated hooks live in a workspace package with its own React peer.
    // Transform React Query so Vite's dedupe also applies to its React import.
    server: { deps: { inline: ['@tanstack/react-query'] } },
    include: ['test/**/*.test.tsx'],
    setupFiles: ['test/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
