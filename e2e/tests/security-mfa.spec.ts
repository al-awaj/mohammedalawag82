import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { E2E } from '../env';
import { adminToken, api, uiLogin, uniq } from './helpers';
import { PASSWORD } from './world';

/** Two-step sign-in for staff: set up from "My account security", then required at every sign-in. */
const ADMIN = `http://localhost:${E2E.adminPort}`;

function totp(secret: string, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const ch of secret) { value = (value << 5) | alphabet.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = h[h.length - 1]! & 0xf;
  return String((((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!) % 1_000_000).padStart(6, '0');
}

test('a staff member turns on two-step sign-in and then signs in with a code', async ({ page }) => {
  const email = `mfa-${uniq()}@e2e.local`;
  const admin = await adminToken();
  const roles = await api<{ id: string; code: string }[]>('GET', '/v1/admin/roles', { token: admin });
  await api('POST', '/v1/admin/staff', { token: admin, body: { fullName: 'MFA Staff', email, password: PASSWORD, roles: [{ roleId: roles.find((r) => r.code === 'support_agent')!.id }] } });
  await uiLogin(page, ADMIN, email, PASSWORD);
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await page.goto(`${ADMIN}/security`);
  await page.getByRole('button', { name: 'إعداد التحقق بخطوتين' }).click();
  const secret = (await page.getByTestId('mfa-secret').textContent())!.trim();
  await page.locator('#f-code').fill(totp(secret));
  await page.getByRole('button', { name: 'تفعيل' }).click();
  await expect(page.getByText('مفعّل: يُطلب رمز')).toBeVisible();

  await page.context().clearCookies();
  await uiLogin(page, ADMIN, email, PASSWORD);
  await expect(page.getByText('أدخل الرمز المكوّن من 6 أرقام')).toBeVisible();
  // The enabling code is spent; use the next 30-second window.
  await page.locator('#f-code').fill(totp(secret, Date.now() + 30_000));
  await page.getByRole('button', { name: 'تحقق' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  await expect(page.getByText('MFA Staff')).toBeVisible();
});
