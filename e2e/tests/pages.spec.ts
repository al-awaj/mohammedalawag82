import { expect, test } from '@playwright/test';
import { E2E } from '../env';
import { uiLogin } from './helpers';
import { approvedProvider, country, marketplace, publish, submittedService, type Country } from './world';

/** Public provider pages (clause 68) and the help centre written in the admin panel (clause 60), on the website and the app. */
const WEB = `http://localhost:${E2E.webPort}`;
const ADMIN = `http://localhost:${E2E.adminPort}`;
const APP = `http://localhost:${E2E.mobileWebPort}`;
let c: Country;
let serviceId: string;
let providerId: string;

test.beforeAll(async () => {
  c = await country();
  const m = await marketplace(c);
  const prov = await approvedProvider(c);
  providerId = prov.providerId;
  serviceId = await submittedService(prov, m.typeId);
  await publish(serviceId);
});

test('the administration publishes a help article and customers read it on the website', async ({ page, context }) => {
  await uiLogin(page, ADMIN, E2E.admin.email, E2E.admin.password);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`${ADMIN}/help`);
  await page.getByRole('button', { name: 'سؤال جديد' }).click();
  const d = page.locator('dialog[open]');
  await d.locator('#f-countryId').selectOption(c.id);
  await d.locator('#f-audience').selectOption('customer');
  await d.locator('#f-topic').fill('payments');
  await d.locator('input[name="question"]').fill('هل توجد رسوم إضافية على الحجز؟');
  await d.locator('input[name="answer"]').fill('لا، السعر المعروض هو ما تدفعه.');
  await d.locator('#f-isPublished').check();
  await d.getByRole('button', { name: 'تأكيد' }).click();
  await expect(page.getByText('هل توجد رسوم إضافية على الحجز؟')).toBeVisible();

  await context.addCookies([{ name: 'country', value: c.code, url: WEB }]);
  await page.goto(`${WEB}/help`);
  await page.getByText('هل توجد رسوم إضافية على الحجز؟').click();
  await expect(page.getByText('لا، السعر المعروض هو ما تدفعه.')).toBeVisible();
});

test('website: the provider name on a service leads to the public provider page', async ({ page, context }) => {
  await context.addCookies([{ name: 'country', value: c.code, url: WEB }]);
  await page.goto(`${WEB}/services/${serviceId}`);
  await page.getByTestId('provider-link').click();
  await page.waitForURL(`${WEB}/providers/${providerId}`);
  await expect(page.getByTestId('provider-page')).toBeVisible();
  await expect(page.locator(`a[href="/services/${serviceId}"]`).first()).toBeVisible();
});

test('app: provider page from a service, and the help centre from the account tab', async ({ page }) => {
  await page.addInitScript((code) => localStorage.setItem('country', code), c.code);
  await page.goto(`${APP}/service/${serviceId}`);
  await page.getByTestId('open-provider').filter({ visible: true }).click();
  await expect(page.getByTestId('provider-page').filter({ visible: true })).toBeVisible();
  await expect(page.getByTestId(`service-${serviceId}`).filter({ visible: true })).toBeVisible();

  await page.goto(`${APP}/`);
  await page.getByText('حسابي').last().click();
  await page.getByTestId('open-help').filter({ visible: true }).click();
  await page.getByText('هل توجد رسوم إضافية على الحجز؟').filter({ visible: true }).click();
  await expect(page.getByText('لا، السعر المعروض هو ما تدفعه.').filter({ visible: true })).toBeVisible();
});
