import { expect, test } from '@playwright/test';
import { E2E } from '../env';
import { adminToken, api, uiLogin } from './helpers';
import { approvedProvider, country, marketplace, publish, submittedService, type Country } from './world';

/** Branding and contacts from the admin panel, display currency on the website, statement file import. */
const ADMIN = `http://localhost:${E2E.adminPort}`;
const WEB = `http://localhost:${E2E.webPort}`;
let c: Country;
let m: Awaited<ReturnType<typeof marketplace>>;
test.beforeAll(async () => {
  c = await country();
  m = await marketplace(c);
  const prov = await approvedProvider(c);
  await publish(await submittedService(prov, m.typeId));
  await api('POST', '/v1/admin/exchange-rates', { token: await adminToken(), body: { base: 'SAR', quote: 'USD', rate: '0.2666', source: 'e2e central bank' } });
});

test('admin sets contacts for a country; the website shows them and approximate prices', async ({ page, browser }) => {
  await uiLogin(page, ADMIN, E2E.admin.email, E2E.admin.password);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`${ADMIN}/branding`);
  await page.locator('#f-scope').selectOption({ label: c.code });
  await page.locator('#f-phone').fill('+966511112222');
  await page.locator('#f-email').fill('care@example.com');
  await page.locator('#f-reason').fill('Customer care line');
  await page.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByText('تم الحفظ')).toBeVisible();

  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: 'country', value: c.code, url: WEB }]);
  const w = await ctx.newPage();
  await w.goto(`${WEB}/`);
  await expect(w.getByTestId('footer-contact')).toContainText('+966511112222');
  await w.getByTestId('display-currency').first().selectOption('USD');
  await expect(w.locator('.approx').first()).toContainText('≈');
  await ctx.close();
});

test('finance imports a CSV statement, previews it and creates the reconciliation', async ({ page }) => {
  await uiLogin(page, ADMIN, E2E.admin.email, E2E.admin.password);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`${ADMIN}/reconciliation`);
  await page.locator('#f-statement').setInputFiles({ name: 'gateway.csv', mimeType: 'text/csv', buffer: Buffer.from('Ref,Amount,Currency\nPAY-UNKNOWN-1,150.00,SAR\n,10,SAR\n') });
  await page.locator('#f-format').selectOption('csv');
  await page.locator('#f-referenceColumn').fill('Ref');
  await page.locator('#f-amountColumn').fill('Amount');
  await page.locator('#f-currencyColumn').fill('Currency');
  await page.getByRole('button', { name: 'قراءة الملف ومعاينته' }).click();
  await expect(page.getByText('أسطر مقروءة: 1 · متجاهلة: 1')).toBeVisible();
  await page.locator('form #f-countryId').selectOption(c.id);
  await page.locator('form #f-accountId').selectOption(m.bankAccount);
  await page.locator('form #f-periodFrom').fill('2027-01-01');
  await page.locator('form #f-periodTo').fill('2027-01-31');
  await page.getByRole('button', { name: 'إنشاء المطابقة' }).click();
  await page.waitForURL(/\/reconciliation\/[0-9a-f-]{36}/);
  await expect(page.getByText('PAY-UNKNOWN-1')).toBeVisible();
});
