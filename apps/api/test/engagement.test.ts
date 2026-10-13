import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliverOutbox } from '../src/modules/notifications/delivery.js';
import { sendReminders } from '../src/modules/notifications/reminders.js';
import { api, approvedProvider, createStaff, latestCode, PDF, PNG, register, setupCountry, uniq, upload, useApp } from './helpers.js';

const ctx = useApp();
const SECRET = 'sandbox-secret-for-phase8-tests-012';
process.env.PAY_SANDBOX_P8_SECRET = SECRET;
process.env.SMS_P8_SECRET = 'sms-relay-token';

let admin: { token: string; id: string };
let supervisor: { token: string };
let financeA: { token: string };
let financeB: { token: string };
let disputeAgent: { token: string };
let country: { id: string; code: string };
let hallType: string;
let integrationId: string;

// A real HTTP receiver standing in for an SMS provider / relay.
let relay: Server;
let relayUrl = '';
let relayMode: 'ok' | 'fail' = 'ok';
const received: { auth: string | undefined; body: { to: string; body: string; channel: string; messageId: string } }[] = [];

let dayCounter = 0;
const nextDate = () => new Date(Date.UTC(2028, 0, 1 + dayCounter++)).toISOString().slice(0, 10);

async function hall() {
  const p = await approvedProvider(ctx, supervisor.token, country.code);
  await api(ctx, 'PUT', `/v1/admin/providers/${p.providerId}/service-types`, { token: admin.token, body: { serviceTypeIds: [hallType] } });
  const s = await api(ctx, 'POST', '/v1/provider/services', {
    token: p.token,
    body: { serviceTypeId: hallType, title: { en: 'Hall' }, description: { en: 'D' }, city: 'Riyadh', currency: 'SAR', basePrice: '20000', pricingUnit: 'fixed',
      requiresProviderApproval: false, depositType: 'percent', depositValue: '25' },
  });
  await upload(ctx, `/v1/provider/services/${s.body.id}/media`, p.token, PNG);
  await api(ctx, 'POST', `/v1/provider/services/${s.body.id}/submit`, { token: p.token });
  await api(ctx, 'POST', `/v1/admin/services/${s.body.id}/actions`, { token: supervisor.token, body: { action: 'publish' } });
  return { p, serviceId: s.body.id as string };
}

async function customer() {
  const c = await register(ctx, country.code);
  const code = await latestCode(ctx, c.userId, 'auth.verify_phone');
  await api(ctx, 'POST', '/v1/auth/verification/confirm', { token: c.token, body: { channel: 'phone', code } });
  return c;
}

async function webhook(body: object) {
  const raw = JSON.stringify(body);
  const r = await ctx.app.inject({ method: 'POST', url: `/v1/webhooks/payments/${integrationId}`, payload: raw, headers: { 'content-type': 'application/json', 'x-sandbox-signature': createHmac('sha256', SECRET).update(raw).digest('hex') } });
  return JSON.parse(r.body);
}

async function pay(token: string, orderId: string, purpose: 'upfront' | 'balance') {
  const r = await ctx.app.inject({ method: 'POST', url: `/v1/orders/${orderId}/payments`, headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() }, payload: { model: 'platform', method: 'card', purpose } });
  const p = JSON.parse(r.body);
  const ref = (await ctx.db.query('SELECT external_ref FROM payments WHERE id = $1', [p.id])).rows[0].external_ref;
  await webhook({ id: `evt_${uniq()}`, type: 'payment.succeeded', data: { reference: ref, amount: p.amount, currency: 'SAR' } });
  return p;
}

async function checkout(token: string, body: Record<string, unknown> = { acceptTerms: true }) {
  const r = await ctx.app.inject({ method: 'POST', url: '/v1/checkout', headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() }, payload: body });
  return { status: r.statusCode, body: JSON.parse(r.body) };
}

async function book(c: { token: string }, serviceId: string, coupon?: string) {
  await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId, date: nextDate() } });
  const o = await checkout(c.token, { acceptTerms: true, ...(coupon ? { couponCode: coupon } : {}) });
  if (o.status !== 201) throw new Error(JSON.stringify(o.body));
  return { orderId: o.body.id as string, booking: o.body.bookings[0] };
}

