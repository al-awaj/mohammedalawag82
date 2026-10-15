import { expect, test } from '@playwright/test';
import { E2E } from '../env';
import { adminToken, api, uiLogin } from './helpers';
import { approvedProvider, country, db, PASSWORD, type Country } from './world';

/** Service engine: the admin imports the starter catalog, a provider uploads a document the type requires. */
const ADMIN = `http://localhost:${E2E.adminPort}`;
const PROVIDER = `http://localhost:${E2E.providerPort}`;
let c: Country;
test.beforeAll(async () => { c = await country(); });

test('admin imports the starter catalog and a provider uploads a required document', async ({ page, browser }) => {
  await uiLogin(page, ADMIN, E2E.admin.email, E2E.admin.password);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`${ADMIN}/catalog`);
  await page.getByRole('button', { name: /استيراد الكتالوج الجاهز/ }).click();
  const d = page.locator('dialog[open]');
  await expect(d.getByText('قاعة أفراح')).toBeVisible();
  await d.locator('#f-countryIds label', { hasText: `(${c.code})` }).locator('input').check();
  await d.locator('button[type="submit"]').click();
  await expect(d).toHaveCount(0);
  await expect(page.getByRole('cell', { name: 'القاعات والمواقع' })).toBeVisible();
  await expect(page.getByRole('button', { name: /استيراد الكتالوج الجاهز/ })).toHaveCount(0);

  // A provider granted the hall type sees the documents it requires and uploads one.
  const typeId = (await db().query(`SELECT id FROM service_types WHERE code = 'wedding_hall'`)).rows[0].id as string;
  const prov = await approvedProvider(c);
  const admin = await adminToken();
  await api('PUT', `/v1/admin/providers/${prov.providerId}/service-types`, { token: admin, body: { serviceTypeIds: [typeId] } });
  const s = await api<{ id: string }>('POST', '/v1/provider/services', { token: prov.token, body: {
    serviceTypeId: typeId, title: { ar: 'قاعة اللؤلؤة' }, description: { ar: 'قاعة' }, city: 'Riyadh', currency: 'SAR', basePrice: '15000', pricingUnit: 'fixed', capacity: 400,
    attributes: { sections: 'men_women' } } });
  const p = await (await browser.newContext()).newPage();
  await uiLogin(p, PROVIDER, prov.email, PASSWORD);
  await p.waitForURL((u) => !u.pathname.startsWith('/login'));
  await p.goto(`${PROVIDER}/services/${s.id}`);
  await p.getByRole('tab', { name: 'الوثائق المطلوبة' }).click();
  await expect(p.getByText('تصريح الدفاع المدني')).toBeVisible();
  await p.getByRole('row', { name: /السجل أو الترخيص التجاري/ }).getByRole('button', { name: 'رفع' }).click();
  const pd = p.locator('dialog[open]');
  await pd.locator('#f-file').setInputFiles({ name: 'licence.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF') });
  await pd.locator('button[type="submit"]').click();
  await expect(p.getByTestId('doc-commercial_license')).toBeVisible();
});
