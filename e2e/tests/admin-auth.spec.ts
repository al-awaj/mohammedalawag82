import { expect, test } from '@playwright/test';
import { E2E } from '../env';
import { uiLogin } from './helpers';

const ADMIN = `http://localhost:${E2E.adminPort}`;

test.describe('admin panel: sign-in', () => {
  test('rejects a wrong password with the server message and keeps no session', async ({ page }) => {
    await uiLogin(page, ADMIN, E2E.admin.email, 'wrong-password-1');
    await expect(page.locator('.alert-error')).toContainText('AUTH_INVALID_CREDENTIALS');
    await page.goto(`${ADMIN}/`);
    await expect(page).toHaveURL(/\/login/);
  });

  test('signs in, shows the dashboard in Arabic (RTL), switches to English and signs out', async ({ page, context }) => {
    await uiLogin(page, ADMIN, E2E.admin.email, E2E.admin.password);
    await expect(page.getByRole('heading', { name: 'لوحة المتابعة' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    // Tokens are only in httpOnly cookies scoped to the proxy.
    const cookies = await context.cookies();
    const at = cookies.find((c) => c.name === 'adm_at');
    expect(at?.httpOnly).toBe(true);
    expect(at?.path).toBe('/bff');
    expect(await page.evaluate(() => document.cookie)).not.toContain('adm_');

    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto(`${ADMIN}/applications`);
    await expect(page).toHaveURL(/\/login\?next=%2Fapplications/);
  });
});
