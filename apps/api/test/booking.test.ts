import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { withTx } from '../src/db/pool.js';
import { systemActor } from '../src/lib/audit.js';
import { confirmAfterPayment, expireBookings, warnExpiringHolds } from '../src/modules/booking/service.js';
import { api, approvedProvider, createStaff, latestCode, PNG, register, setupCountry, uniq, upload, useApp } from './helpers.js';

const ctx = useApp();
let admin: { token: string };
let supervisor: { token: string };
let country: { id: string; code: string };
let hallType: string;
let slotType: string;

// Fridays in April 2027 (Riyadh, UTC+3).
let dayCounter = 0;
const nextDate = () => {
  const d = new Date(Date.UTC(2027, 3, 1 + dayCounter++));
  return d.toISOString().slice(0, 10);
};

async function createType(over: Record<string, unknown>) {
  const categoryId = (await api(ctx, 'POST', '/v1/admin/categories', { token: admin.token, body: { slug: `c-${uniq()}`, name: { en: 'C' }, countryIds: [country.id] } })).body.id;
  return (await api(ctx, 'POST', '/v1/admin/service-types', {
    token: admin.token, body: { categoryId, code: `t_${uniq()}`.slice(0, 40), name: { en: 'T' }, minImages: 0, ...over },
  })).body.id as string;
}

async function liveService(typeId: string, body: Record<string, unknown>) {
  const p = await approvedProvider(ctx, supervisor.token, country.code);
  await api(ctx, 'PUT', `/v1/admin/providers/${p.providerId}/service-types`, { token: admin.token, body: { serviceTypeIds: [typeId] } });
  const s = await api(ctx, 'POST', '/v1/provider/services', {
    token: p.token, body: { serviceTypeId: typeId, title: { ar: 'خدمة', en: 'Service' }, description: { en: 'D' }, city: 'Riyadh', currency: 'SAR', ...body },
  });
  if (s.status !== 201) throw new Error(JSON.stringify(s.body));
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

const checkoutReq = (token: string, key = randomUUID(), body: Record<string, unknown> = { acceptTerms: true }) =>
  ctx.app.inject({ method: 'POST', url: '/v1/checkout', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, payload: body })
    .then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));

/** Customer books one item end-to-end and returns the order. */
async function book(token: string, item: Record<string, unknown>) {
  const add = await api(ctx, 'POST', '/v1/cart/items', { token, body: item });
  if (add.status !== 201) throw new Error(JSON.stringify(add.body));
  const r = await checkoutReq(token);
  if (r.status !== 201) throw new Error(JSON.stringify(r.body));
  return r.body;
}

const pay = (bookingId: string) => withTx(ctx.db, (c) => confirmAfterPayment(c, bookingId, systemActor));

beforeAll(async () => {
  admin = await createStaff(ctx, [{ code: 'system_admin' }]);
  country = await setupCountry(ctx, admin.token);
  supervisor = await createStaff(ctx, [{ code: 'services_supervisor', countryId: country.id }]);
  hallType = await createType({ bookingMode: 'full_day', pricingUnits: ['fixed', 'per_person'], capacityMode: 'guests' });
  slotType = await createType({ bookingMode: 'time_slot', pricingUnits: ['per_hour', 'fixed'], defaultDurationMinutes: 120, defaultRequiresApproval: false });
});

