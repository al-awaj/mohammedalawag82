import { beforeAll, describe, expect, it } from 'vitest';
import { pdfBrowserPath } from '../src/lib/pdf.js';
import { api, useApp } from './helpers.js';
import { marketplace } from './fixtures.js';

/** Booking contract from a versioned admin template, and server-side PDF output (clause 65). */
const ctx = useApp();
let m: Awaited<ReturnType<typeof marketplace>>;
beforeAll(async () => { m = await marketplace(ctx, 'PAY_SANDBOX_CONTRACT_SECRET'); });

const raw = (url: string, token: string) => ctx.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const template = (version: string, extra = '') => ({
  countryId: m.country.id, reason: 'Contract text approved by legal',
  title: { ar: `عقد حجز ${version}`, en: `Booking contract ${version}` },
  body: { ar: `بين {{platformName}} والعميل {{customerName}}.\n\nالحجز {{bookingNumber}} للخدمة {{service}} بتاريخ {{startAt}} بمبلغ {{total}}.${extra}`, en: 'Booking {{bookingNumber}} for {{customerName}}.' },
});

describe('booking contract', () => {
  it('records the template version in force at booking time and fills it from the booking', async () => {
    const h = await m.hall();
    const c = await m.customer();
    const before = await m.order(c.token, h.serviceId);
    expect((await raw(`/v1/bookings/${before.bookings[0]!.id}/contract`, c.token)).statusCode).toBe(404);

    expect((await api(ctx, 'POST', '/v1/admin/contract-templates', { token: m.admin.token, body: template('v1', ' {{nonsense}}') })).status).toBe(400);
    const v1 = await api(ctx, 'POST', '/v1/admin/contract-templates', { token: m.admin.token, body: template('v1') });
    expect(v1.status).toBe(201);
    const o1 = await m.order(c.token, h.serviceId);
    await api(ctx, 'POST', '/v1/admin/contract-templates', { token: m.admin.token, body: template('v2') });
    const o2 = await m.order(c.token, h.serviceId);

    const html1 = (await raw(`/v1/bookings/${o1.bookings[0]!.id}/contract`, c.token)).body;
    const number1 = (await ctx.db.query('SELECT number FROM bookings WHERE id = $1', [o1.bookings[0]!.id])).rows[0].number;
    expect(html1).toContain('عقد حجز v1');
    expect(html1).toContain(number1);
    expect(html1).toContain('20000.0000 SAR');
    expect(html1).not.toContain('{{');
    expect((await raw(`/v1/bookings/${o2.bookings[0]!.id}/contract`, c.token)).body).toContain('عقد حجز v2');
    // The provider and staff can read it; another customer cannot.
    expect((await raw(`/v1/bookings/${o1.bookings[0]!.id}/contract`, h.p.token)).statusCode).toBe(200);
    expect((await raw(`/v1/bookings/${o1.bookings[0]!.id}/contract`, m.manager.token)).statusCode).toBe(200);
    expect((await raw(`/v1/bookings/${o1.bookings[0]!.id}/contract`, (await m.customer()).token)).statusCode).toBe(404);
    // Versions are append-only.
    await expect(ctx.db.query(`UPDATE contract_templates SET body = '{"ar":"x"}' WHERE id = $1`, [v1.body.id])).rejects.toThrow(/cannot be changed/);
    const list = await api(ctx, 'GET', '/v1/admin/contract-templates', { token: m.admin.token });
    expect(list.body.placeholders).toContain('customerName');
  });

  it.skipIf(!pdfBrowserPath())('prints contracts and invoices as PDF', async () => {
    const h = await m.hall();
    const c = await m.customer();
    await api(ctx, 'POST', '/v1/admin/contract-templates', { token: m.admin.token, body: template('pdf') });
    const o = await m.order(c.token, h.serviceId);
    await m.payCard(c.token, o.id, 'upfront');
    const pdf = await raw(`/v1/bookings/${o.bookings[0]!.id}/contract?format=pdf`, c.token);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const doc = (await api(ctx, 'GET', `/v1/documents?bookingId=${o.bookings[0]!.id}`, { token: c.token })).body[0];
    const inv = await raw(`/v1/documents/${doc.id}?format=pdf&lang=en`, c.token);
    expect(inv.statusCode).toBe(200);
    expect(inv.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  }, 60_000);
});
