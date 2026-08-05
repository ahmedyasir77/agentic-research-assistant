/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_ORIGIN = process.env['VITE_API_ORIGIN'] ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In dev the UI and the API are separate origins; in production Express
    // serves this bundle, so the app only ever talks to relative /api paths.
    proxy: {
      '/api': { target: API_ORIGIN, changeOrigin: true },
      '/healthz': { target: API_ORIGIN, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    coverage: { provider: 'v8', reporter: ['text-summary', 'lcov'] },
  },
});
