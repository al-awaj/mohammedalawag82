import { defineConfig } from 'vitest/config';

// The global setup (schema reset) runs in this process and reads TEST_DATABASE_URL.
const url = process.env.PERF_DATABASE_URL ?? 'postgres://app:app@localhost:5432/events_perf_test';
process.env.TEST_DATABASE_URL = url;

/** Performance run (test 40): own database, large volume, real HTTP load. `npm run test:perf`. */
export default defineConfig({
  test: {
    include: ['perf/**/*.perf.ts'],
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 900_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: url,
      JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      STORAGE_DIR: './.test-storage',
      RATE_LIMIT_ENABLED: 'false',
    },
  },
});