describe('pricing, deposit and balance (tests 19-20)', () => {
  it('computes deposit and remaining balance from the service or package, rounded to the currency', async () => {
    const { p, serviceId } = await liveService(hallType, { basePrice: '20000', pricingUnit: 'fixed', capacity: 500, depositType: 'percent', depositValue: '25', balanceDueDaysBefore: 7 });
    const date = '2027-06-10';
    const q = await api(ctx, 'POST', '/v1/quote', { body: { serviceId, date } });
    expect(q.body).toMatchObject({ total: '20000.0000', upfrontAmount: '5000.0000', depositType: 'percent', currency: 'SAR' });
    expect(new Date(q.body.balanceDueAt).toISOString()).toBe(new Date('2027-06-03T00:00:00+03:00').toISOString());

    const pkg = await api(ctx, 'POST', `/v1/provider/services/${serviceId}/packages`, {
      token: p.token, body: { name: { en: 'Per guest' }, price: '133.33', currency: 'SAR', pricingUnit: 'per_person', depositType: 'percent', depositValue: '12.5',
        addOns: [{ code: 'zaffa', name: { en: 'Zaffa' }, price: '2500' }] },
    });
    const pq = await api(ctx, 'POST', '/v1/quote', { body: { serviceId, date, packageId: pkg.body.id, guests: 3, addOns: ['zaffa'] } });
    // 3 × 133.33 = 399.99, + 2500 add-on = 2899.99; 12.5% = 362.49875 → 362.50
    expect(pq.body).toMatchObject({ subtotal: '2899.9900', total: '2899.9900', upfrontAmount: '362.5000', quantityFactor: '3' });
    expect((await api(ctx, 'POST', '/v1/quote', { body: { serviceId, date, packageId: pkg.body.id } })).body.error.code).toBe('GUESTS_REQUIRED');
    expect((await api(ctx, 'POST', '/v1/quote', { body: { serviceId, date, packageId: pkg.body.id, guests: 600 } })).body.error.code).toBe('CAPACITY_EXCEEDED');
    expect((await api(ctx, 'POST', '/v1/quote', { body: { serviceId, date, packageId: pkg.body.id, guests: 3, addOns: ['fireworks'] } })).body.error.code).toBe('ADD_ON_INVALID');
  });

  it('charges the full amount upfront when there is no deposit or the balance date has passed', async () => {
    const { serviceId } = await liveService(hallType, { basePrice: '1000', pricingUnit: 'fixed', capacity: 50, depositType: 'fixed', depositValue: '200', balanceDueDaysBefore: 365 });
    const q = await api(ctx, 'POST', '/v1/quote', { body: { serviceId, date: '2027-01-15' } });
    expect(q.body).toMatchObject({ upfrontAmount: '1000.0000', balanceDueAt: null });
  });

  it('prices by the hour exactly', async () => {
    const { serviceId } = await liveService(slotType, { basePrice: '350.50', pricingUnit: 'per_hour' });
    const q = await api(ctx, 'POST', '/v1/quote', { body: { serviceId, startAt: '2027-06-10T10:00:00+03:00' } });
    expect(q.body).toMatchObject({ total: '701.0000', quantityFactor: '2', upfrontAmount: '701.0000' });
    expect(new Date(q.body.end).toISOString()).toBe(new Date('2027-06-10T12:00:00+03:00').toISOString());
  });
});

