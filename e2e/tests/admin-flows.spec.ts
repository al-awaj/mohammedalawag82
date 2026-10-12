import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { api, uiLogin } from './helpers';
import { approvedProvider, country, db, marketplace, order, PDF, publish, submittedApplication, submittedService, uploadFile, user, type Country } from './world';

const ADMIN = `http://localhost:${E2E.adminPort}`;
let c: Country;
let m: Awaited<ReturnType<typeof marketplace>>;

async function signIn(page: Page) {
  await uiLogin(page, ADMIN, E2E.admin.email, E2E.admin.password);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
}
/** Opens the action dialog by its button label, fills fields by name and confirms. */
async function act(page: Page, label: string | RegExp, fill: Record<string, string> = {}) {
  await page.getByRole('button', { name: label }).first().click();
  const dialog = page.locator('dialog[open]');
  for (const [name, value] of Object.entries(fill)) {
    const el = dialog.locator(`[name="${name}"]`);
    if ((await el.evaluate((e) => e.tagName)) === 'SELECT') await el.selectOption(value); else await el.fill(value);
  }
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog).toHaveCount(0);
}

test.beforeAll(async () => {
  c = await country();
  m = await marketplace(c);
});

test('reviews a provider application with its documents and approves it', async ({ page }) => {
  const p = await submittedApplication(c);
  await signIn(page);
  await page.goto(`${ADMIN}/applications`);
  await page.getByRole('link', { name: /قاعات/ }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('قاعات');
  // Documents open through the proxy with the staff session (and are audited by the API).
  const doc = page.getByRole('link', { name: 'file.pdf' }).first();
  const href = await doc.getAttribute('href');
  const res = await page.request.get(`${ADMIN}${href}`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('application/pdf');

  await act(page, 'بدء المراجعة');
  await expect(page.locator('.badge').first()).toHaveText('قيد المراجعة');
  await act(page, 'قبول');
  await expect(page.locator('.badge').first()).toHaveText('مقبول');
  const status = (await db().query('SELECT status FROM provider_applications WHERE id = $1', [p.applicationId])).rows[0].status;
  expect(status).toBe('approved');
});

test('publishes a submitted service and verifies a bank transfer that confirms the booking', async ({ page }) => {
  const prov = await approvedProvider(c);
  const serviceId = await submittedService(prov, m.typeId);
  await signIn(page);
  await page.goto(`${ADMIN}/services/${serviceId}`);
  await act(page, 'اعتماد ونشر');
  await expect(page.locator('.badge').first()).toHaveText('منشورة');

  // Customer pays the deposit by bank transfer with a proof; staff verify the amount that arrived.
  const cust = await user(c.code, 'customer');
  const o = await order(cust.token, serviceId);
  const pay = await api<{ id: string }>('POST', `/v1/orders/${o.id}/payments`, { token: cust.token, body: { model: 'platform', method: 'bank_transfer', purpose: 'upfront', reportedAmount: '5000' }, headers: { 'idempotency-key': randomUUID() } });
  await uploadFile(`/v1/payments/${pay.id}/proofs`, cust.token, PDF);

  await page.goto(`${ADMIN}/payments?status=awaiting_verification`);
  await page.locator(`a[href="/payments/${pay.id}"]`).click();
  await act(page, 'مراجعة الإثبات', { decision: 'approve', verifiedAmount: '5000', note: 'Matched the bank statement' });
  await expect(page.locator('.badge').first()).toHaveText('ناجحة');
  const b = (await db().query('SELECT status FROM bookings WHERE id = $1', [o.bookings[0]!.id])).rows[0].status;
  expect(b).toBe('confirmed');

  // The booking shows paid and remaining amounts, and its invoice was issued.
  await page.goto(`${ADMIN}/bookings/${o.bookings[0]!.id}`);
  await expect(page.getByText('5,000.00 SAR').first()).toBeVisible();
  await expect(page.getByText('15,000.00 SAR').first()).toBeVisible();
  await page.goto(`${ADMIN}/documents`);
  await expect(page.locator('code', { hasText: `INV-${c.code}-` }).first()).toBeVisible();

  // Customer cancels well ahead: the policy refund is requested; staff approve and execute it manually.
  await api('POST', `/v1/bookings/${o.bookings[0]!.id}/cancel`, { token: cust.token, body: { reason: 'Event postponed' } });
  await page.goto(`${ADMIN}/refunds`);
  const refundId = (await db().query('SELECT id FROM refunds WHERE booking_id = $1', [o.bookings[0]!.id])).rows[0].id;
  await page.locator(`a[href="/refunds/${refundId}"]`).click();
  await act(page, 'اعتماد');
  await expect(page.locator('.badge').first()).toHaveText('معتمد');
  await act(page, 'تنفيذ', { externalRef: 'BANK-REFUND-001' });
  await expect(page.locator('.badge').first()).toHaveText('مكتمل');
  const refundNote = (await db().query(`SELECT number FROM documents WHERE kind = 'refund_note' AND source_id = $1`, [refundId])).rows[0];
  expect(refundNote.number).toMatch(new RegExp(`^RFN-${c.code}-`));
});

test('exports a report as CSV with the staff session', async ({ page }) => {
  await signIn(page);
  await page.goto(`${ADMIN}/reports`);
  await page.locator('select').first().selectOption('payments-by-method');
  const href = await page.getByRole('link', { name: 'تصدير CSV' }).getAttribute('href');
  const res = await page.request.get(`${ADMIN}${href}`);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/csv');
  expect((await res.text()).startsWith('﻿countryId,currency,model,method')).toBe(true);
});
