import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { adminToken, api } from './helpers';
import { country, db, latestCode, marketplace, order, PDF, phone, PNG, user, type Country } from './world';

const PROVIDER = `http://localhost:${E2E.providerPort}`;
let c: Country;
let m: Awaited<ReturnType<typeof marketplace>>;

test.beforeAll(async () => {
  c = await country();
  m = await marketplace(c);
});

async function dialog(page: Page, button: string | RegExp, fill: (d: ReturnType<Page['locator']>) => Promise<void>) {
  await page.getByRole('button', { name: button }).first().click();
  const d = page.locator('dialog[open]');
  await fill(d);
  await d.locator('button[type="submit"]').click();
  await expect(d).toHaveCount(0);
}

test('a provider signs up, applies with documents, gets approved, lists a service and accepts a booking', async ({ page }) => {
  // Sign-up and phone verification.
  const mobile = phone();
  await page.goto(`${PROVIDER}/register`);
  await page.locator('select[name="countryCode"]').selectOption(c.code);
  await page.locator('input[name="fullName"]').fill('قاعات الفرح');
  await page.locator('input[name="phone"]').fill(mobile);
  await page.locator('input[name="password"]').fill('Passw0rd-123');
  await page.locator('#f-acceptTerms').check();
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/verify/);
  const userId = (await db().query('SELECT id FROM users WHERE phone = $1', [mobile])).rows[0].id;
  await page.locator('input[name="code"]').fill(await latestCode(userId));
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/onboarding/);

  // Application with the required documents.
  await page.locator('input[name="businessName"]').fill('قاعات الفرح الماسية');
  await page.locator('input[name="activityType"]').fill('قاعات أفراح');
  await page.locator('input[name="city"]').fill('Riyadh');
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('.badge').first()).toHaveText('مسودة');
  for (const docType of ['identity', 'commercial_registration']) {
    await dialog(page, 'رفع وثيقة', async (d) => {
      await d.locator('select[name="docType"]').selectOption(docType);
      await d.locator('input[name="file"]').setInputFiles({ name: `${docType}.pdf`, mimeType: 'application/pdf', buffer: PDF });
    });
  }
  await dialog(page, 'إرسال الطلب للمراجعة', async (d) => { await d.locator('#f-acceptTerms').check(); });
  await expect(page.locator('.badge').first()).toHaveText('مُرسل');

  // The administration approves and enables a service type.
  const admin = await adminToken();
  const appId = (await db().query('SELECT id FROM provider_applications WHERE user_id = $1', [userId])).rows[0].id;
  await api('POST', `/v1/admin/provider-applications/${appId}/actions`, { token: admin, body: { action: 'approve' } });
  const providerId = (await db().query('SELECT id FROM providers WHERE user_id = $1', [userId])).rows[0].id;
  await api('PUT', `/v1/admin/providers/${providerId}/service-types`, { token: admin, body: { serviceTypeIds: [m.typeId] } });

  // New service (requires the provider's approval), with a photo, submitted for review.
  await page.goto(`${PROVIDER}/services/new`);
  await page.locator('select[name="serviceTypeId"]').selectOption(m.typeId);
  await page.locator('input[name="title"]').fill('قاعة الياسمين');
  await page.locator('input[name="title.en"]').fill('Jasmine Hall');
  await page.locator('input[name="description"]').fill('قاعة أنيقة تتسع لـ 300 ضيف');
  await page.locator('input[name="city"]').fill('Riyadh');
  await page.locator('input[name="basePrice"]').fill('12000');
  await page.locator('select[name="currency"]').selectOption('SAR');
  await page.locator('#f-requiresProviderApproval').check();
  await page.locator('select[name="depositType"]').selectOption('percent');
  await page.locator('input[name="depositValue"]').fill('20');
  await page.locator('form button[type="submit"]').click();
  await page.waitForURL(/\/services\/[0-9a-f-]{36}$/);
  const serviceId = page.url().split('/').pop()!;
  await page.getByRole('tab', { name: 'الصور والفيديو' }).click();
  await dialog(page, 'رفع صورة أو فيديو', async (d) => { await d.locator('input[name="file"]').setInputFiles({ name: 'hall.png', mimeType: 'image/png', buffer: PNG }); });
  await expect(page.locator(`img[src^="/bff/v1/media/"]`)).toHaveCount(1);
  await dialog(page, 'إرسال للمراجعة والنشر', async () => {});
  await expect(page.locator('.badge').first()).toHaveText('بانتظار المراجعة');
  await api('POST', `/v1/admin/services/${serviceId}/actions`, { token: admin, body: { action: 'publish' } });

  // A package with its own inclusions, add-ons, days and image.
  await page.goto(`${PROVIDER}/services/${serviceId}`);
  await page.getByRole('tab', { name: 'الباقات' }).click();
  await dialog(page, 'باقة جديدة', async (d) => {
    await d.locator('input[name="name"]').fill('الباقة الذهبية');
    await d.locator('input[name="price"]').fill('15000');
    await d.locator('textarea[name="inclusionsAr"]').fill('إضاءة\nضيافة');
    await d.locator('textarea[name="addOns"]').fill('dj | دي جي | DJ | 1500');
    await d.locator('input[name="durationMinutes"]').fill('300');
  });
  const pkg = (await db().query('SELECT id, inclusions, add_ons, duration_minutes FROM packages WHERE service_id = $1', [serviceId])).rows[0];
  expect(pkg.inclusions).toEqual([{ ar: 'إضاءة' }, { ar: 'ضيافة' }]);
  expect(pkg.add_ons).toEqual([{ code: 'dj', name: { ar: 'دي جي', en: 'DJ' }, price: '1500' }]);
  expect(pkg.duration_minutes).toBe(300);
  await page.getByRole('tab', { name: 'الصور والفيديو' }).click();
  await dialog(page, 'رفع صورة أو فيديو', async (d) => {
    await d.locator('select[name="packageId"]').selectOption(pkg.id);
    await d.locator('input[name="file"]').setInputFiles({ name: 'gold.png', mimeType: 'image/png', buffer: PNG });
  });
  await expect(page.locator(`img[src^="/bff/v1/media/"]`)).toHaveCount(2);
  expect((await db().query('SELECT 1 FROM service_media WHERE package_id = $1', [pkg.id])).rowCount).toBe(1);

  // Business profile: the city is edited directly, the business name goes to the administration.
  await page.goto(`${PROVIDER}/profile`);
  await page.locator('input[name="city"]').fill('Jeddah');
  await page.locator('form button[type="submit"]').first().click();
  await expect(page.getByText('تم الحفظ')).toBeVisible();
  expect((await db().query('SELECT city FROM providers WHERE id = $1', [providerId])).rows[0].city).toBe('Jeddah');
  await dialog(page, 'طلب تعديل', async (d) => { await d.locator('input[name="businessName"]').fill('قاعات الفرح الملكية'); });
  await expect(page.getByText('بانتظار المراجعة')).toBeVisible();
  expect((await db().query(`SELECT changes FROM provider_profile_changes WHERE provider_id = $1 AND status = 'pending'`, [providerId])).rows[0].changes).toEqual({ businessName: 'قاعات الفرح الملكية' });

  // A customer books; the provider accepts from the panel.
  const cust = await user(c.code, 'customer');
  const o = await order(cust.token, serviceId);
  const bookingId = o.bookings[0]!.id;
  await page.goto(`${PROVIDER}/`);
  await expect(page.getByText('حجوزات بانتظار موافقتك')).toBeVisible();
  await page.goto(`${PROVIDER}/bookings/${bookingId}`);
  await expect(page.locator('.badge').first()).toHaveText('بانتظار موافقة صاحب الخدمة');
  await dialog(page, 'قبول', async () => {});
  await expect(page.locator('.badge').first()).toHaveText('بانتظار الدفع');

  // External booking recorded in the calendar blocks that slot.
  await page.goto(`${PROVIDER}/calendar`);
  await dialog(page, 'حجز خارجي أو إغلاق', async (d) => {
    await d.locator('select[name="serviceId"]').selectOption(serviceId);
    await d.locator('select[name="kind"]').selectOption('external');
    await d.locator('input[name="start"]').fill('2027-12-20T00:00');
    await d.locator('input[name="end"]').fill('2027-12-21T00:00');
    await d.locator('input[name="reason"]').fill('حجز هاتفي');
  });
  const blocks = await db().query(`SELECT 1 FROM calendar_blocks WHERE service_id = $1 AND kind = 'external'`, [serviceId]);
  expect(blocks.rowCount).toBe(1);
  await expect(page.getByTestId('calendar')).toBeVisible();
  await page.getByRole('tab', { name: 'أسبوع' }).click();
  await expect(page.locator('[data-testid="calendar"][data-mode="week"]')).toBeVisible();
  await page.getByRole('tab', { name: 'يوم' }).click();
  await expect(page.locator('[data-testid="calendar"][data-mode="day"]')).toBeVisible();

  // Every provider screen loads without errors.
  for (const p of ['/', '/notifications', '/help', '/services', '/calendar', '/policies', '/promotions', '/reviews', '/bookings', '/disputes', '/earnings', '/reports', '/documents', '/profile', '/onboarding']) {
    await page.goto(`${PROVIDER}${p}`);
    await expect(page.locator('main h1'), p).toBeVisible();
    await page.waitForLoadState('networkidle');
    await expect(page.locator('.alert-error'), p).toHaveCount(0);
  }
});

test('the provider panel refuses customer accounts', async ({ page }) => {
  const cust = await user(c.code, 'customer');
  await page.goto(`${PROVIDER}/login`);
  await page.locator('input[name="identifier"]').fill(cust.email);
  await page.locator('input[name="password"]').fill('Passw0rd-123');
  await page.locator('form button[type="submit"]').click();
  await expect(page.locator('.alert-error')).toContainText('WRONG_ACCOUNT_TYPE');
});
