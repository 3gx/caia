import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ['tests/setup-opencode.ts'],
    include: [
      'tests/unit/opencode/**/*.test.ts',
      'tests/integration/opencode/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      include: ['opencode/src/**/*.ts'],
      exclude: ['opencode/src/index.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