describe('cart and checkout (tests 12-13)', () => {
  it('books services from different providers as one order with a booking each, idempotently', async () => {
    const hall = await liveService(hallType, { basePrice: '20000', pricingUnit: 'fixed', capacity: 300, requiresProviderApproval: false, depositType: 'percent', depositValue: '30' });
    const photo = await liveService(slotType, { basePrice: '500', pricingUnit: 'per_hour' });
    const c = await customer();
    const date = nextDate();
    expect((await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId: hall.serviceId, date } })).status).toBe(201);
    expect((await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId: photo.serviceId, startAt: `${date}T18:00:00+03:00` } })).status).toBe(201);

    const cart = await api(ctx, 'GET', '/v1/cart', { token: c.token });
    expect(cart.body.items.map((i: { state: string }) => i.state)).toEqual(['ok', 'ok']);
    expect(cart.body.totals).toEqual({ SAR: { total: '21000.0000', upfront: '7000.0000' } });

    const noKey = await api(ctx, 'POST', '/v1/checkout', { token: c.token, body: { acceptTerms: true } });
    expect(noKey.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await checkoutReq(c.token, randomUUID(), { acceptTerms: false })).body.error.code).toBe('TERMS_NOT_ACCEPTED');

    const key = randomUUID();
    const order = await checkoutReq(c.token, key);
    expect(order.status).toBe(201);
    expect(order.body).toMatchObject({ total: '21000.0000', upfrontTotal: '7000.0000', currency: 'SAR', status: 'active' });
    expect(order.body.number).toMatch(/^ORD-\d{4}-\d{7}$/);
    expect(order.body.bookings).toHaveLength(2);
    expect(new Set(order.body.bookings.map((b: { number: string }) => b.number)).size).toBe(2);
    expect(order.body.bookings.every((b: { status: string }) => b.status === 'awaiting_payment')).toBe(true);

    // Retrying with the same key (double click, network retry) returns the same order and creates nothing.
    const replay = await checkoutReq(c.token, key);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(order.body.id);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM bookings WHERE customer_id = $1', [c.userId])).rows[0].n).toBe(2);

    expect((await api(ctx, 'GET', '/v1/cart', { token: c.token })).body.items).toEqual([]);
    const accepted = await ctx.db.query(`SELECT 1 FROM terms_acceptances WHERE user_id = $1 AND context = 'booking'`, [c.userId]);
    expect(accepted.rowCount).toBe(1);
    const providerMsgs = await ctx.db.query(`SELECT template_key FROM message_outbox WHERE channel <> 'web' AND recipient_user_id = ANY($1) AND template_key LIKE 'booking.%'`, [[hall.p.userId, photo.p.userId]]);
    expect(providerMsgs.rows.map((r) => r.template_key)).toEqual(['booking.created', 'booking.created']);
  });

  it('refuses a stale price and accepts the corrected one on retry', async () => {
    const { p, serviceId } = await liveService(hallType, { basePrice: '5000', pricingUnit: 'fixed', capacity: 100, requiresProviderApproval: false });
    const c = await customer();
    await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId, date: nextDate() } });
    await api(ctx, 'PATCH', `/v1/provider/services/${serviceId}`, { token: p.token, body: { basePrice: '5500' } });
    expect((await api(ctx, 'GET', '/v1/cart', { token: c.token })).body.items[0]).toMatchObject({ state: 'price_changed', quotedTotal: '5000.0000', currentTotal: '5500.0000' });
    const stale = await checkoutReq(c.token);
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'PRICE_CHANGED', details: [{ previousTotal: '5000.0000', currentTotal: '5500.0000' }] });
    const ok = await checkoutReq(c.token);
    expect(ok.status).toBe(201);
    expect(ok.body.total).toBe('5500.0000');
  });

  it('never gives the same slot to two customers', async () => {
    const { serviceId } = await liveService(hallType, { basePrice: '5000', pricingUnit: 'fixed', capacity: 100, requiresProviderApproval: false });
    const [a, b] = [await customer(), await customer()];
    const date = nextDate();
    for (const u of [a, b]) await api(ctx, 'POST', '/v1/cart/items', { token: u.token, body: { serviceId, date } });
    const results = await Promise.all([checkoutReq(a.token), checkoutReq(b.token)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results[0]!.status === 409 ? a : b;
    expect((await api(ctx, 'GET', '/v1/cart', { token: loser.token })).body.items[0].state).toBe('unavailable');
  });

  it('requires a verified phone and one currency per order', async () => {
    const usd = await liveService(hallType, { basePrice: '1000', currency: 'USD', pricingUnit: 'fixed', capacity: 100, requiresProviderApproval: false });
    const sar = await liveService(hallType, { basePrice: '1000', pricingUnit: 'fixed', capacity: 100, requiresProviderApproval: false });
    const unverified = await register(ctx, country.code);
    await api(ctx, 'POST', '/v1/cart/items', { token: unverified.token, body: { serviceId: sar.serviceId, date: nextDate() } });
    expect((await checkoutReq(unverified.token)).body.error.code).toBe('PHONE_NOT_VERIFIED');

    const c = await customer();
    const date = nextDate();
    await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId: usd.serviceId, date } });
    await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId: sar.serviceId, date } });
    expect((await api(ctx, 'GET', '/v1/cart', { token: c.token })).body.totals).toEqual({ USD: { total: '1000.0000', upfront: '1000.0000' }, SAR: { total: '1000.0000', upfront: '1000.0000' } });
    expect((await checkoutReq(c.token)).body.error.code).toBe('MIXED_CURRENCIES');
    const items = (await api(ctx, 'GET', '/v1/cart', { token: c.token })).body.items;
    expect((await checkoutReq(c.token, randomUUID(), { acceptTerms: true, itemIds: [items[0].id] })).status).toBe(201);
  });

  it('caps bookings per package slot', async () => {
    const { p, serviceId } = await liveService(hallType, { basePrice: '1000', pricingUnit: 'fixed', capacity: 100, requiresProviderApproval: false, maxConcurrentBookings: 5 });
    const pkg = (await api(ctx, 'POST', `/v1/provider/services/${serviceId}/packages`, { token: p.token, body: { name: { en: 'VIP' }, price: '3000', currency: 'SAR', pricingUnit: 'fixed', maxBookingsPerSlot: 1 } })).body.id;
    const date = nextDate();
    await book((await customer()).token, { serviceId, date, packageId: pkg });
    const c2 = await customer();
    const full = await api(ctx, 'POST', '/v1/cart/items', { token: c2.token, body: { serviceId, date, packageId: pkg } });
    expect((await checkoutReq(c2.token)).body.error.code).toBe('PACKAGE_FULL');
    await api(ctx, 'DELETE', `/v1/cart/items/${full.body.id}`, { token: c2.token });
    expect(await book(c2.token, { serviceId, date })).toMatchObject({ total: '1000.0000' }); // base service still has capacity
  });
});