async function completedBooking(serviceId: string, providerToken: string, coupon?: string) {
  const c = await customer();
  const { orderId, booking } = await book(c, serviceId, coupon);
  await pay(c.token, orderId, 'upfront');
  await pay(c.token, orderId, 'balance');
  await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [booking.id]);
  expect((await api(ctx, 'POST', `/v1/provider/bookings/${booking.id}/complete`, { token: providerToken })).body.status).toBe('completed');
  return { c, orderId, bookingId: booking.id as string };
}

async function balances() {
  const rows = (await api(ctx, 'GET', `/v1/admin/accounts?countryId=${country.id}&currency=SAR`, { token: financeA.token })).body as { code: string; balance: string }[];
  return Object.fromEntries(rows.map((r) => [r.code, Number(r.balance)]));
}

beforeAll(async () => {
  relay = createServer((req, res) => {
    let data = '';
    req.on('data', (d) => { data += d; });
    req.on('end', () => {
      received.push({ auth: req.headers.authorization, body: JSON.parse(data) });
      if (relayMode === 'fail') { res.writeHead(503).end('busy'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: `relay-${received.length}` }));
    });
  });
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}/send`;

  admin = await createStaff(ctx, [{ code: 'system_admin' }]);
  country = await setupCountry(ctx, admin.token);
  supervisor = await createStaff(ctx, [{ code: 'services_supervisor', countryId: country.id }]);
  financeA = await createStaff(ctx, [{ code: 'finance_officer', countryId: country.id }]);
  financeB = await createStaff(ctx, [{ code: 'finance_officer', countryId: country.id }]);
  disputeAgent = await createStaff(ctx, [{ code: 'manager', countryId: country.id }]);
  const categoryId = (await api(ctx, 'POST', '/v1/admin/categories', { token: admin.token, body: { slug: `c-${uniq()}`, name: { en: 'C' }, countryIds: [country.id] } })).body.id;
  hallType = (await api(ctx, 'POST', '/v1/admin/service-types', { token: admin.token, body: { categoryId, code: `t_${uniq()}`.slice(0, 40), name: { en: 'Hall' }, bookingMode: 'full_day', pricingUnits: ['fixed'] } })).body.id;
  const gw = (await api(ctx, 'POST', '/v1/admin/accounts', { token: admin.token, body: { countryId: country.id, currency: 'SAR', kind: 'gateway', suffix: 'P8', name: { en: 'Gateway' } } })).body.id;
  integrationId = (await api(ctx, 'POST', '/v1/admin/payment-integrations', { token: admin.token, body: { providerCode: 'sandbox', name: 'Sandbox', countryId: country.id, kind: 'gateway', environment: 'test', secretRef: 'PAY_SANDBOX_P8_SECRET' } })).body.id;
  await api(ctx, 'PATCH', `/v1/admin/payment-integrations/${integrationId}`, { token: admin.token, body: { isActive: true, reason: 'Enable for tests' } });
  await api(ctx, 'POST', '/v1/admin/payment-methods', { token: admin.token, body: { countryId: country.id, model: 'platform', method: 'card', integrationId, accountId: gw } });
  await api(ctx, 'POST', '/v1/admin/commission-rules', { token: admin.token, body: { scope: 'country', countryId: country.id, rateType: 'percent', rateValue: '10' } });
});

afterAll(() => new Promise<void>((r) => relay.close(() => r())));

describe('notifications (tests 29, clauses 52-54)', () => {
  it('delivers through the configured channel, logs the result and never keeps one-time codes', async () => {
    expect((await api(ctx, 'POST', '/v1/admin/messaging-channels', { token: admin.token, body: { countryId: country.id, channel: 'sms', endpoint: relayUrl, secretRef: 'SMS_P8_SECRET', senderId: 'EVENTS' } })).status).toBe(201);
    // Drain anything queued before the channel existed in this country.
    await ctx.db.query(`UPDATE message_outbox SET status = 'failed', last_error = 'test setup' WHERE status = 'pending'`);

    const u = await register(ctx, country.code);
    const code = await latestCode(ctx, u.userId, 'auth.verify_phone');
    received.length = 0;
    await deliverOutbox(ctx.db);
    const sent = received.find((r) => r.body.to === u.phone)!;
    expect(sent.auth).toBe('Bearer sms-relay-token');
    expect(sent.body.body).toContain(code); // the user receives the real code (Arabic template)

    const row = (await ctx.db.query(`SELECT status, provider_ref, body, payload FROM message_outbox WHERE recipient_user_id = $1 AND template_key = 'auth.verify_phone'`, [u.userId])).rows[0];
    expect(row.status).toBe('sent');
    expect(row.provider_ref).toMatch(/^relay-/);
    expect(row.body).not.toContain(code);
    expect(row.body).toContain('••••••');
    expect(row.payload.code).toBeUndefined();
    // One-time codes are never copied to the in-app inbox.
    expect((await ctx.db.query(`SELECT 1 FROM message_outbox WHERE recipient_user_id = $1 AND channel = 'web' AND template_key LIKE 'auth.%'`, [u.userId])).rowCount).toBe(0);

    const log = (await api(ctx, 'GET', `/v1/admin/notifications?recipientId=${u.userId}`, { token: admin.token })).body;
    expect(log.find((l: { templateKey: string }) => l.templateKey === 'auth.verify_phone')).toMatchObject({ channel: 'sms', status: 'sent' });
    expect(JSON.stringify(log)).not.toContain(code);
  });

  it('retries provider failures, then records the failure; reports missing channels and templates', async () => {
    const u = await register(ctx, country.code);
    relayMode = 'fail';
    try {
      await deliverOutbox(ctx.db);
      const row = (await ctx.db.query(`SELECT status, attempts, last_error, next_attempt_at > now() AS later FROM message_outbox WHERE recipient_user_id = $1 AND template_key = 'auth.verify_phone'`, [u.userId])).rows[0];
      expect(row).toMatchObject({ status: 'pending', attempts: 1, later: true });
      expect(row.last_error).toContain('503');
      await ctx.db.query(`UPDATE message_outbox SET attempts = 4, next_attempt_at = now() WHERE recipient_user_id = $1`, [u.userId]);
      await deliverOutbox(ctx.db);
      expect((await ctx.db.query(`SELECT status FROM message_outbox WHERE recipient_user_id = $1 AND template_key = 'auth.verify_phone'`, [u.userId])).rows[0].status).toBe('failed');
    } finally {
      relayMode = 'ok';
    }
    // No email channel configured for this country.
    const id = (await ctx.db.query(`INSERT INTO message_outbox (channel, recipient_user_id, target, template_key, language, payload) VALUES ('email', $1, 'x@test.local', 'order.created', 'ar', '{}') RETURNING id`, [u.userId])).rows[0].id;
    const unknown = (await ctx.db.query(`INSERT INTO message_outbox (channel, recipient_user_id, target, template_key, language, payload) VALUES ('sms', $1, $2, 'no.such.template', 'ar', '{}') RETURNING id`, [u.userId, u.phone])).rows[0].id;
    await deliverOutbox(ctx.db);
    const rows = Object.fromEntries((await ctx.db.query(`SELECT id, last_error FROM message_outbox WHERE id = ANY($1)`, [[id, unknown]])).rows.map((r) => [r.id, r.last_error]));
    expect(rows[id]).toBe('channel_not_configured');
    expect(rows[unknown]).toBe('template_missing');
  });

  it('keeps an in-app inbox per user with translated, admin-editable templates', async () => {
    const { serviceId } = await hall();
    const c = await customer();
    await api(ctx, 'PATCH', '/v1/me', { token: c.token, body: { preferredLanguage: 'en' } });
    await api(ctx, 'PUT', '/v1/admin/notification-templates', { token: admin.token, body: { key: 'order.created', channel: 'web', language: 'en', subject: 'Order', body: 'Thanks! Order {{number}} is in.' } });
    const { orderId } = await book(c, serviceId);
    await deliverOutbox(ctx.db);
    const inbox = (await api(ctx, 'GET', '/v1/me/notifications', { token: c.token })).body;
    const orderMsg = inbox.items.find((i: { type: string }) => i.type === 'order.created');
    const number = (await ctx.db.query('SELECT number FROM orders WHERE id = $1', [orderId])).rows[0].number;
    expect(orderMsg.body).toBe(`Thanks! Order ${number} is in.`);
    expect(inbox.unread).toBeGreaterThan(0);
    await api(ctx, 'POST', `/v1/me/notifications/${orderMsg.id}/read`, { token: c.token });
    await api(ctx, 'POST', '/v1/me/notifications/read-all', { token: c.token });
    expect((await api(ctx, 'GET', '/v1/me/notifications', { token: c.token })).body.unread).toBe(0);
    // Someone else's notification cannot be touched.
    expect((await api(ctx, 'POST', `/v1/me/notifications/${orderMsg.id}/read`, { token: (await customer()).token })).status).toBe(404);
  });

  it('reminds once about a remaining balance, and never when nothing is owed (clause 48)', async () => {
    const { serviceId } = await hall();
    await api(ctx, 'POST', '/v1/admin/reminder-rules', { token: admin.token, body: { kind: 'before_balance_due', daysBefore: 10, countryId: country.id, templateKey: 'booking.balance_reminder' } });
    const c = await customer();
    const { orderId, booking } = await book(c, serviceId);
    await pay(c.token, orderId, 'upfront');
    await ctx.db.query(`UPDATE bookings SET start_at = now() + interval '12 days', end_at = now() + interval '13 days', balance_due_at = now() + interval '5 days' WHERE id = $1`, [booking.id]);
    await sendReminders(ctx.db);
    await sendReminders(ctx.db);
    const msgs = (await ctx.db.query(`SELECT payload FROM message_outbox WHERE recipient_user_id = $1 AND template_key = 'booking.balance_reminder' AND channel <> 'web'`, [c.userId])).rows;
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload).toMatchObject({ remaining: '15000.0000', currency: 'SAR' });

    const paidUp = await customer();
    const full = await book(paidUp, serviceId);
    await pay(paidUp.token, full.orderId, 'upfront');
    await pay(paidUp.token, full.orderId, 'balance');
    await ctx.db.query(`UPDATE bookings SET balance_due_at = now() + interval '5 days' WHERE id = $1`, [full.booking.id]);
    await sendReminders(ctx.db);
    expect((await ctx.db.query(`SELECT 1 FROM message_outbox WHERE recipient_user_id = $1 AND template_key = 'booking.balance_reminder'`, [paidUp.userId])).rowCount).toBe(0);
  });
});

describe('disputes (tests 27-28, clause 51)', () => {
  it('runs the full cycle: evidence, information request, partial hold, decision, refund charged to the provider, closure', async () => {
    const { p, serviceId } = await hall();
    const { c, bookingId } = await completedBooking(serviceId, p.token);
    const before = await balances();

    const d = await api(ctx, 'POST', '/v1/disputes', { token: c.token, body: { bookingId, type: 'service_quality', subject: 'Sound system failed', description: 'The sound system stopped for two hours during the event.', disputedAmount: '5000' } });
    expect(d.status).toBe(201);
    expect(d.body.number).toMatch(/^DSP-/);
    expect((await api(ctx, 'POST', '/v1/disputes', { token: c.token, body: { bookingId, type: 'other', subject: 'Again', description: 'Opening a second one now.' } })).body.error.code).toBe('DISPUTE_ALREADY_OPEN');
    expect((await api(ctx, 'GET', `/v1/disputes/${d.body.id}`, { token: (await customer()).token })).status).toBe(404);

    const ev = await upload(ctx, `/v1/disputes/${d.body.id}/evidence`, c.token, PDF, { description: 'Video timestamps' });
    expect(ev.status).toBe(201);
    // The provider is a party and sees the case, but not the customer's evidence until staff share it.
    const provView = (await api(ctx, 'GET', `/v1/disputes/${d.body.id}`, { token: p.token })).body;
    expect(provView).toMatchObject({ myRole: 'provider', status: 'new' });
    expect(provView.evidence).toEqual([]);

    const act = (action: string, extra: object = {}) => api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/actions`, { token: disputeAgent.token, body: { action, ...extra } });
    expect((await act('start_review')).body.status).toBe('under_review');
    expect((await act('request_info', { from: 'provider', note: 'Please send the technician report.' })).body.status).toBe('awaiting_info');
    expect((await api(ctx, 'POST', `/v1/disputes/${d.body.id}/statements`, { token: p.token, body: { note: 'Generator failure, report attached.' } })).body.status).toBe('under_review');
    // Statements are not a chat: the customer does not see the provider's statement (decision D11).
    const custView = (await api(ctx, 'GET', `/v1/disputes/${d.body.id}`, { token: c.token })).body;
    expect(JSON.stringify(custView.events)).not.toContain('Generator failure');
    expect(custView.events.map((e: { action: string }) => e.action)).toContain('info_requested');
    await api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/evidence/${ev.body.id}/share`, { token: disputeAgent.token, body: { shared: true, reason: 'Provider must see the timestamps' } });
    expect((await api(ctx, 'GET', `/v1/disputes/${d.body.id}`, { token: p.token })).body.evidence).toHaveLength(1);

    // Only this booking's disputed amount is held, not the provider's other money.
    expect((await api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/hold`, { token: disputeAgent.token, body: { amount: '5000' } })).body.heldAmount).toBe('5000');
    const held = await balances();
    expect(held['2120']! - (before['2120'] ?? 0)).toBe(5000);
    expect((await ctx.db.query('SELECT status FROM provider_earnings WHERE booking_id = $1', [bookingId])).rows[0].status).toBe('on_hold_dispute');
    expect((await api(ctx, 'GET', `/v1/admin/settlements/preview?providerId=${p.providerId}&currency=SAR`, { token: financeA.token })).body.total).toBe('0.0000');

    await act('to_decision');
    const decided = await api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/decide`, { token: disputeAgent.token, body: { outcome: 'approve', rationale: 'Two hours without sound confirmed by both parties.', refundAmount: '3000', chargeTo: 'provider' } });
    expect(decided.body).toMatchObject({ status: 'resolution_approved', decision: { refundAmount: '3000.0000', chargeTo: 'provider' } });
    const settled = await api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/settle`, { token: disputeAgent.token });
    expect(settled.body.status).toBe('settled');

    const [refundId] = settled.body.refundIds;
    await api(ctx, 'POST', `/v1/admin/refunds/${refundId}/approve`, { token: financeB.token });
    await api(ctx, 'POST', `/v1/admin/refunds/${refundId}/execute`, { token: financeB.token });
    const ref = (await ctx.db.query('SELECT external_ref FROM refunds WHERE id = $1', [refundId])).rows[0].external_ref;
    await webhook({ id: `evt_${uniq()}`, type: 'refund.succeeded', data: { reference: ref, amount: '3000.0000', currency: 'SAR' } });

    const after = await balances();
    expect(after['2120']! - (before['2120'] ?? 0)).toBe(0);     // hold released
    expect(after['2110']! - before['2110']!).toBe(-3000);        // provider bears the refund
    expect(after['4100']! - before['4100']!).toBe(0);            // commission untouched
    expect((await ctx.db.query('SELECT status, net_amount FROM provider_earnings WHERE booking_id = $1', [bookingId])).rows[0]).toEqual({ status: 'due', net_amount: '15000.0000' });

    expect((await act('close')).body.status).toBe('closed');
    const full = (await api(ctx, 'GET', `/v1/admin/disputes/${d.body.id}`, { token: disputeAgent.token })).body;
    expect(full.events.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['opened', 'review_started', 'info_requested', 'statement', 'answered', 'earning_held', 'resolution_approved', 'hold_released', 'settled', 'closed']));
    await expect(ctx.db.query('DELETE FROM dispute_evidence WHERE id = $1', [ev.body.id])).rejects.toThrow(/cannot be deleted/);
    await expect(ctx.db.query(`UPDATE dispute_events SET note = 'x' WHERE dispute_id = $1`, [d.body.id])).rejects.toThrow(/append-only/);
  });

  it('rejects with a documented reason and releases the hold', async () => {
    const { p, serviceId } = await hall();
    const { c, bookingId } = await completedBooking(serviceId, p.token);
    const d = await api(ctx, 'POST', '/v1/disputes', { token: c.token, body: { bookingId, type: 'billing', subject: 'Charged too much', description: 'I think the price was higher than agreed.', disputedAmount: '1000' } });
    await api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/hold`, { token: disputeAgent.token, body: { amount: '1000' } });
    await api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/actions`, { token: disputeAgent.token, body: { action: 'start_review' } });
    await api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/actions`, { token: disputeAgent.token, body: { action: 'to_decision' } });
    expect((await api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/decide`, { token: disputeAgent.token, body: { outcome: 'reject', rationale: 'Price matches the signed booking terms.' } })).body.status).toBe('rejected');
    expect((await ctx.db.query('SELECT status FROM provider_earnings WHERE booking_id = $1', [bookingId])).rows[0].status).toBe('due');
    expect((await api(ctx, 'GET', `/v1/disputes/${d.body.id}`, { token: c.token })).body.decision.rationale).toBe('Price matches the signed booking terms.');
  });

  it('limits what the platform may absorb and who may decide', async () => {
    const { p, serviceId } = await hall();
    const { c, bookingId } = await completedBooking(serviceId, p.token);
    const d = await api(ctx, 'POST', '/v1/disputes', { token: c.token, body: { bookingId, type: 'service_quality', subject: 'Late setup', description: 'Setup finished an hour late.' } });
    await api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/actions`, { token: disputeAgent.token, body: { action: 'start_review' } });
    await api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/actions`, { token: disputeAgent.token, body: { action: 'to_decision' } });
    const support = await createStaff(ctx, [{ code: 'support_agent', countryId: country.id }]);
    expect((await api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/decide`, { token: support.token, body: { outcome: 'approve', rationale: 'Support cannot decide this.' } })).status).toBe(403);
    const tooMuch = await api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/decide`, { token: disputeAgent.token, body: { outcome: 'approve', rationale: 'Platform goodwill for the delay.', refundAmount: '2500', chargeTo: 'platform' } });
    expect(tooMuch.status).toBe(400); // commission on this booking is 2,000
    const noBearer = await api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/decide`, { token: disputeAgent.token, body: { outcome: 'approve', rationale: 'Refund without saying who pays.', refundAmount: '500' } });
    expect(noBearer.status).toBe(400);
  });

  it('accepts complaints to the administration without another party', async () => {
    const c = await customer();
    const r = await api(ctx, 'POST', '/v1/disputes', { token: c.token, body: { kind: 'complaint', type: 'other', subject: 'App keeps logging me out', description: 'Every hour the app signs me out.' } });
    expect(r.status).toBe(201);
    const view = (await api(ctx, 'GET', `/v1/disputes/${r.body.id}`, { token: c.token })).body;
    expect(view).toMatchObject({ kind: 'complaint', respondentRole: null, myRole: 'customer' });
    expect((await api(ctx, 'GET', '/v1/admin/disputes?kind=complaint', { token: disputeAgent.token })).body.map((x: { id: string }) => x.id)).toContain(r.body.id);
  });
});

describe('coupons (clause 55)', () => {
  it('applies a platform-borne coupon without reducing what the provider earns', async () => {
    const { p, serviceId } = await hall();
    const code = `WED${uniq().slice(0, 6).toUpperCase()}`;
    await api(ctx, 'POST', '/v1/admin/promotions', { token: admin.token, body: {
      code, name: { en: 'Wedding season' }, discountType: 'percent', discountValue: '10', maxDiscount: '1500', startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(), countryId: country.id, costBearer: 'platform', usageLimitPerCustomer: 1 } });

    const c = await customer();
    await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId, date: nextDate() } });
    expect((await api(ctx, 'POST', '/v1/cart/coupon', { token: c.token, body: { code } })).body).toMatchObject({ totalDiscount: '1500.0000' });
    const o = await checkout(c.token, { acceptTerms: true, couponCode: code });
    const b = o.body.bookings[0];
    expect(b).toMatchObject({ subtotal: '20000.0000', discountAmount: '1500.0000', total: '18500.0000', upfrontAmount: '4625.0000' });
    expect((await ctx.db.query('SELECT commission_amount FROM booking_commissions WHERE booking_id = $1', [b.id])).rows[0].commission_amount).toBe('2000.0000');

    await pay(c.token, o.body.id, 'upfront');
    await pay(c.token, o.body.id, 'balance');
    await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [b.id]);
    const before = await balances();
    await api(ctx, 'POST', `/v1/provider/bookings/${b.id}/complete`, { token: p.token });
    const after = await balances();
    expect(after['5200']! - (before['5200'] ?? 0)).toBe(1500);  // the platform pays the discount
    expect(after['2110']! - before['2110']!).toBe(18000);        // provider gets the same as without the coupon
    expect((await api(ctx, 'GET', `/v1/admin/ledger/trial-balance?countryId=${country.id}&currency=SAR`, { token: financeA.token })).body.totals.balanced).toBe(true);

    // Per-customer limit.
    await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId, date: nextDate() } });
    expect((await checkout(c.token, { acceptTerms: true, couponCode: code })).body.error.code).toBe('COUPON_LIMIT_REACHED');
  });

  it('lets providers fund their own coupons only, and charges it to them', async () => {
    const { p, serviceId } = await hall();
    const other = await hall();
    const code = `OWN${uniq().slice(0, 6).toUpperCase()}`;
    const window = { startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 86_400_000).toISOString() };
    expect((await api(ctx, 'POST', '/v1/provider/promotions', { token: p.token, body: { code: `X${code}`, name: { en: 'X' }, discountType: 'fixed', discountValue: '1000', currency: 'SAR', serviceIds: [other.serviceId], ...window } })).status).toBe(404);
    expect((await api(ctx, 'POST', '/v1/provider/promotions', { token: p.token, body: { code, name: { en: 'Loyalty' }, discountType: 'fixed', discountValue: '1000', currency: 'SAR', serviceIds: [serviceId], ...window } })).status).toBe(201);

    const { bookingId } = await completedBooking(serviceId, p.token, code);
    const e = (await ctx.db.query('SELECT commission_amount, net_amount, platform_discount FROM provider_earnings WHERE booking_id = $1', [bookingId])).rows[0];
    // 19,000 paid; commission on 19,000; the provider bears the 1,000.
    expect(e).toEqual({ commission_amount: '1900.0000', net_amount: '17100.0000', platform_discount: '0.0000' });

    // The coupon does not apply to another provider's service.
    const c = await customer();
    await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId: other.serviceId, date: nextDate() } });
    expect((await checkout(c.token, { acceptTerms: true, couponCode: code })).body.error.code).toBe('COUPON_INVALID');
  });

  it('refuses expired codes and frees the use when an unpaid booking ends', async () => {
    const { serviceId } = await hall();
    const code = `ONE${uniq().slice(0, 6).toUpperCase()}`;
    await api(ctx, 'POST', '/v1/admin/promotions', { token: admin.token, body: {
      code, name: { en: 'One use' }, discountType: 'fixed', discountValue: '500', currency: 'SAR', startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: new Date(Date.now() + 86_400_000).toISOString(), costBearer: 'shared', providerSharePercent: 50, usageLimitTotal: 1 } });
    const c = await customer();
    const { booking } = await book(c, serviceId, code);
    expect(booking).toMatchObject({ discountAmount: '500.0000', discountPlatformBorne: '250.0000', discountProviderBorne: '250.0000' });
    const c2 = await customer();
    await api(ctx, 'POST', '/v1/cart/items', { token: c2.token, body: { serviceId, date: nextDate() } });
    expect((await checkout(c2.token, { acceptTerms: true, couponCode: code })).body.error.code).toBe('COUPON_LIMIT_REACHED');
    await api(ctx, 'POST', `/v1/bookings/${booking.id}/cancel`, { token: c.token, body: { reason: 'Not needed' } });
    expect((await checkout(c2.token, { acceptTerms: true, couponCode: code })).status).toBe(201);

    const expired = `OLD${uniq().slice(0, 6).toUpperCase()}`;
    await api(ctx, 'POST', '/v1/admin/promotions', { token: admin.token, body: {
      code: expired, name: { en: 'Old' }, discountType: 'percent', discountValue: '5', startsAt: '2020-01-01T00:00:00Z', endsAt: '2020-02-01T00:00:00Z', costBearer: 'platform' } });
    await api(ctx, 'POST', '/v1/cart/items', { token: c2.token, body: { serviceId, date: nextDate() } });
    expect((await checkout(c2.token, { acceptTerms: true, couponCode: expired })).body.error.code).toBe('COUPON_INVALID');
  });
});

describe('reviews (clause 56)', () => {
  it('only lets the customer of a completed booking review once, and supports moderation', async () => {
    const { p, serviceId } = await hall();
    const c = await customer();
    const pending = await book(c, serviceId);
    expect((await api(ctx, 'POST', `/v1/bookings/${pending.booking.id}/review`, { token: c.token, body: { rating: 5 } })).body.error.code).toBe('REVIEW_NOT_ALLOWED');

    const done = await completedBooking(serviceId, p.token);
    expect((await api(ctx, 'POST', `/v1/bookings/${done.bookingId}/review`, { token: (await customer()).token, body: { rating: 1 } })).status).toBe(404);
    expect((await api(ctx, 'POST', `/v1/bookings/${done.bookingId}/review`, { token: done.c.token, body: { rating: 4, comment: 'Great hall, parking was tight.' } })).status).toBe(201);
    expect((await api(ctx, 'POST', `/v1/bookings/${done.bookingId}/review`, { token: done.c.token, body: { rating: 5 } })).body.error.code).toBe('REVIEW_NOT_ALLOWED');

    const second = await completedBooking(serviceId, p.token);
    const r2 = await api(ctx, 'POST', `/v1/bookings/${second.bookingId}/review`, { token: second.c.token, body: { rating: 2, comment: 'Terrible food!!!' } });
    const list = (await api(ctx, 'GET', `/v1/services/${serviceId}/reviews`)).body;
    expect(list).toMatchObject({ count: 2, average: '3.00' });
    expect(list.items[0].reviewer).toBe('Test'); // first name only
    expect((await api(ctx, 'GET', `/v1/services/${serviceId}`)).body.rating).toEqual({ average: '3.00', count: 2 });
    const found = (await api(ctx, 'GET', `/v1/services?country=${country.code}&minRating=3&sort=rating`)).body.items.find((s: { id: string }) => s.id === serviceId);
    expect(found).toMatchObject({ rating: '3.00', reviewCount: 2 });

    // The provider can report but not remove a review; staff decide.
    expect((await api(ctx, 'POST', `/v1/provider/reviews/${r2.body.id}/report`, { token: p.token, body: { reason: 'Not about our service' } })).status).toBe(200);
    const queue = (await api(ctx, 'GET', '/v1/admin/reviews?reported=true', { token: supervisor.token })).body;
    expect(queue.map((r: { id: string }) => r.id)).toContain(r2.body.id);
    await api(ctx, 'POST', `/v1/admin/reviews/${r2.body.id}/moderate`, { token: supervisor.token, body: { action: 'hide', reason: 'Abusive language' } });
    expect((await api(ctx, 'GET', `/v1/services/${serviceId}/reviews`)).body).toMatchObject({ count: 1, average: '4.00' });
    const audit = await ctx.db.query(`SELECT reason FROM audit_log WHERE entity_id = $1 AND action = 'review.hide'`, [r2.body.id]);
    expect(audit.rows[0].reason).toBe('Abusive language');
  });
});
