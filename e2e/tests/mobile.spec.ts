import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { E2E, apiUrl } from '../env';
import { approvedProvider, country, db, marketplace, publish, submittedService, user, type Country } from './world';

/**
 * The customer mobile app's screens, run through its web build (react-native-web). This exercises the
 * app's real navigation, state and API calls; device-specific behaviour (secure storage, native
 * browser, RTL restart) is covered in Phase 11 device testing.
 */
const APP = `http://localhost:${E2E.mobileWebPort}`;
let c: Country;
let serviceId: string;

test.beforeAll(async () => {
  c = await country();
  const m = await marketplace(c);
  const prov = await approvedProvider(c);
  serviceId = await submittedService(prov, m.typeId);
  await publish(serviceId);
});

test('a customer books and pays from the mobile app, then cancels', async ({ page }) => {
  const cust = await user(c.code, 'customer');
  await page.addInitScript((code) => localStorage.setItem('country', code), c.code);
  await page.goto(`${APP}/`);
  await expect(page.getByText('كل ما تحتاجه لمناسبتك في مكان واحد')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  // Sign in.
  await page.getByText('حسابي').last().click();
  await page.getByTestId('account-login').click();
  await page.getByTestId('identifier').fill(cust.email);
  await page.getByTestId('password').fill('Passw0rd-123');
  await page.getByTestId('login-submit').click();
  await expect(page.getByText('عميل اختبار')).toBeVisible();

  // Navigate inside the app (a reload would drop the in-memory session of the web build).
  await page.getByText('الرئيسية').last().click();
  await page.getByTestId(`service-${serviceId}`).click();
  // Two months ahead so the policy's full-refund tier applies.
  await expect(page.getByText('سياسة الإلغاء')).toBeVisible();
  await page.getByTestId('next-days').click();
  await page.getByTestId('next-days').click();
  await page.locator('[data-testid^="day-"]:not([aria-disabled="true"])').first().click();
  await expect(page.getByTestId('quote')).toContainText('5,000.00 SAR');
  await page.getByTestId('add-to-cart').click();

  // Checkout.
  await expect(page.getByTestId('checkout')).toBeVisible();
  await page.getByTestId('accept-terms').click();
  await page.getByTestId('checkout').click();
  await expect(page.getByText('بانتظار الدفع').first()).toBeVisible();

  // Card payment: the app opens the gateway page; the gateway's signed notification completes it.
  const popup = page.waitForEvent('popup').catch(() => null);
  await page.getByTestId('pay-card').click();
  await (await popup)?.close();
  const pay = (await db().query(`SELECT external_ref, integration_id FROM payments WHERE customer_id = $1`, [cust.userId])).rows[0];
  const raw = JSON.stringify({ id: `evt_m_${Date.now()}`, type: 'payment.succeeded', data: { reference: pay.external_ref, amount: '5000.0000', currency: 'SAR' } });
  const sig = createHmac('sha256', E2E.sandboxSecret).update(raw).digest('hex');
  expect((await fetch(`${apiUrl}/v1/webhooks/payments/${pay.integration_id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sandbox-signature': sig }, body: raw })).status).toBe(200);
  await expect(page.getByText('مؤكد').first()).toBeVisible({ timeout: 20_000 });

  // Back to the tabs through the app's own navigation (order → service → tabs).
  await page.getByRole('link', { name: /back/ }).first().click();
  await page.getByRole('link', { name: /back/ }).first().click();

  // Documents list shows the invoice.
  await page.getByText('حسابي').last().click();
  await page.getByText('الفواتير والإيصالات').click();
  await expect(page.locator('[data-testid^="doc-INV-"]')).toBeVisible();

  // Cancel from the bookings tab, with the policy outcome shown first.
  const bookingId = (await db().query(`SELECT id FROM bookings WHERE customer_id = $1`, [cust.userId])).rows[0].id;
  await expect(page.getByRole('link', { name: /مناسبات/ })).toBeVisible();
  await page.getByRole('link', { name: /back/ }).first().click();
  await page.getByText('حجوزاتي').last().click();
  await page.getByText('السابقة').click();
  await page.getByText('القادمة').click();
  await page.getByTestId(`booking-${bookingId}`).click();
  await page.getByTestId('cancel-booking').click();
  await expect(page.getByTestId('cancel-panel')).toContainText('سيُسترد 5,000.00 SAR');
  await page.getByTestId('cancel-reason').fill('تغير الموعد');
  await page.getByTestId('confirm-cancel').click();
  await expect(page.getByText('ألغاه العميل').filter({ visible: true }).first()).toBeVisible();
  await expect(page.locator('[data-testid^="refund-"]').filter({ visible: true })).toBeVisible();
});
