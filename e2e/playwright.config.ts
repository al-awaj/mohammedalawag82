import { defineConfig } from '@playwright/test';
import { E2E, apiUrl } from './env';

const apiEnv = {
  NODE_ENV: 'test', PORT: String(E2E.apiPort), HOST: '127.0.0.1', DATABASE_URL: E2E.databaseUrl, JWT_SECRET: E2E.jwtSecret,
  STORAGE_DIR: './.e2e-storage', RATE_LIMIT_ENABLED: 'false', [E2E.sandboxSecretRef]: E2E.sandboxSecret,
};
const web = (dir: string, port: number) => ({
  command: `npx next start -p ${port}`, cwd: `../apps/${dir}`, port, reuseExistingServer: false, timeout: 60_000,
  env: { API_URL: apiUrl, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
});

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    launchOptions: { executablePath: process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium' },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    { command: 'node --import tsx src/server.ts', cwd: '../apps/api', port: E2E.apiPort, reuseExistingServer: false, timeout: 60_000, env: apiEnv },
    web('admin', E2E.adminPort),
    web('provider', E2E.providerPort),
  ],
});
