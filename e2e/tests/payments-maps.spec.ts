import { expect, test } from '@playwright/test';
import { E2E } from '../env';
import { uiLogin } from './helpers';
import { approvedProvider, country, db, futureDate, marketplace, order, PASSWORD, payByCard, publish, submittedService, user, type Country } from './world';

/** Instalment plans, partial payments (clauses 45-48) and map locations with nearby search. */
const WEB = `http://localhost:${E2E.webPort}`;
const PROVIDER = `http://localhost:${E2E.providerPort}`;
let c: Country;
let serviceId: string;

test.beforeAll(async ({ browser }) => {
  c = await country();
  const m = await marketplace(c);
  const prov = await approvedProvider(c);
  serviceId = await submittedService(prov, m.typeId);
  // The provider sets the map location and an instalment plan in the panel.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await uiLogin(page, PROVIDER, prov.email, PASSWORD);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`${PROVIDER}/services/${serviceId}`);
  await page.locator('#f-location').fill('https://www.google.com/maps/@24.7136,46.6753,15z');
  await expect(page.locator('.geo-input iframe')).toBeVisible();
  await page.locator('#f-instalmentPlan').fill('60 | 90\n40 | 14');
  await page.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByText('تم الحفظ')).toBeVisible();
  await ctx.close();
  await publish(serviceId);
});

test('service page shows the map and nearby search sorts by distance', async ({ browser }) => {
  const s = (await db().query('SELECT latitude::float8 AS lat, longitude::float8 AS lng, instalment_plan FROM services WHERE id = $1', [serviceId])).rows[0];
  expect(s).toMatchObject({ lat: 24.7136, lng: 46.6753 });
  expect(s.instalment_plan).toHaveLength(2);

  const ctx = await browser.newContext({ geolocation: { latitude: 24.70, longitude: 46.68 }, permissions: ['geolocation'] });
  await ctx.addCookies([{ name: 'country', value: c.code, url: WEB }]);
  const page = await ctx.newPage();
  await page.goto(`${WEB}/services/${serviceId}`);
  await expect(page.getByTestId('service-map').locator('iframe')).toBeVisible();
  await expect(page.getByRole('link', { name: 'افتح في الخرائط' })).toHaveAttribute('href', /24\.7136,46\.6753/);

  await page.goto(`${WEB}/search`);
  await page.getByTestId('near-me').click();
  await page.waitForURL(/sort=distance/);
  await expect(page.locator('.svc-meta', { hasText: 'km' }).first()).toBeVisible();
  await ctx.close();
});

test('customer sees the instalment schedule and pays the next instalment', async ({ page, context }) => {
  const cust = await user(c.code, 'customer');
  const o = await order(cust.token, serviceId, futureDate(240));
  await payByCard(cust.token, o.id);
  await context.addCookies([{ name: 'country', value: c.code, url: WEB }]);
  await uiLogin(page, WEB, cust.email, PASSWORD);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));

  await page.goto(`${WEB}/account/bookings/${o.bookings[0]!.id}`);
  await expect(page.getByTestId('instalments').locator('tbody tr')).toHaveCount(3);

  await page.goto(`${WEB}/orders/${o.id}`);
  const box = page.getByTestId('partial-pay').first();
  await expect(box.getByRole('button', { name: /القسط التالي/ })).toBeVisible();
  await box.getByRole('button', { name: /^ادفع/ }).click();
  await expect.poll(async () => (await db().query(`SELECT amount FROM payments WHERE order_id = $1 AND purpose = 'balance'`, [o.id])).rows[0]?.amount).toBe('9000.0000');
});
