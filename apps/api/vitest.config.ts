import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      // The agent loop, the tools and the platform primitives are the parts a
      // reviewer will actually read; they are the parts held to a threshold.
      include: ['src/agent/**', 'src/tools/**', 'src/platform/**'],
      thresholds: { lines: 80 },
    },
  },
});
