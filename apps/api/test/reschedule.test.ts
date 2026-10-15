import { beforeAll, describe, expect, it } from 'vitest';
import { expireRescheduleRequests } from '../src/modules/booking/reschedule.js';
import { api, useApp } from './helpers.js';
import { marketplace } from './fixtures.js';

/** Booking date changes: customer request, provider decision, calendar move, snapshot untouched (clause 26). */
const ctx = useApp();
let m: Awaited<ReturnType<typeof marketplace>>;
beforeAll(async () => { m = await marketplace(ctx, 'PAY_SANDBOX_RESCHEDULE_SECRET'); });

const dayStart = async (serviceId: string, date: string) =>
  (await ctx.db.query<{ s: Date }>(`SELECT ($2::date::timestamp AT TIME ZONE c.timezone) AS s FROM services s JOIN countries c ON c.id = s.country_id WHERE s.id = $1`, [serviceId, date])).rows[0]!.s;

describe('reschedule', () => {
  it('moves a confirmed booking after provider approval, keeping price and freeing the old date', async () => {
    const h = await m.hall();
    const c = await m.customer();
    const oldDate = m.nextDate();
    const o = await m.order(c.token, h.serviceId, oldDate);
    await m.payCard(c.token, o.id, 'upfront');
    const bookingId = o.bookings[0]!.id;
    const before = (await ctx.db.query('SELECT total, start_at, balance_due_at, calendar_block_id FROM bookings WHERE id = $1', [bookingId])).rows[0];
    const newDate = m.nextDate();
    const start = await dayStart(h.serviceId, newDate);

    // A local day is read in the booking country's timezone, keeping the time of day.
    const r = await api(ctx, 'POST', `/v1/bookings/${bookingId}/reschedule`, { token: c.token, body: { date: newDate, reason: 'Venue change' } });
    expect(r.status).toBe(201);
    // One open request at a time.
    expect((await api(ctx, 'POST', `/v1/bookings/${bookingId}/reschedule`, { token: c.token, body: { start: (await dayStart(h.serviceId, m.nextDate())).toISOString() } })).status).toBe(409);
    // The new date is held: another customer cannot take it.
    const blocked = await m.order((await m.customer()).token, h.serviceId, newDate) as unknown as { id?: string };
    expect(blocked.id).toBeUndefined();

    // Someone else's provider cannot decide; the right one approves.
    const stranger = await m.hall();
    expect((await api(ctx, 'POST', `/v1/provider/reschedule-requests/${r.body.id}/approve`, { token: stranger.p.token })).status).toBe(404);
    expect((await api(ctx, 'GET', '/v1/provider/reschedule-requests', { token: h.p.token })).body.map((x: { id: string }) => x.id)).toContain(r.body.id);
    expect((await api(ctx, 'POST', `/v1/provider/reschedule-requests/${r.body.id}/approve`, { token: h.p.token })).status).toBe(200);

    const after = (await ctx.db.query('SELECT total, start_at, balance_due_at, calendar_block_id FROM bookings WHERE id = $1', [bookingId])).rows[0];
    expect(after.total).toBe(before.total);
    expect(after.start_at.toISOString()).toBe(start.toISOString());
    expect(after.balance_due_at.getTime() - before.balance_due_at.getTime()).toBe(start.getTime() - before.start_at.getTime());
    const oldBlock = (await ctx.db.query('SELECT status FROM calendar_blocks WHERE id = $1', [before.calendar_block_id])).rows[0];
    expect(oldBlock.status).toBe('released');
    const newBlock = (await ctx.db.query('SELECT kind, status, booking_ref FROM calendar_blocks WHERE id = $1', [after.calendar_block_id])).rows[0];
    expect(newBlock).toMatchObject({ kind: 'booking', status: 'active', booking_ref: bookingId });
    // The old date is free again.
    expect((await m.order((await m.customer()).token, h.serviceId, oldDate)).id).toBeDefined();
    expect((await ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'booking.rescheduled' AND entity_id = $1`, [bookingId])).rowCount).toBe(1);
    expect((await ctx.db.query(`SELECT 1 FROM message_outbox WHERE template_key = 'booking.rescheduled' AND recipient_user_id = $1`, [c.userId])).rowCount).toBeGreaterThan(0);
  });

  it('rejects with a reason, releases the held date and keeps the original one', async () => {
    const h = await m.hall();
    const c = await m.customer();
    const o = await m.order(c.token, h.serviceId);
    await m.payCard(c.token, o.id, 'upfront');
    const bookingId = o.bookings[0]!.id;
    const newDate = m.nextDate();
    const r = await api(ctx, 'POST', `/v1/bookings/${bookingId}/reschedule`, { token: c.token, body: { start: (await dayStart(h.serviceId, newDate)).toISOString() } });
    expect((await api(ctx, 'POST', `/v1/provider/reschedule-requests/${r.body.id}/reject`, { token: h.p.token })).status).toBe(400);
    expect((await api(ctx, 'POST', `/v1/provider/reschedule-requests/${r.body.id}/reject`, { token: h.p.token, body: { reason: 'Fully booked that week' } })).status).toBe(200);
    expect((await m.order((await m.customer()).token, h.serviceId, newDate)).id).toBeDefined();
    const list = (await api(ctx, 'GET', `/v1/bookings/${bookingId}/reschedule-requests`, { token: c.token })).body;
    expect(list[0]).toMatchObject({ status: 'rejected', decisionReason: 'Fully booked that week' });
  });

  it('expires unanswered requests and lets the customer withdraw', async () => {
    const h = await m.hall();
    const c = await m.customer();
    const o = await m.order(c.token, h.serviceId);
    await m.payCard(c.token, o.id, 'upfront');
    const bookingId = o.bookings[0]!.id;
    const r = await api(ctx, 'POST', `/v1/bookings/${bookingId}/reschedule`, { token: c.token, body: { start: (await dayStart(h.serviceId, m.nextDate())).toISOString() } });
    expect((await api(ctx, 'POST', `/v1/reschedule-requests/${r.body.id}/withdraw`, { token: c.token })).status).toBe(200);
    const r2 = await api(ctx, 'POST', `/v1/bookings/${bookingId}/reschedule`, { token: c.token, body: { start: (await dayStart(h.serviceId, m.nextDate())).toISOString() } });
    expect(r2.status).toBe(201);
    await ctx.db.query(`UPDATE booking_reschedule_requests SET deadline = now() - interval '1 minute' WHERE id = $1`, [r2.body.id]);
    expect(await expireRescheduleRequests(ctx.db)).toBeGreaterThanOrEqual(1);
    expect((await api(ctx, 'POST', `/v1/provider/reschedule-requests/${r2.body.id}/approve`, { token: h.p.token })).status).toBe(409);
  });

  it('refuses dates outside availability and bookings of other customers', async () => {
    const h = await m.hall();
    const c = await m.customer();
    const o = await m.order(c.token, h.serviceId);
    const stranger = await m.customer();
    expect((await api(ctx, 'POST', `/v1/bookings/${o.bookings[0]!.id}/reschedule`, { token: stranger.token, body: { start: new Date(Date.now() + 86400e3 * 400).toISOString() } })).status).toBe(404);
    expect((await api(ctx, 'POST', `/v1/bookings/${o.bookings[0]!.id}/reschedule`, { token: c.token, body: { start: '2020-01-01T00:00:00Z' } })).status).toBe(400);
  });
});
