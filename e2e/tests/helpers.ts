import { expect, type Page } from '@playwright/test';
import { E2E, apiUrl } from '../env';

/** Direct API access for arranging test data (the browser is used for what is being tested). */
export async function api<T = any>(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const r = await fetch(`${apiUrl}${path}`, {
    method,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${text}`);
  return data as T;
}

export async function login(identifier: string, password: string): Promise<string> {
  return (await api<{ accessToken: string }>('POST', '/v1/auth/login', { body: { identifier, password } })).accessToken;
}

export const adminToken = () => login(E2E.admin.email, E2E.admin.password);
export const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

export async function uiLogin(page: Page, base: string, identifier: string, password: string) {
  await page.goto(`${base}/login`);
  await page.locator('input[name="identifier"]').fill(identifier);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();
}

export async function expectNoError(page: Page) {
  await expect(page.locator('.alert-error')).toHaveCount(0);
}