describe('provider approval per service (tests 7-8, decision D5)', () => {
  it('holds the slot while awaiting the provider, then for payment after acceptance', async () => {
    const { p, serviceId } = await liveService(hallType, { basePrice: '8000', pricingUnit: 'fixed', capacity: 100 }); // type default: approval required
    const c = await customer();
    const order = await book(c.token, { serviceId, date: nextDate() });
    const b = order.bookings[0];
    expect(b).toMatchObject({ status: 'pending_provider_approval', requiresProviderApproval: true });
    const hours = (Date.parse(b.approvalDeadline) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    const req = await ctx.db.query(`SELECT 1 FROM message_outbox WHERE channel <> 'web' AND recipient_user_id = $1 AND template_key = 'booking.approval_requested'`, [p.userId]);
    expect(req.rowCount).toBe(1);

    // Cannot be confirmed by payment before the provider accepts.
    await expect(pay(b.id)).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });

    const acc = await api(ctx, 'POST', `/v1/provider/bookings/${b.id}/accept`, { token: p.token });
    expect(acc.body.status).toBe('awaiting_payment');
    const after = (await api(ctx, 'GET', `/v1/bookings/${b.id}`, { token: c.token })).body;
    expect(after.history.map((h: { to: string }) => h.to)).toEqual(['pending_provider_approval', 'awaiting_payment']);
    await pay(b.id);
    expect((await api(ctx, 'GET', `/v1/bookings/${b.id}`, { token: c.token })).body.status).toBe('confirmed');
  });

  it('rejection needs a reason, frees the slot and notifies the customer', async () => {
    const { p, serviceId } = await liveService(hallType, { basePrice: '8000', pricingUnit: 'fixed', capacity: 100 });
    const c = await customer();
    const date = nextDate();
    const b = (await book(c.token, { serviceId, date })).bookings[0];
    expect((await api(ctx, 'POST', `/v1/provider/bookings/${b.id}/reject`, { token: p.token, body: {} })).status).toBe(400);
    expect((await api(ctx, 'POST', `/v1/provider/bookings/${b.id}/reject`, { token: p.token, body: { reason: 'Private event that day' } })).body.status).toBe('rejected');
    const note = await ctx.db.query(`SELECT payload->>'reason' AS r FROM message_outbox WHERE channel <> 'web' AND recipient_user_id = $1 AND template_key = 'booking.rejected'`, [c.userId]);
    expect(note.rows[0].r).toBe('Private event that day');
    expect((await book((await customer()).token, { serviceId, date })).bookings[0].status).toBe('pending_provider_approval');
  });

  it('confirms without provider approval once paid, when the service does not require it', async () => {
    const { serviceId } = await liveService(hallType, { basePrice: '8000', pricingUnit: 'fixed', capacity: 100, requiresProviderApproval: false });
    const b = (await book((await customer()).token, { serviceId, date: nextDate() })).bookings[0];
    expect(b.status).toBe('awaiting_payment');
    expect((Date.parse(b.holdExpiresAt) - Date.now()) / 60_000).toBeLessThanOrEqual(15);
    await pay(b.id);
    const block = await ctx.db.query(`SELECT kind, expires_at FROM calendar_blocks WHERE booking_ref = $1 AND status = 'active'`, [b.id]);
    expect(block.rows).toEqual([{ kind: 'booking', expires_at: null }]);
  });
});

describe('snapshots (test 6, clauses 20 and 66)', () => {
  it('keeps the agreed price and policy after the provider edits them', async () => {
    const { p, serviceId } = await liveService(hallType, { basePrice: '10000', pricingUnit: 'fixed', capacity: 100, requiresProviderApproval: false, depositType: 'fixed', depositValue: '2000', terms: { en: 'Original terms' } });
    const b = (await book((await customer()).token, { serviceId, date: nextDate() })).bookings[0];
    await api(ctx, 'PATCH', `/v1/provider/services/${serviceId}`, { token: p.token, body: { basePrice: '15000', depositValue: '5000', terms: { en: 'New terms' } } });
    const row = (await ctx.db.query('SELECT total, upfront_amount, terms_snapshot FROM bookings WHERE id = $1', [b.id])).rows[0];
    expect(row).toMatchObject({ total: '10000.0000', upfront_amount: '2000.0000', terms_snapshot: { service: { en: 'Original terms' } } });
    await expect(ctx.db.query(`UPDATE bookings SET total = 1 WHERE id = $1`, [b.id])).rejects.toThrow(/immutable/);
  });
});

