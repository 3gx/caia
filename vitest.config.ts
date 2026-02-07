import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 10000,
    hookTimeout: 10000,
    teardownTimeout: 1000,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/sdk-live/**'],
  }
});
