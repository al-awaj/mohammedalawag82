import { expect, test } from '@playwright/test';
import { E2E } from '../env';
import { api, uiLogin } from './helpers';
import { approvedProvider, country, db, marketplace, order, payByCard, publish, submittedService, user, type Country } from './world';

/** Organising an occasion end to end (clauses 24-25) on the website, the admin panel and the mobile app. */
const WEB = `http://localhost:${E2E.webPort}`;
const ADMIN = `http://localhost:${E2E.adminPort}`;
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

test('website: create an event with a budget, link an existing booking and a cart item, follow the budget', async ({ page, context }) => {
  const cust = await user(c.code, 'customer');
  const o = await order(cust.token, serviceId);
  await payByCard(cust.token, o.id);
  await context.addCookies([{ name: 'country', value: c.code, url: WEB }]);
  await uiLogin(page, WEB, cust.email, 'Passw0rd-123');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));

  // Create the event with all its details.
  await page.goto(`${WEB}/account/events`);
  await page.getByRole('button', { name: 'مناسبة جديدة' }).click();
  await page.locator('#f-name').fill('زفاف سارة');
  await page.locator('#f-eventType').selectOption('wedding');
  await page.locator('#f-city').fill('الرياض');
  await page.locator('#f-location').fill('قاعة الماسة');
  await page.locator('#f-eventDate').fill('2028-03-01');
  await page.locator('#f-expectedGuests').fill('250');
  await page.locator('#f-budgetAmount').fill('15000');
  await page.getByRole('button', { name: 'تأكيد' }).click();
  await expect(page.locator('h1')).toContainText('زفاف سارة');
  await expect(page.getByText('لم تُحدَّد ميزانية')).toHaveCount(0);

  // Link the paid booking from the event page: the 20,000 booking exceeds the 15,000 budget.
  await page.getByRole('button', { name: 'إضافة حجز للمناسبة' }).click();
  await page.locator('#f-bookingId').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'تأكيد' }).click();
  await expect(page.getByText('تجاوزت الحجوزات ميزانية المناسبة.')).toBeVisible();
  await expect(page.getByRole('progressbar')).toBeVisible();

  // A cart item is linked from the cart.
  await api('POST', '/v1/cart/items', { token: cust.token, body: { serviceId, date: '2028-04-02' } });
  await page.goto(`${WEB}/cart`);
  const picker = page.locator('[data-testid^="cart-event-"]');
  await picker.selectOption({ index: 1 });
  await expect.poll(async () => (await db().query('SELECT event_id FROM cart_items WHERE customer_id = $1', [cust.userId])).rows[0]?.event_id ?? null).not.toBeNull();

  // Removing the booking from the event leaves the booking itself unchanged.
  await page.goto(`${WEB}/account/events`);
  await page.getByRole('link', { name: 'زفاف سارة' }).click();
  await page.getByRole('button', { name: 'إزالة من المناسبة' }).click();
  await expect(page.getByText('لا توجد خدمات مرتبطة بعد')).toBeVisible();
  expect((await db().query('SELECT status FROM bookings WHERE id = $1', [o.bookings[0]!.id])).rows[0].status).toBe('confirmed');
});

test('admin panel: staff see customers\' events and their bookings', async ({ page }) => {
  const cust = await user(c.code, 'customer');
  const ev = await api('POST', '/v1/events', { token: cust.token, body: { name: 'حفل تخرج نورة', eventType: 'graduation', countryCode: c.code, city: 'جدة', eventDate: '2028-05-10' } });
  const o = await order(cust.token, serviceId);
  await api('PUT', `/v1/bookings/${o.bookings[0]!.id}/event`, { token: cust.token, body: { eventId: ev.id } });
  const number = (await db().query('SELECT number FROM bookings WHERE id = $1', [o.bookings[0]!.id])).rows[0].number as string;
  await uiLogin(page, ADMIN, E2E.admin.email, E2E.admin.password);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`${ADMIN}/events`);
  await page.getByRole('link', { name: 'حفل تخرج نورة' }).click();
  await expect(page.locator('h1')).toContainText('حفل تخرج نورة');
  await expect(page.getByText(number).first()).toBeVisible();
});