describe('temporary hold expiry and late payment (tests 9, 17-18)', () => {
  it('expires an unpaid booking, frees the slot, and re-checks on a late payment', async () => {
    const { serviceId } = await liveService(hallType, { basePrice: '3000', pricingUnit: 'fixed', capacity: 100, requiresProviderApproval: false });
    const c = await customer();
    const date = nextDate();
    const b = (await book(c.token, { serviceId, date })).bookings[0];

    // Warning shortly before expiry, only once.
    await ctx.db.query(`UPDATE bookings SET hold_expires_at = now() + interval '2 minutes' WHERE id = $1`, [b.id]);
    await warnExpiringHolds(ctx.db);
    await warnExpiringHolds(ctx.db);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM message_outbox WHERE channel <> 'web' AND recipient_user_id = $1 AND template_key = 'booking.hold_expiring'`, [c.userId])).rows[0].n).toBe(1);

    await ctx.db.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [b.id]);
    await ctx.db.query(`UPDATE calendar_blocks SET expires_at = now() - interval '1 second' WHERE booking_ref = $1`, [b.id]);
    expect(await expireBookings(ctx.db)).toBeGreaterThanOrEqual(1);
    const exp = (await api(ctx, 'GET', `/v1/bookings/${b.id}`, { token: c.token })).body;
    expect(exp.status).toBe('expired');
    expect(exp.history.at(-1)).toMatchObject({ to: 'expired', actorKind: 'system', reason: 'payment not completed in time' });

    // Payment notice arrives late but the slot is still free: confirmed after re-checking.
    await pay(b.id);
    expect((await api(ctx, 'GET', `/v1/bookings/${b.id}`, { token: c.token })).body.status).toBe('confirmed');
    // A duplicate notice for the same booking does not confirm twice.
    await expect(pay(b.id)).rejects.toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
  });

  it('rejects a late payment when someone else took the slot', async () => {
    const { serviceId } = await liveService(hallType, { basePrice: '3000', pricingUnit: 'fixed', capacity: 100, requiresProviderApproval: false });
    const date = nextDate();
    const b = (await book((await customer()).token, { serviceId, date })).bookings[0];
    await ctx.db.query(`UPDATE bookings SET hold_expires_at = now() - interval '1 second' WHERE id = $1`, [b.id]);
    await ctx.db.query(`UPDATE calendar_blocks SET expires_at = now() - interval '1 second' WHERE booking_ref = $1`, [b.id]);
    await expireBookings(ctx.db);
    await book((await customer()).token, { serviceId, date });
    await expect(pay(b.id)).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  });
});

describe('cancellation and execution (clause 31)', () => {
  it('cancels one unpaid booking without touching the rest of the order', async () => {
    const hall = await liveService(hallType, { basePrice: '1000', pricingUnit: 'fixed', capacity: 100, requiresProviderApproval: false });
    const photo = await liveService(slotType, { basePrice: '100', pricingUnit: 'per_hour' });
    const c = await customer();
    const date = nextDate();
    await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId: hall.serviceId, date } });
    await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId: photo.serviceId, startAt: `${date}T10:00:00+03:00` } });
    const order = (await checkoutReq(c.token)).body;
    const [first, second] = order.bookings;
    expect((await api(ctx, 'POST', `/v1/bookings/${first.id}/cancel`, { token: c.token, body: { reason: 'Changed plans' } })).body.status).toBe('cancelled_by_customer');
    const o = (await api(ctx, 'GET', `/v1/orders/${order.id}`, { token: c.token })).body;
    expect(o.status).toBe('active');
    expect(o.bookings.find((b: { id: string }) => b.id === second.id).status).toBe('awaiting_payment');

    await pay(second.id);
    expect((await api(ctx, 'POST', `/v1/bookings/${second.id}/cancel`, { token: c.token, body: { reason: 'Changed plans' } })).body.error.code).toBe('CANCELLATION_REQUIRES_REFUND_FLOW');
  });

  it('lets the provider complete a started booking, closing the order', async () => {
    const { p, serviceId } = await liveService(hallType, { basePrice: '1000', pricingUnit: 'fixed', capacity: 100, requiresProviderApproval: false });
    const c = await customer();
    const order = await book(c.token, { serviceId, date: nextDate() });
    const b = order.bookings[0];
    await pay(b.id);
    expect((await api(ctx, 'POST', `/v1/provider/bookings/${b.id}/complete`, { token: p.token })).body.error.code).toBe('INVALID_STATUS_TRANSITION');
    await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '2 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [b.id]);
    expect((await api(ctx, 'POST', `/v1/provider/bookings/${b.id}/complete`, { token: p.token })).body.status).toBe('completed');
    expect((await api(ctx, 'GET', `/v1/orders/${order.id}`, { token: c.token })).body.status).toBe('completed');
  });
});

describe('events and budget (clauses 24-25)', () => {
  it('groups bookings under an event and flags budget overruns per currency', async () => {
    const hall = await liveService(hallType, { basePrice: '15000', pricingUnit: 'fixed', capacity: 300, requiresProviderApproval: false });
    const photo = await liveService(slotType, { basePrice: '2000', pricingUnit: 'per_hour' });
    const c = await customer();
    const date = nextDate();
    const ev = await api(ctx, 'POST', '/v1/events', { token: c.token, body: { name: 'Our wedding', eventType: 'wedding', countryCode: country.code, city: 'Riyadh', eventDate: date, expectedGuests: 250, budgetAmount: '18000', budgetCurrency: 'SAR' } });
    expect(ev.status).toBe(201);
    await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId: hall.serviceId, date, eventId: ev.body.id } });
    await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId: photo.serviceId, startAt: `${date}T20:00:00+03:00`, eventId: ev.body.id } });
    await checkoutReq(c.token);

    const e = (await api(ctx, 'GET', `/v1/events/${ev.body.id}`, { token: c.token })).body;
    expect(e.status).toBe('planning');
    expect(e.bookings).toHaveLength(2);
    expect(e.budget).toMatchObject({ amount: '18000.0000', committed: '19000.0000', remaining: '-1000.0000', overBudget: true, otherCurrencies: [] });
    expect((await ctx.db.query(`SELECT 1 FROM message_outbox WHERE channel <> 'web' AND recipient_user_id = $1 AND template_key = 'event.budget_exceeded'`, [c.userId])).rowCount).toBe(1);

    const other = await customer();
    expect((await api(ctx, 'GET', `/v1/events/${ev.body.id}`, { token: other.token })).status).toBe(404);
    await api(ctx, 'POST', '/v1/cart/items', { token: other.token, body: { serviceId: hall.serviceId, date: nextDate(), eventId: ev.body.id } }).then((r) => expect(r.body.error.code).toBe('EVENT_NOT_FOUND'));
  });
});

describe('who sees what', () => {
  it('limits provider access and reveals the customer phone only after confirmation', async () => {
    const { p, serviceId } = await liveService(hallType, { basePrice: '1000', pricingUnit: 'fixed', capacity: 100 });
    const c = await customer();
    const b = (await book(c.token, { serviceId, date: nextDate() })).bookings[0];
    const before = (await api(ctx, 'GET', `/v1/provider/bookings/${b.id}`, { token: p.token })).body;
    expect(before).toMatchObject({ customerName: 'Test User', customerPhone: null });
    await api(ctx, 'POST', `/v1/provider/bookings/${b.id}/accept`, { token: p.token });
    await pay(b.id);
    expect((await api(ctx, 'GET', `/v1/provider/bookings/${b.id}`, { token: p.token })).body.customerPhone).toBe(c.phone);

    const other = await approvedProvider(ctx, supervisor.token, country.code);
    expect((await api(ctx, 'GET', `/v1/provider/bookings/${b.id}`, { token: other.token })).status).toBe(404);
    expect((await api(ctx, 'POST', `/v1/provider/bookings/${b.id}/accept`, { token: other.token })).status).toBe(404);
    expect((await api(ctx, 'GET', `/v1/bookings/${b.id}`, { token: (await customer()).token })).status).toBe(404);

    const agent = await createStaff(ctx, [{ code: 'bookings_agent', countryId: country.id }]);
    expect((await api(ctx, 'GET', `/v1/admin/bookings/${b.id}`, { token: agent.token })).body.customerPhone).toBe(c.phone);
    const foreign = await createStaff(ctx, [{ code: 'bookings_agent', countryId: (await setupCountry(ctx, admin.token, '+971')).id }]);
    expect((await api(ctx, 'GET', `/v1/admin/bookings/${b.id}`, { token: foreign.token })).status).toBe(404);
    expect((await api(ctx, 'GET', `/v1/admin/bookings?q=${b.number}`, { token: agent.token })).body).toHaveLength(1);
  });
});
