import { defineConfig } from 'vitest/config';

const maxWorkers = process.env.JOBS ? Number(process.env.JOBS) : 4;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
    include: ['tests/sdk-live/opencode/**/*.test.ts'],
    pool: 'threads',
    maxWorkers,
    fileParallelism: true,
    globalSetup: ['tests/sdk-live/opencode/globalSetup.ts'],
  }
});
