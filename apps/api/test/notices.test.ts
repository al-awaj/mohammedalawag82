import { beforeAll, describe, expect, it } from 'vitest';
import { sendReminders } from '../src/modules/notifications/reminders.js';
import { api, uniq, useApp } from './helpers.js';
import { marketplace } from './fixtures.js';

/** Notification events of clause 53 that complete the lifecycle, and the reminder channel of clause 48. */
const ctx = useApp();
let m: Awaited<ReturnType<typeof marketplace>>;

beforeAll(async () => {
  m = await marketplace(ctx, 'PAY_SANDBOX_NOTICES_SECRET');
});

const sent = async (userId: string, key: string) => (await ctx.db.query<{ channel: string; payload: Record<string, unknown> }>(
  `SELECT channel, payload FROM message_outbox WHERE recipient_user_id = $1 AND template_key = $2 ORDER BY created_at`, [userId, key])).rows;

describe('lifecycle notices', () => {
  it('welcomes new accounts, in the inbox and by message', async () => {
    const c = await m.customer();
    const welcome = await sent(c.userId, 'account.welcome');
    expect(welcome.map((r) => r.channel).sort()).toEqual(['sms', 'web']);
  });

  it('tells the customer when a refund is requested and when it fails', async () => {
    const h = await m.hall();
    const c = await m.customer();
    const o = await m.order(c.token, h.serviceId);
    await m.payCard(c.token, o.id, 'upfront');
    const bookingId = o.bookings[0]!.id;
    expect((await api(ctx, 'POST', `/v1/bookings/${bookingId}/cancel`, { token: c.token, body: { reason: 'Plans changed' } })).status).toBe(200);
    expect((await sent(c.userId, 'refund.requested')).length).toBeGreaterThanOrEqual(1);

    const refund = (await api(ctx, 'GET', `/v1/admin/refunds?bookingId=${bookingId}`, { token: m.financeA.token })).body[0];
    await api(ctx, 'POST', `/v1/admin/refunds/${refund.id}/approve`, { token: m.financeB.token });
    await api(ctx, 'POST', `/v1/admin/refunds/${refund.id}/execute`, { token: m.financeB.token });
    const ref = (await ctx.db.query('SELECT external_ref FROM refunds WHERE id = $1', [refund.id])).rows[0].external_ref;
    await m.webhook({ id: `evt_${uniq()}`, type: 'refund.failed', data: { reference: ref, amount: refund.amount, currency: 'SAR', reason: 'card_expired' } });
    expect((await ctx.db.query('SELECT status FROM refunds WHERE id = $1', [refund.id])).rows[0].status).toBe('failed');
    expect((await sent(c.userId, 'refund.failed')).length).toBeGreaterThanOrEqual(1);
  });

  it('tells the provider when earnings change and when a settlement fails', async () => {
    const h = await m.hall();
    const c = await m.customer();
    const o = await m.order(c.token, h.serviceId);
    await m.payCard(c.token, o.id, 'upfront');
    await m.payCard(c.token, o.id, 'balance');
    await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [o.bookings[0]!.id]);
    await api(ctx, 'POST', `/v1/provider/bookings/${o.bookings[0]!.id}/complete`, { token: h.p.token });
    const providerUser = (await ctx.db.query('SELECT user_id FROM providers WHERE id = $1', [h.p.providerId])).rows[0].user_id;
    const due = await sent(providerUser, 'earning.updated');
    expect(due.at(-1)?.payload).toMatchObject({ status: 'due', amount: '18000.0000', currency: 'SAR' });

    const s = await api(ctx, 'POST', '/v1/admin/settlements', { token: m.financeA.token, body: { providerId: h.p.providerId, currency: 'SAR', accountId: m.bankAccount, method: 'bank_transfer' } });
    await api(ctx, 'POST', `/v1/admin/settlements/${s.body.id}/approve`, { token: m.financeB.token });
    expect((await api(ctx, 'POST', `/v1/admin/settlements/${s.body.id}/mark-failed`, { token: m.financeB.token, body: { reason: 'Bank rejected the transfer' } })).status).toBe(200);
    expect((await sent(providerUser, 'settlement.failed')).at(-1)?.payload).toMatchObject({ reason: 'Bank rejected the transfer' });
    expect((await sent(providerUser, 'earning.updated')).at(-1)?.payload).toMatchObject({ status: 'settlement_failed' });
  });

  it('tells both parties when the administration starts reviewing their dispute', async () => {
    const h = await m.hall();
    const c = await m.customer();
    const o = await m.order(c.token, h.serviceId);
    await m.payCard(c.token, o.id, 'upfront');
    const d = await api(ctx, 'POST', '/v1/disputes', { token: c.token, body: { bookingId: o.bookings[0]!.id, type: 'billing', subject: 'Charged twice', description: 'I was charged twice for the deposit.' } });
    expect((await api(ctx, 'POST', `/v1/admin/disputes/${d.body.id}/actions`, { token: m.manager.token, body: { action: 'start_review' } })).status).toBe(200);
    const providerUser = (await ctx.db.query('SELECT user_id FROM providers WHERE id = $1', [h.p.providerId])).rows[0].user_id;
    expect((await sent(c.userId, 'dispute.updated')).length).toBe(2);       // message + inbox
    expect((await sent(providerUser, 'dispute.updated')).length).toBe(2);
  });
});

describe('reminder channel (clause 48)', () => {
  it('sends a reminder on the channel chosen for the rule, and falls back when the customer has no address there', async () => {
    const h = await m.hall();
    const c = await m.customer();
    const o = await m.order(c.token, h.serviceId);
    await m.payCard(c.token, o.id, 'upfront');
    await ctx.db.query(`UPDATE bookings SET balance_due_at = now() + interval '2 days' WHERE id = $1`, [o.bookings[0]!.id]);
    const rule = await api(ctx, 'POST', '/v1/admin/reminder-rules', { token: m.admin.token, body: {
      kind: 'before_balance_due', daysBefore: 5, countryId: m.country.id, templateKey: 'booking.balance_reminder', channel: 'whatsapp' } });
    expect(rule.status).toBe(201);
    expect((await api(ctx, 'GET', '/v1/admin/reminder-rules', { token: m.admin.token })).body.find((r: { id: string }) => r.id === rule.body.id).channel).toBe('whatsapp');
    await sendReminders(ctx.db);
    expect((await sent(c.userId, 'booking.balance_reminder')).map((r) => r.channel).sort()).toEqual(['web', 'whatsapp']);
    // Customers without an email get the text by SMS when the rule says email.
    await ctx.db.query(`UPDATE users SET email = NULL WHERE id = $1`, [c.userId]);
    await api(ctx, 'PATCH', `/v1/admin/reminder-rules/${rule.body.id}`, { token: m.admin.token, body: { isActive: false, reason: 'Replaced by email rule' } });
    await api(ctx, 'POST', '/v1/admin/reminder-rules', { token: m.admin.token, body: {
      kind: 'before_balance_due', daysBefore: 5, countryId: m.country.id, templateKey: 'booking.balance_reminder', channel: 'email' } });
    await sendReminders(ctx.db);
    expect((await sent(c.userId, 'booking.balance_reminder')).map((r) => r.channel)).toContain('sms');
  });
});
