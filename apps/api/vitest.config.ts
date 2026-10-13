import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/global-setup.ts'],
    // Test files share one database; run them sequentially.
    fileParallelism: false,
    testTimeout: 20_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://app:app@localhost:5432/events_test',
      JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      STORAGE_DIR: './.test-storage',
      RATE_LIMIT_ENABLED: 'false',
    },
  },
});
