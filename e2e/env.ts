/** One isolated stack for browser tests: its own database and ports, never the development data. */
export const E2E = {
  databaseUrl: process.env.E2E_DATABASE_URL ?? 'postgres://app:app@localhost:5432/events_e2e',
  apiPort: 3100,
  adminPort: 3101,
  providerPort: 3102,
  webPort: 3103,
  jwtSecret: 'e2e-secret-that-is-at-least-32-characters-long',
  admin: { email: 'e2e-admin@test.local', password: 'E2e-Admin-12345', name: 'E2E Admin' },
  sandboxSecretRef: 'PAY_SANDBOX_E2E_SECRET',
  sandboxSecret: 'sandbox-secret-for-e2e-tests-0123456',
};
export const apiUrl = `http://localhost:${E2E.apiPort}`;
