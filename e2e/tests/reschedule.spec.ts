import { expect, test } from '@playwright/test';
import { E2E } from '../env';
import { uiLogin } from './helpers';
import { approvedProvider, country, db, futureDate, marketplace, order, PASSWORD, payByCard, publish, submittedService, user, type Country } from './world';

/** Booking date change (clause 26): the customer asks on the website, the provider approves in the panel. */
const WEB = `http://localhost:${E2E.webPort}`;
const PROVIDER = `http://localhost:${E2E.providerPort}`;
let c: Country;
let serviceId: string;
let prov: Awaited<ReturnType<typeof approvedProvider>>;

test.beforeAll(async () => {
  c = await country();
  const m = await marketplace(c);
  prov = await approvedProvider(c);
  serviceId = await submittedService(prov, m.typeId);
  await publish(serviceId);
});

test('customer requests a new date and the provider approves it', async ({ page, context }) => {
  const cust = await user(c.code, 'customer');
  const o = await order(cust.token, serviceId, futureDate(200));
  await payByCard(cust.token, o.id);
  const bookingId = o.bookings[0]!.id;
  const newDay = futureDate(260);

  await context.addCookies([{ name: 'country', value: c.code, url: WEB }]);
  await uiLogin(page, WEB, cust.email, PASSWORD);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`${WEB}/account/bookings/${bookingId}`);
  await page.getByRole('button', { name: 'طلب تغيير الموعد' }).click();
  const d = page.locator('dialog[open]');
  await d.locator('#f-date').fill(newDay);
  await d.locator('#f-reason').fill('تغيّر موعد الحفل');
  await d.getByRole('button', { name: 'تأكيد' }).click();
  await expect(page.getByTestId('reschedule-pending')).toBeVisible();

  const p = await context.browser()!.newContext();
  const pp = await p.newPage();
  await uiLogin(pp, PROVIDER, prov.email, PASSWORD);
  await pp.waitForURL((u) => !u.pathname.startsWith('/login'));
  await expect(pp.getByText('طلبات تغيير موعد بانتظار ردك')).toBeVisible();
  await pp.goto(`${PROVIDER}/bookings/${bookingId}`);
  await pp.getByRole('button', { name: 'موافقة' }).click();
  await pp.locator('dialog[open]').getByRole('button', { name: 'تأكيد' }).click();
  await expect(pp.getByTestId('reschedule-approved')).toBeVisible();

  const row = (await db().query(`SELECT to_char(start_at AT TIME ZONE 'Asia/Riyadh', 'YYYY-MM-DD') AS day FROM bookings WHERE id = $1`, [bookingId])).rows[0];
  expect(row.day).toBe(newDay);
  await page.reload();
  await expect(page.getByTestId('reschedule-approved')).toBeVisible();
});
