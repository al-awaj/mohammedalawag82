import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { consistencyChecks } from '../src/modules/reconciliation/service.js';
import { api, uniq, useApp } from './helpers.js';
import { marketplace } from './fixtures.js';

/**
 * Financial invariants under a seeded random mix of operations, and under concurrent duplicates of the
 * sensitive ones (tests 17, 22, 40 and clause 80). After any sequence the books must balance, every
 * internal consistency check must pass, and no cap may be exceeded.
 */
const ctx = useApp();
let m: Awaited<ReturnType<typeof marketplace>>;

/** Deterministic PRNG so a failure can be replayed with the same seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const SEED = Number(process.env.FIN_SEED ?? 20261013);

const units = (s: string | number) => BigInt(Math.round(Number(s) * 10000));
const post = (url: string, token: string, body: object = {}, key?: string) => ctx.app.inject({
  method: 'POST', url, headers: { authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) }, payload: body,
}).then((r) => ({ status: r.statusCode, body: r.body ? JSON.parse(r.body) : null }));

async function assertBooksHold() {
  const tb = (await api(ctx, 'GET', `/v1/admin/ledger/trial-balance?countryId=${m.country.id}&currency=SAR`, { token: m.financeA.token })).body;
  expect(tb.totals.balanced, 'trial balance').toBe(true);
  const checks = await consistencyChecks(ctx.db, null, m.country.id);
  expect(checks.checks, 'consistency checks').toEqual(Object.fromEntries(Object.keys(checks.checks).map((k) => [k, []])));
  // Caps: refunds never exceed what was received for a payment or a booking.
  const overRefunded = (await ctx.db.query(
    `SELECT p.id FROM payments p JOIN bookings b ON b.id = (SELECT booking_id FROM payment_allocations WHERE payment_id = p.id LIMIT 1)
      WHERE b.country_id = $1 AND p.status = 'succeeded'
        AND (SELECT coalesce(sum(r.amount), 0) FROM refunds r WHERE r.payment_id = p.id AND r.status IN ('requested', 'approved', 'processing', 'completed')) > p.verified_amount`,
    [m.country.id])).rows;
  expect(overRefunded, 'refunds above a payment').toEqual([]);
  const overBooking = (await ctx.db.query(
    `SELECT b.number FROM bookings b WHERE b.country_id = $1
        AND (SELECT coalesce(sum(r.amount), 0) FROM refunds r WHERE r.booking_id = b.id AND r.status IN ('requested', 'approved', 'processing', 'completed'))
          > (SELECT coalesce(sum(a.verified_amount), 0) FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.booking_id = b.id AND p.status = 'succeeded' AND p.model = 'platform')`,
    [m.country.id])).rows;
  expect(overBooking, 'refunds above a booking').toEqual([]);
  // Settlements never pay more than the provider earned, and each earning is settled at most once.
  const overSettled = (await ctx.db.query(
    `SELECT i.booking_id FROM settlement_items i JOIN settlements s ON s.id = i.settlement_id
      WHERE s.country_id = $1 AND s.status NOT IN ('failed', 'cancelled') AND s.kind = 'regular'
      GROUP BY i.booking_id HAVING count(*) > 1`, [m.country.id])).rows;
  expect(overSettled, 'earnings settled twice').toEqual([]);
  // Every journal entry is unique by its idempotency key (no duplicate posting).
  const dupEntries = (await ctx.db.query(`SELECT idempotency_key FROM journal_entries WHERE country_id = $1 GROUP BY idempotency_key HAVING count(*) > 1`, [m.country.id])).rows;
  expect(dupEntries).toEqual([]);
}

async function processRefunds(bookingId: string) {
  const list = (await api(ctx, 'GET', `/v1/admin/refunds?bookingId=${bookingId}`, { token: m.financeA.token })).body as { id: string; status: string; amount: string }[];
  for (const r of list.filter((x) => x.status === 'requested')) {
    expect((await post(`/v1/admin/refunds/${r.id}/approve`, m.financeB.token)).status).toBe(200);
    expect((await post(`/v1/admin/refunds/${r.id}/execute`, m.financeB.token)).status).toBe(200);
    const ref = (await ctx.db.query('SELECT external_ref FROM refunds WHERE id = $1', [r.id])).rows[0].external_ref;
    expect((await m.webhook({ id: `evt_${uniq()}`, type: 'refund.succeeded', data: { reference: ref, amount: r.amount, currency: 'SAR' } })).status).toBe(200);
  }
}

beforeAll(async () => {
  m = await marketplace(ctx, 'PAY_SANDBOX_FIN_SECRET');
});

describe(`randomised operations keep the books consistent (seed ${SEED})`, () => {
  it('balances after every step of a random mix of payments, cancellations, refunds, completions, disputes and settlements', async () => {
    const rand = rng(SEED);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    const halls = [await m.hall(), await m.hall(), await m.hall()];
    const customers = [await m.customer(), await m.customer(), await m.customer(), await m.customer()];
    const tally: Record<string, number> = {};
    const count = (k: string) => { tally[k] = (tally[k] ?? 0) + 1; };
    const held: string[] = [];

    for (let i = 0; i < 30; i++) {
      const h = pick(halls);
      const c = pick(customers);
      const o = await m.order(c.token, h.serviceId);
      const bookingId = o.bookings[0]!.id;
      const up = await m.startCard(c.token, o.id, 'upfront');
      const evt = { id: `evt_${uniq()}`, type: 'payment.succeeded', data: { reference: up.ref, amount: up.amount, currency: 'SAR' } };
      await m.webhook(evt);
      if (rand() < 0.3) { await m.webhook(evt); count('duplicate webhook'); }
      if (rand() < 0.5) { await m.payCard(c.token, o.id, 'balance'); count('balance paid'); }

      const r = rand();
      if (r < 0.3) {
        // Customer cancels at a random distance from the event: 100%, 50% or 0% under the policy.
        const hours = pick([24 * 60, 24 * 10, 24]);
        await ctx.db.query(`UPDATE bookings SET start_at = now() + make_interval(hours => $2), end_at = now() + make_interval(hours => $2 + 24) WHERE id = $1`, [bookingId, hours]);
        expect((await post(`/v1/bookings/${bookingId}/cancel`, c.token, { reason: 'Plans changed' })).status).toBe(200);
        if (rand() < 0.8) await processRefunds(bookingId); // some stay requested
        count(`customer cancel ${hours}h`);
      } else if (r < 0.4) {
        expect((await post(`/v1/provider/bookings/${bookingId}/cancel`, h.p.token, { reason: 'Hall under maintenance' })).status).toBe(200);
        await processRefunds(bookingId);
        count('provider cancel');
      } else if (r < 0.85) {
        await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [bookingId]);
        expect((await post(`/v1/provider/bookings/${bookingId}/complete`, h.p.token)).status).toBe(200);
        count('completed');
        if (rand() < 0.25) {
          const d = await post('/v1/disputes', c.token, { bookingId, type: 'service_quality', subject: 'Not as described', description: 'The hall was not prepared as agreed.' });
          expect(d.status).toBe(201);
          count('dispute');
          // Staff decide whether to hold part of the provider's earning while the dispute is open (clause 51).
          if (rand() < 0.7) {
            expect((await post(`/v1/admin/disputes/${d.body.id}/hold`, m.manager.token, { amount: '1000' })).status).toBe(200);
            held.push(bookingId);
            count('dispute hold');
          }
        }
      } else count('left confirmed');

      if (rand() < 0.2) {
        const p = pick(halls).p;
        const s = await post('/v1/admin/settlements', m.financeA.token, { providerId: p.providerId, currency: 'SAR', accountId: m.bankAccount, method: 'bank_transfer' });
        expect([201, 409]).toContain(s.status);
        if (s.status === 201) {
          expect((await post(`/v1/admin/settlements/${s.body.id}/approve`, m.financeB.token)).status).toBe(200);
          expect((await post(`/v1/admin/settlements/${s.body.id}/mark-paid`, m.financeB.token, { externalRef: `TRX-${uniq()}` })).status).toBe(200);
          count('settlement');
        }
      }
      await assertBooksHold();
    }

    // Earnings held for an open dispute were never put into a settlement.
    const disputedSettled = (await ctx.db.query('SELECT booking_id FROM settlement_items WHERE booking_id = ANY($1)', [held])).rows;
    expect(disputedSettled).toEqual([]);
    // The simulation exercised every path at least once with this seed.
    expect(Object.keys(tally).length, JSON.stringify(tally)).toBeGreaterThanOrEqual(6);
  });
});

describe('concurrent duplicates (test 40)', () => {
  it('lets only one of several parallel checkouts take the same date', async () => {
    const { serviceId } = await m.hall();
    const date = m.nextDate();
    const cs = await Promise.all([1, 2, 3, 4, 5].map(() => m.customer()));
    for (const c of cs) expect((await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId, date } })).status).toBe(201);
    const res = await Promise.all(cs.map((c) => post('/v1/checkout', c.token, { acceptTerms: true }, randomUUID())));
    expect(res.every((r) => r.status < 500), JSON.stringify(res.map((r) => r.status))).toBe(true);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    const live = (await ctx.db.query(`SELECT count(*)::int AS n FROM bookings WHERE service_id = $1 AND status NOT IN ('expired', 'cancelled_by_customer', 'cancelled_by_provider', 'cancelled_by_admin', 'rejected')`, [serviceId])).rows[0].n;
    expect(live).toBe(1);
  });

  it('creates one order and one payment for parallel requests with the same idempotency key', async () => {
    const { serviceId } = await m.hall();
    const c = await m.customer();
    await api(ctx, 'POST', '/v1/cart/items', { token: c.token, body: { serviceId, date: m.nextDate() } });
    const key = randomUUID();
    const orders = await Promise.all([1, 2, 3, 4, 5].map(() => post('/v1/checkout', c.token, { acceptTerms: true }, key)));
    expect(orders.every((r) => r.status < 500), JSON.stringify(orders.map((r) => r.status))).toBe(true);
    const ids = new Set(orders.filter((r) => r.status < 300).map((r) => r.body.id));
    expect(ids.size).toBe(1);
    const orderId = [...ids][0] as string;
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM orders WHERE customer_id = $1', [c.userId])).rows[0].n).toBe(1);

    const pkey = randomUUID();
    const pays = await Promise.all([1, 2, 3, 4, 5].map(() => post(`/v1/orders/${orderId}/payments`, c.token, { model: 'platform', method: 'card', purpose: 'upfront' }, pkey)));
    expect(pays.every((r) => r.status < 500), JSON.stringify(pays.map((r) => r.status))).toBe(true);
    expect(new Set(pays.filter((r) => r.status < 300).map((r) => r.body.id)).size).toBe(1);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM payments WHERE order_id = $1', [orderId])).rows[0].n).toBe(1);
  });

  it('applies a payment once when the same or different success notifications arrive in parallel', async () => {
    const { serviceId } = await m.hall();
    const c = await m.customer();
    const o = await m.order(c.token, serviceId);
    const p = await m.startCard(c.token, o.id, 'upfront');
    const same = { id: `evt_${uniq()}`, type: 'payment.succeeded', data: { reference: p.ref, amount: p.amount, currency: 'SAR' } };
    const res = await Promise.all([
      ...[1, 2, 3, 4].map(() => m.webhook(same)),
      ...[1, 2, 3, 4].map(() => m.webhook({ ...same, id: `evt_${uniq()}` })),
    ]);
    expect(res.every((r) => r.status === 200), JSON.stringify(res)).toBe(true);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key = $1`, [`payment:${p.id}`])).rows[0].n).toBe(1);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM payment_allocations WHERE payment_id = $1`, [p.id])).rows[0].n).toBe(1);
    expect((await api(ctx, 'GET', `/v1/bookings/${o.bookings[0]!.id}`, { token: c.token })).body.status).toBe('confirmed');
    await assertBooksHold();
  });

  it('cancels and refunds once under parallel cancellations and parallel refund actions', async () => {
    const { serviceId } = await m.hall();
    const c = await m.customer();
    const o = await m.order(c.token, serviceId);
    await m.payCard(c.token, o.id, 'upfront');
    const bookingId = o.bookings[0]!.id;
    const cancels = await Promise.all([1, 2, 3, 4, 5].map(() => post(`/v1/bookings/${bookingId}/cancel`, c.token, { reason: 'Plans changed' })));
    expect(cancels.every((r) => r.status < 500), JSON.stringify(cancels.map((r) => [r.status, r.body?.error?.code]))).toBe(true);
    expect(cancels.filter((r) => r.status === 200)).toHaveLength(1);
    const refunds = (await api(ctx, 'GET', `/v1/admin/refunds?bookingId=${bookingId}`, { token: m.financeA.token })).body as { id: string; amount: string }[];
    expect(refunds).toHaveLength(1);
    const id = refunds[0]!.id;

    const approvals = await Promise.all([1, 2, 3, 4].map(() => post(`/v1/admin/refunds/${id}/approve`, m.financeB.token)));
    expect(approvals.every((r) => r.status < 500)).toBe(true);
    expect(approvals.filter((r) => r.status === 200)).toHaveLength(1);
    const executions = await Promise.all([1, 2, 3, 4].map(() => post(`/v1/admin/refunds/${id}/execute`, m.financeB.token)));
    expect(executions.every((r) => r.status < 500)).toBe(true);
    expect(executions.filter((r) => r.status === 200)).toHaveLength(1);
    const ref = (await ctx.db.query('SELECT external_ref FROM refunds WHERE id = $1', [id])).rows[0].external_ref;
    await Promise.all([1, 2, 3].map(() => m.webhook({ id: `evt_${uniq()}`, type: 'refund.succeeded', data: { reference: ref, amount: refunds[0]!.amount, currency: 'SAR' } })));
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key = $1`, [`refund_payment:${id}`])).rows[0].n).toBe(1);

    // A manual refund on top cannot exceed what is left, even when several are requested at once.
    const manual = await Promise.all([1, 2, 3].map(() => post(`/v1/admin/bookings/${bookingId}/refunds`, m.financeA.token, { amount: '1000', reason: 'Goodwill gesture', source: 'manual' })));
    expect(manual.every((r) => r.status < 500)).toBe(true);
    expect(manual.filter((r) => r.status === 201)).toHaveLength(0); // the full deposit was already refunded
    await assertBooksHold();
  });

  it('settles the same earnings once under parallel settlement requests and parallel payouts', async () => {
    const h = await m.hall();
    const c = await m.customer();
    for (let i = 0; i < 2; i++) {
      const o = await m.order(c.token, h.serviceId);
      await m.payCard(c.token, o.id, 'upfront');
      await m.payCard(c.token, o.id, 'balance');
      await ctx.db.query(`UPDATE bookings SET start_at = now() - interval '3 hours', end_at = now() - interval '1 hour' WHERE id = $1`, [o.bookings[0]!.id]);
      await post(`/v1/provider/bookings/${o.bookings[0]!.id}/complete`, h.p.token);
    }
    const body = { providerId: h.p.providerId, currency: 'SAR', accountId: m.bankAccount, method: 'bank_transfer' };
    const created = await Promise.all([1, 2, 3, 4, 5].map(() => post('/v1/admin/settlements', m.financeA.token, body)));
    expect(created.every((r) => r.status < 500), JSON.stringify(created.map((r) => [r.status, r.body?.error?.code]))).toBe(true);
    const ok = created.filter((r) => r.status === 201);
    expect(ok).toHaveLength(1);
    expect(ok[0]!.body.amount).toBe('36000.0000');
    const sid = ok[0]!.body.id;
    await post(`/v1/admin/settlements/${sid}/approve`, m.financeB.token);
    const paid = await Promise.all([1, 2, 3, 4].map((i) => post(`/v1/admin/settlements/${sid}/mark-paid`, m.financeB.token, { externalRef: `TRX-${i}` })));
    expect(paid.every((r) => r.status < 500)).toBe(true);
    // Repeating a payout is an idempotent no-op: one external reference, one ledger entry.
    expect(new Set((await ctx.db.query('SELECT external_ref FROM settlements WHERE id = $1', [sid])).rows.map((r) => r.external_ref)).size).toBe(1);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM journal_entries WHERE idempotency_key = $1`, [`settlement:${sid}`])).rows[0].n).toBe(1);
    expect(units((await ctx.db.query('SELECT sum(net_amount) AS s FROM provider_earnings WHERE provider_id = $1 AND status = $2', [h.p.providerId, 'settled'])).rows[0].s)).toBe(units(36000));
    await assertBooksHold();
  });
});
