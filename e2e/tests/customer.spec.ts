import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { E2E, apiUrl } from '../env';
import { approvedProvider, country, db, latestCode, marketplace, phone, publish, submittedService, type Country } from './world';

const WEB = `http://localhost:${E2E.webPort}`;
let c: Country;
let serviceId: string;

test.beforeAll(async () => {
  c = await country();
  const m = await marketplace(c);
  const prov = await approvedProvider(c);
  serviceId = await submittedService(prov, m.typeId);
  await publish(serviceId);
});

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: 'country', value: c.code, url: WEB }]);
});

test('service pages are rendered on the server for search engines', async ({ request }) => {
  const res = await request.get(`${WEB}/services/${serviceId}`, { headers: { cookie: `country=${c.code}` } });
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('قاعة الماسة');
  expect(html).toContain('20,000.00 SAR');
  expect(html).toContain('<title>');
  expect(html).toContain('dir="rtl"');
  expect((await request.get(`${WEB}/services/00000000-0000-0000-0000-000000000000`)).status()).toBe(404);
});

test('a visitor finds a hall, signs up, books, pays by card, gets the invoice and cancels', async ({ page }) => {
  // Browse and search.
  await page.goto(`${WEB}/`);
  await expect(page.locator('.hero h1')).toContainText('لمناسبتك');
  await page.goto(`${WEB}/search?q=الماسة`);
  await page.locator(`a[href="/services/${serviceId}"]`).first().click();
  await expect(page.locator('h1')).toContainText('قاعة الماسة');

  // Pick the first available day; the price breakdown comes from the API.
  const day = page.locator('.days button:not([disabled])').first();
  await day.click();
  await expect(page.getByText('المطلوب عند الحجز')).toBeVisible();
  await expect(page.getByText('5,000.00 SAR')).toBeVisible();
  await page.getByRole('button', { name: 'أضف إلى السلة' }).click();
  await page.waitForURL(/\/login/);

  // Sign up and verify.
  await page.getByRole('link', { name: 'إنشاء حساب جديد' }).click();
  const mobile = phone();
  await page.locator('select[name="countryCode"]').selectOption(c.code);
  await page.locator('input[name="fullName"]').fill('سارة أحمد');
  await page.locator('input[name="phone"]').fill(mobile);
  await page.locator('input[name="password"]').fill('Passw0rd-123');
  await page.locator('#f-acceptTerms').check();
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/verify/);
  const userId = (await db().query('SELECT id FROM users WHERE phone = $1', [mobile])).rows[0].id;
  await page.locator('input[name="code"]').fill(await latestCode(userId));
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL((u) => u.pathname === '/');

  // Book again now that we are signed in.
  // More than 30 days ahead, so the policy's full-refund tier applies.
  await page.goto(`${WEB}/services/${serviceId}`);
  await page.getByRole('button', { name: '›' }).click();
  await page.getByRole('button', { name: '›' }).click();
  await page.locator('.days button:not([disabled])').first().click();
  await expect(page.getByText('المطلوب عند الحجز')).toBeVisible();
  await page.getByRole('button', { name: 'أضف إلى السلة' }).click();
  await page.waitForURL(/\/cart/);
  await expect(page.getByText('سياسة الإلغاء:')).toBeVisible();
  await page.locator('#accept').check();
  await page.getByRole('button', { name: 'إتمام الطلب' }).last().click();
  await page.waitForURL(/\/orders\//);
  await expect(page.locator('.badge', { hasText: 'بانتظار الدفع' })).toBeVisible();

  // Pay the deposit by card; the payment provider's signed notification completes it.
  const popup = page.waitForEvent('popup').catch(() => null);
  await page.locator('.stat', { hasText: 'بطاقة' }).getByRole('button', { name: 'ادفع بهذه الطريقة' }).click();
  await (await popup)?.close();
  const pay = (await db().query(`SELECT p.id, p.external_ref, p.integration_id, p.amount FROM payments p JOIN users u ON u.id = p.customer_id WHERE u.phone = $1`, [mobile])).rows[0];
  expect(pay.amount).toBe('5000.0000');
  const raw = JSON.stringify({ id: `evt_${Date.now()}`, type: 'payment.succeeded', data: { reference: pay.external_ref, amount: '5000.0000', currency: 'SAR' } });
  const sig = createHmac('sha256', E2E.sandboxSecret).update(raw).digest('hex');
  expect((await fetch(`${apiUrl}/v1/webhooks/payments/${pay.integration_id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sandbox-signature': sig }, body: raw })).status).toBe(200);
  await expect(page.locator('.badge', { hasText: 'مؤكد' })).toBeVisible({ timeout: 15_000 });

  // Invoice and deposit receipt are available to the customer.
  await page.goto(`${WEB}/account/documents`);
  await expect(page.locator('code', { hasText: `INV-${c.code}-` })).toBeVisible();
  await expect(page.locator('code', { hasText: `DEP-${c.code}-` })).toBeVisible();

  // Cancellation shows the policy outcome first, then records the refund request.
  await page.goto(`${WEB}/account/bookings`);
  await page.locator('a[href^="/account/bookings/"]').first().click();
  await expect(page.locator('.badge').first()).toHaveText('مؤكد');
  await page.getByRole('button', { name: 'إلغاء الحجز' }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toContainText('سيُسترد 5,000.00 SAR');
  await dialog.locator('textarea[name="reason"]').fill('تغير موعد الحفل');
  await dialog.locator('button[type="submit"]').click();
  await expect(page.locator('.badge').first()).toHaveText('ألغاه العميل');
  await expect(page.locator('.badge', { hasText: 'مطلوب' })).toBeVisible();

  // Every account screen loads.
  for (const p of ['/account/bookings', '/account/events', '/account/documents', '/account/disputes', '/account/notifications', '/account/profile', '/cart', '/terms']) {
    await page.goto(`${WEB}${p}`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.alert-error'), p).toHaveCount(0);
  }
});
