import { expect, test } from '@playwright/test';
import { E2E } from '../env';
import { uiLogin } from './helpers';

const ADMIN = `http://localhost:${E2E.adminPort}`;
const PAGES = [
  '/', '/applications', '/providers', '/services', '/catalog', '/policies', '/bookings', '/calendar', '/cancellation-requests', '/disputes',
  '/reviews', '/payments', '/refunds', '/earnings', '/settlements', '/accounts', '/commissions', '/payment-settings', '/promotions',
  '/reconciliation', '/reports', '/documents', '/notifications', '/users', '/staff', '/reference', '/settings', '/audit',
];

test('every admin screen loads without errors for a system administrator', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await uiLogin(page, ADMIN, E2E.admin.email, E2E.admin.password);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await expect(page.locator('main h1')).toBeVisible();
  for (const p of PAGES) {
    await page.goto(`${ADMIN}${p}`);
    await expect(page.locator('main h1'), p).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.alert-error'), `error on ${p}`).toHaveCount(0);
  }
  // Every report runs.
  await page.goto(`${ADMIN}/reports`);
  const reports = await page.locator('select').first().locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  expect(reports).toHaveLength(15);
  for (const r of reports) {
    await page.locator('select').first().selectOption(r);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.alert-error'), `report ${r}`).toHaveCount(0);
  }
  expect(consoleErrors).toEqual([]);
});