test('mobile app: events, documents, profile, search filters and support', async ({ page }) => {
  const cust = await user(c.code, 'customer');
  const o = await order(cust.token, serviceId);
  await payByCard(cust.token, o.id);
  const bookingNumber = (await db().query('SELECT number FROM bookings WHERE id = $1', [o.bookings[0]!.id])).rows[0].number as string;
  await page.addInitScript((code) => localStorage.setItem('country', code), c.code);
  await page.goto(`${APP}/`);
  await page.getByText('حسابي').last().click();
  await page.getByTestId('account-login').click();
  await page.getByTestId('identifier').fill(cust.email);
  await page.getByTestId('password').fill('Passw0rd-123');
  await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('open-events')).toBeVisible();

  // Create an event and link the booking to it.
  await page.getByTestId('open-events').click();
  await page.getByTestId('new-event').click();
  await page.getByTestId('event-name').fill('عشاء العائلة');
  await page.getByTestId('event-type-family').click();
  await page.getByTestId('event-city').fill('الرياض');
  await page.getByTestId('event-date').fill('2028-06-01');
  await page.getByTestId('event-budget').fill('50000');
  await page.getByTestId('save-event').click();
  await expect(page.getByTestId('event-budget-card').filter({ visible: true })).toContainText('50,000.00');
  await page.getByTestId(`link-${bookingNumber}`).filter({ visible: true }).click();
  await expect(page.getByTestId(`event-booking-${bookingNumber}`).filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId('event-budget-card').filter({ visible: true })).toContainText('30,000.00');
  await page.getByRole('link', { name: /back/ }).filter({ visible: true }).first().click();
  await page.getByRole('link', { name: /back/ }).filter({ visible: true }).first().click();

  // Open the invoice inside the app.
  await page.getByText('الفواتير والإيصالات').filter({ visible: true }).click();
  await page.locator('[data-testid^="doc-INV-"]').filter({ visible: true }).first().click();
  await expect(page.getByTestId('document-view').filter({ visible: true })).toBeVisible();
  await expect(page.frameLocator('iframe[title="document"]').getByText(bookingNumber).first()).toBeVisible();
  await page.getByRole('link', { name: /back/ }).filter({ visible: true }).first().click();
  await page.getByRole('link', { name: /back/ }).filter({ visible: true }).first().click();

  // Contact support: a complaint to the administration, then a reply.
  await page.getByTestId('contact-support').filter({ visible: true }).click();
  await page.getByTestId('complaint-subject').filter({ visible: true }).fill('استفسار عن الفاتورة');
  await page.getByTestId('complaint-description').filter({ visible: true }).fill('أرجو توضيح بنود الفاتورة الأخيرة.');
  await page.getByTestId('send-complaint').filter({ visible: true }).click();
  await expect(page.getByText('استفسار عن الفاتورة').filter({ visible: true }).first()).toBeVisible();
  await page.getByTestId('dispute-note').filter({ visible: true }).fill('رقم الحجز مذكور في الفاتورة.');
  await page.getByTestId('send-note').filter({ visible: true }).click();
  await expect(page.getByText('رقم الحجز مذكور في الفاتورة.').filter({ visible: true }).first()).toBeVisible();
  expect((await db().query(`SELECT count(*)::int AS n FROM disputes WHERE complainant_id = $1 AND kind = 'complaint'`, [cust.userId])).rows[0].n).toBe(1);

  // Profile: change the name.
  for (let i = 0; i < 2; i++) await page.getByRole('link', { name: /back/ }).filter({ visible: true }).first().click();
  await page.getByText('الملف الشخصي وكلمة المرور').filter({ visible: true }).click();
  await page.getByTestId('profile-name').filter({ visible: true }).fill('سارة المعدلة');
  await page.getByTestId('save-profile').filter({ visible: true }).click();
  await expect(page.getByText('حُفظت البيانات.').filter({ visible: true })).toBeVisible();
  await expect.poll(async () => (await db().query('SELECT full_name FROM users WHERE id = $1', [cust.userId])).rows[0].full_name).toBe('سارة المعدلة');
  await page.getByRole('link', { name: /back/ }).filter({ visible: true }).first().click();

  // Search with the extra filters: a price ceiling below the hall's price finds nothing, above it finds the hall.
  await page.getByText('البحث').last().click();
  await page.getByTestId('more-filters').filter({ visible: true }).click();
  await page.getByLabel(/أعلى سعر/).filter({ visible: true }).fill('100');
  await page.getByTestId('apply-search').filter({ visible: true }).click();
  await expect(page.getByText('لا توجد نتائج').filter({ visible: true })).toBeVisible();
  await page.getByLabel(/أعلى سعر/).filter({ visible: true }).fill('50000');
  await page.getByTestId('sort-price_asc').filter({ visible: true }).click();
  await page.getByTestId('apply-search').filter({ visible: true }).click();
  await expect(page.getByTestId(`service-${serviceId}`).filter({ visible: true }).first()).toBeVisible();
});
