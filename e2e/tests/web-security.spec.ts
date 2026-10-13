import { expect, test } from '@playwright/test';
import { E2E } from '../env';

/** Browser-facing security of the three web apps: headers, the BFF's CSRF guard and blocked routes (test 34). */
const APPS = [
  { name: 'admin', url: `http://localhost:${E2E.adminPort}` },
  { name: 'provider', url: `http://localhost:${E2E.providerPort}` },
  { name: 'web', url: `http://localhost:${E2E.webPort}` },
];

for (const app of APPS) {
  test.describe(`${app.name}: browser security`, () => {
    test('sends security headers and no framework banner', async ({ request }) => {
      const r = await request.get(`${app.url}/login`);
      const h = r.headers();
      expect(h['x-content-type-options']).toBe('nosniff');
      expect(h['x-frame-options']).toMatch(/DENY|SAMEORIGIN/);
      expect(h['content-security-policy']).toContain("object-src 'none'");
      expect(h['content-security-policy']).toContain('frame-ancestors');
      expect(h['x-powered-by']).toBeUndefined();
    });

    test('rejects state-changing proxy calls without the CSRF header or from another origin', async ({ request }) => {
      const noHeader = await request.post(`${app.url}/bff/session/login`, { data: { email: 'a@b.c', password: 'x' } });
      expect(noHeader.status()).toBe(403);
      const crossSite = await request.post(`${app.url}/bff/session/login`, { data: { email: 'a@b.c', password: 'x' }, headers: { 'x-csrf': '1', origin: 'https://evil.example' } });
      expect(crossSite.status()).toBe(403);
    });

    test('never proxies webhooks or raw token endpoints', async ({ request }) => {
      for (const path of ['/bff/v1/webhooks/payments/00000000-0000-0000-0000-000000000000', '/bff/v1/auth/login', '/bff/v1/auth/refresh']) {
        const r = await request.post(`${app.url}${path}`, { data: {}, headers: { 'x-csrf': '1' } });
        expect([403, 404], path).toContain(r.status());
      }
    });
  });
}
