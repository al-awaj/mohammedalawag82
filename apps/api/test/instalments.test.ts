import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sendReminders } from '../src/modules/notifications/reminders.js';
import { api, uniq, useApp } from './helpers.js';
import { marketplace } from './fixtures.js';

/** Instalment plans and partial balance payments (clauses 45-48). */
const ctx = useApp();
let m: Awaited<ReturnType<typeof marketplace>>;
beforeAll(async () => { m = await marketplace(ctx, 'PAY_SANDBOX_INSTALMENT_SECRET'); });

const pay = (token: string, orderId: string, body: object) =>
  ctx.app.inject({ method: 'POST', url: `/v1/orders/${orderId}/payments`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() }, payload: { model: 'platform', method: 'card', purpose: 'balance', ...body } })
    .then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));

async function settle(p: { id: string; amount: string }) {
  const ref = (await ctx.db.query('SELECT external_ref FROM payments WHERE id = $1', [p.id])).rows[0].external_ref as string;
  await m.webhook({ id: `evt_${uniq()}`, type: 'payment.succeeded', data: { reference: ref, amount: p.amount, currency: 'SAR' } });
}

describe('instalments', () => {
  it('validates plans: sum 100, distinct days, needs a deposit', async () => {
    const h = await m.hall();
    const bad = (plan: object) => api(ctx, 'PATCH', `/v1/provider/services/${h.serviceId}`, { token: h.p.token, body: { instalmentPlan: plan } });
    expect((await bad([{ percent: '50', daysBefore: 60 }, { percent: '40', daysBefore: 30 }])).status).toBe(400);
    expect((await bad([{ percent: '50', daysBefore: 30 }, { percent: '50', daysBefore: 30 }])).status).toBe(400);
    expect((await api(ctx, 'PATCH', `/v1/provider/services/${h.serviceId}`, { token: h.p.token, body: { depositType: 'none', depositValue: '0', instalmentPlan: [{ percent: '50', daysBefore: 60 }, { percent: '50', daysBefore: 30 }] } })).status).toBe(400);
    expect((await bad([{ percent: '50', daysBefore: 60 }, { percent: '50', daysBefore: 30 }])).status).toBe(200);
    const d = await api(ctx, 'GET', `/v1/provider/services/${h.serviceId}`, { token: h.p.token });
    expect(d.body.instalmentPlan).toHaveLength(2);
  });

  it('freezes a dated schedule on the booking and lets the customer pay instalment by instalment', async () => {
    const h = await m.hall();
    await api(ctx, 'PATCH', `/v1/provider/services/${h.serviceId}`, { token: h.p.token, body: { instalmentPlan: [{ percent: '60', daysBefore: 90 }, { percent: '40', daysBefore: 14 }] } });
    const c = await m.customer();
    const o = await m.order(c.token, h.serviceId);
    const bookingId = o.bookings[0]!.id;
    const b = (await ctx.db.query('SELECT upfront_amount, instalment_plan, balance_due_at, start_at FROM bookings WHERE id = $1', [bookingId])).rows[0];
    // Balance 15,000 after a 25% deposit: 9,000 then 6,000.
    expect(b.upfront_amount).toBe('5000.0000');
    expect(b.instalment_plan.map((i: { amount: string }) => i.amount)).toEqual(['9000.0000', '6000.0000']);
    expect(new Date(b.balance_due_at).getTime()).toBe(new Date(b.start_at).getTime() - 14 * 86_400_000);
    // Later plan changes do not touch the booking.
    await api(ctx, 'PATCH', `/v1/provider/services/${h.serviceId}`, { token: h.p.token, body: { instalmentPlan: null } });
    expect((await ctx.db.query('SELECT instalment_plan FROM bookings WHERE id = $1', [bookingId])).rows[0].instalment_plan).toHaveLength(2);
    await expect(ctx.db.query(`UPDATE bookings SET instalment_plan = jsonb_set(instalment_plan, '{0,amount}', '"1.0000"') WHERE id = $1`, [bookingId])).rejects.toThrow(/immutable/);

    await m.payCard(c.token, o.id, 'upfront');
    const opts = (await api(ctx, 'GET', `/v1/orders/${o.id}/payment-options`, { token: c.token })).body.find((x: { purpose: string; method: string }) => x.purpose === 'balance' && x.method === 'card');
    expect(opts).toMatchObject({ amount: '15000.0000', nextInstalmentAmount: '9000.0000', minAmount: '15000.0000' });

    // With the default minimum (100%), only the next instalment or the full balance is accepted.
    expect((await pay(c.token, o.id, { amount: '5000' })).body.error.code).toBe('PAYMENT_AMOUNT_TOO_SMALL');
    expect((await pay(c.token, o.id, { amount: '15000.01' })).body.error.code).toBe('PAYMENT_AMOUNT_INVALID');
    const first = await pay(c.token, o.id, { amount: '9000' });
    expect(first.status).toBe(201);
    expect(first.body.amount).toBe('9000.0000');
    await settle(first.body);
    const after = (await api(ctx, 'GET', `/v1/bookings/${bookingId}`, { token: c.token })).body;
    expect(after).toMatchObject({ paidAmount: '14000.0000', remainingAmount: '6000.0000', status: 'confirmed' });
    expect(after.instalmentPlan).toHaveLength(2);

    // Reminder for the second instalment, once.
    await ctx.db.query(`UPDATE bookings SET instalment_plan = jsonb_set(instalment_plan, '{1,dueAt}', to_jsonb(now() + interval '5 days')) WHERE id = $1`, [bookingId]);
    await ctx.db.query(`INSERT INTO reminder_rules (kind, days_before, template_key, country_id) VALUES ('before_instalment_due', 7, 'booking.instalment_reminder', $1)`, [m.country.id]);
    await sendReminders(ctx.db);
    await sendReminders(ctx.db);
    const sent = await ctx.db.query(`SELECT payload FROM message_outbox WHERE template_key = 'booking.instalment_reminder' AND channel <> 'web' AND recipient_user_id = $1`, [c.userId]);
    expect(sent.rowCount).toBe(1);
    expect(sent.rows[0].payload).toMatchObject({ instalment: 2, remaining: '6000.0000' });
    await ctx.db.query(`UPDATE reminder_rules SET is_active = false WHERE kind = 'before_instalment_due'`);

    const rest = await pay(c.token, o.id, {});
    expect(rest.body.amount).toBe('6000.0000');
  });

  it('allows any early amount above the admin minimum', async () => {
    const h = await m.hall();
    const c = await m.customer();
    const o = await m.order(c.token, h.serviceId);
    await m.payCard(c.token, o.id, 'upfront');
    expect((await pay(c.token, o.id, { amount: '1000' })).status).toBe(400);
    expect((await api(ctx, 'PUT', '/v1/admin/settings/payments.partial_min_percent', { token: m.admin.token, body: { scope: 'country', countryId: m.country.id, value: 10, reason: 'Allow early partial payments' } })).status).toBe(200);
    const opts = (await api(ctx, 'GET', `/v1/orders/${o.id}/payment-options`, { token: c.token })).body.find((x: { purpose: string }) => x.purpose === 'balance');
    expect(opts.minAmount).toBe('1500.0000');
    expect((await pay(c.token, o.id, { amount: '1499.99' })).status).toBe(400);
    expect((await pay(c.token, o.id, { amount: '1000.001' })).status).toBe(400);
    const p = await pay(c.token, o.id, { amount: '2500.50' });
    expect(p.status).toBe(201);
    await settle(p.body);
    expect((await api(ctx, 'GET', `/v1/bookings/${o.bookings[0]!.id}`, { token: c.token })).body.remainingAmount).toBe('12499.5000');
    // Upfront payments cannot be split.
    expect((await pay(c.token, o.id, { purpose: 'upfront', amount: '10' })).status).toBeGreaterThanOrEqual(400);
  });
});
