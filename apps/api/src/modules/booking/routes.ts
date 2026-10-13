import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, assertCan, can, countryScope, requireKind, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx, type Executor } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { fromUnits, toUnits } from '../../lib/money.js';
import { idParams, paginationQuery, reasonSchema } from '../common.js';
import { providerOf } from '../catalog/shared.js';
import { identityVisible } from '../catalog/queries.js';
import { itemInput, quote } from './pricing.js';
import { addToCart, checkout, OCCUPYING, previewCoupon, providerDecision, providerExecution, viewCart } from './service.js';
import { cancelBooking, decideCancellationRequest, markNoShow, quoteCancellation } from './cancellation.js';

const sec = [{ bearer: [] }];
const STATUSES = ['pending_provider_approval', 'awaiting_payment', 'confirmed', 'in_progress', 'completed', 'no_show', 'rejected', 'expired',
  'cancelled_by_customer', 'cancelled_by_provider', 'cancelled_by_admin'] as const;

const eventFields = z.object({
  name: z.string().trim().min(2).max(200),
  eventType: z.enum(['wedding', 'engagement', 'birthday', 'graduation', 'success', 'family', 'conference', 'official', 'religious', 'social', 'other']),
  countryCode: z.string().length(2).toUpperCase(),
  city: z.string().trim().min(2).max(100),
  location: z.string().trim().max(500).nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  eventDate: z.iso.date(),
  startsAt: z.iso.datetime({ offset: true }).nullable(),
  endsAt: z.iso.datetime({ offset: true }).nullable(),
  expectedGuests: z.number().int().positive().max(1_000_000).nullable(),
  budgetAmount: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/).nullable(),
  budgetCurrency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  notes: z.string().trim().max(5000).nullable(),
  status: z.enum(['planning', 'confirmed', 'completed', 'cancelled']),
});
const eventCreate = eventFields.omit({ status: true }).extend({
  location: eventFields.shape.location.default(null), latitude: eventFields.shape.latitude.default(null), longitude: eventFields.shape.longitude.default(null),
  startsAt: eventFields.shape.startsAt.default(null), endsAt: eventFields.shape.endsAt.default(null), expectedGuests: eventFields.shape.expectedGuests.default(null),
  budgetAmount: eventFields.shape.budgetAmount.default(null), budgetCurrency: eventFields.shape.budgetCurrency.default(null), notes: eventFields.shape.notes.default(null),
});

/** Booking as seen by each party. Providers get the customer's phone only once the booking is confirmed (data minimisation). */
function bookingSelect(audience: 'customer' | 'provider' | 'staff') {
  const customerContact = audience === 'staff' ? `cu.full_name AS "customerName", cu.phone AS "customerPhone", cu.email AS "customerEmail"`
    : audience === 'provider' ? `cu.full_name AS "customerName",
        CASE WHEN b.status IN ('confirmed', 'in_progress', 'completed') THEN cu.phone END AS "customerPhone"`
    : `NULL AS "customerName"`;
  return `SELECT b.id, b.number, b.order_id AS "orderId", o.number AS "orderNumber", b.status, b.service_id AS "serviceId", b.service_title AS "serviceTitle",
      b.package_id AS "packageId", b.package_name AS "packageName", b.rental_item_id AS "rentalItemId", b.event_id AS "eventId",
      b.start_at AS "startAt", b.end_at AS "endAt", b.units, b.guests, b.pricing_unit AS "pricingUnit", b.unit_price AS "unitPrice",
      b.quantity_factor AS "quantityFactor", b.add_ons AS "addOns", b.subtotal, b.total, b.currency_code AS currency,
      b.deposit_type AS "depositType", b.deposit_value AS "depositValue", b.upfront_amount AS "upfrontAmount", b.balance_due_at AS "balanceDueAt",
      b.security_deposit_amount AS "securityDepositAmount", b.cancellation_policy AS "cancellationPolicy", b.terms_snapshot AS "termsSnapshot",
      b.requires_provider_approval AS "requiresProviderApproval", b.hold_expires_at AS "holdExpiresAt", b.approval_deadline AS "approvalDeadline",
      b.discount_amount AS "discountAmount", b.discount_platform_borne AS "discountPlatformBorne", b.discount_provider_borne AS "discountProviderBorne",
      b.decision_reason AS "decisionReason", b.customer_notes AS "customerNotes", b.created_at AS "createdAt",
      pd.paid AS "paidAmount", (b.total - pd.paid::numeric)::numeric(20,4)::text AS "remainingAmount",
      p.business_name AS "providerName", p.show_identity AS "_showIdentity", b.country_id AS "_countryId",
      ${customerContact}
    FROM bookings b JOIN orders o ON o.id = b.order_id JOIN providers p ON p.id = b.provider_id JOIN users cu ON cu.id = b.customer_id
    CROSS JOIN LATERAL (SELECT coalesce(sum(a.verified_amount), 0)::numeric(20,4)::text AS paid FROM payment_allocations a
                          JOIN payments py ON py.id = a.payment_id WHERE a.booking_id = b.id AND py.status = 'succeeded') pd`;
}

type Row = Record<string, unknown> & { _showIdentity?: boolean; _countryId?: string };

/** Drops internal helper columns. */
function strip(r: Row) {
  const { _showIdentity: _s, _countryId: _c, ...rest } = r;
  return rest;
}

/** Customers see the provider's name only where public identity is allowed (clause 68). */
async function forCustomer(exec: Executor, rows: Row[]) {
  const cache = new Map<string, boolean>();
  const out = [];
  for (const r of rows) {
    const country = r._countryId!;
    if (!cache.has(country)) cache.set(country, await identityVisible(exec, country, true));
    out.push({ ...strip(r), providerName: cache.get(country) && r._showIdentity ? r.providerName : null });
  }
  return out;
}

async function bookingHistory(exec: Executor, id: string) {
  return (await exec.query(
    `SELECT from_status AS "from", to_status AS "to", actor_kind AS "actorKind", reason, created_at AS at FROM booking_status_events
      WHERE booking_id = $1 ORDER BY created_at, id`, [id])).rows;
}

/** Totals per currency so amounts in different currencies are never summed together. */
function totalsByCurrency(rows: { currency: string; total: string; upfrontAmount: string; paidAmount: string; status: string }[]) {
  const acc: Record<string, { committed: bigint; upfront: bigint; paid: bigint; count: number }> = {};
  for (const r of rows) {
    if (!OCCUPYING.includes(r.status as never) && r.status !== 'completed') continue;
    const t = (acc[r.currency] ??= { committed: 0n, upfront: 0n, paid: 0n, count: 0 });
    t.committed += toUnits(r.total);
    t.upfront += toUnits(r.upfrontAmount);
    t.paid += toUnits(r.paidAmount);
    t.count++;
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, {
    committedTotal: fromUnits(v.committed), upfrontTotal: fromUnits(v.upfront), paidTotal: fromUnits(v.paid),
    remainingTotal: fromUnits(v.committed - v.paid), bookings: v.count,
  }]));
}

export async function bookingRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const customer = { onRequest: deps.authenticate, preValidation: requireKind('customer') };
  const provider = { onRequest: deps.authenticate, preValidation: requireKind('provider') };

  // ---------------- Events (clauses 24-25) ----------------
  app.post('/events', { ...customer, schema: { tags: ['events'], security: sec, body: eventCreate } }, async (req, reply) => {
    const b = req.body;
    if ((b.budgetAmount === null) !== (b.budgetCurrency === null)) throw badRequest('VALIDATION_FAILED', [{ path: '/budgetCurrency', message: 'budgetAmount and budgetCurrency go together' }]);
    const id = await withTx(db, async (c) => {
      const country = (await c.query<{ id: string }>('SELECT id FROM countries WHERE code = $1 AND is_active', [b.countryCode])).rows[0];
      if (!country) throw badRequest('COUNTRY_NOT_AVAILABLE');
      const eventId = (await c.query<{ id: string }>(
        `INSERT INTO events (customer_id, name, event_type, country_id, city, location, latitude, longitude, event_date, starts_at, ends_at,
           expected_guests, budget_amount, budget_currency, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [requireUser(req).id, b.name, b.eventType, country.id, b.city, b.location, b.latitude, b.longitude, b.eventDate, b.startsAt, b.endsAt,
          b.expectedGuests, b.budgetAmount, b.budgetCurrency, b.notes])).rows[0]!.id;
      await audit(c, actorOf(req), { action: 'event.created', entityType: 'event', entityId: eventId, after: b });
      return eventId;
    });
    return reply.status(201).send({ id });
  });

  app.get('/events', { ...customer, schema: { tags: ['events'], security: sec } }, async (req) =>
    (await db.query(
      `SELECT e.id, e.name, e.event_type AS "eventType", e.city, e.event_date AS "eventDate", e.status,
              (SELECT count(*)::int FROM bookings b WHERE b.event_id = e.id) AS "bookingCount"
         FROM events e WHERE e.customer_id = $1 ORDER BY e.event_date`, [requireUser(req).id])).rows);

  app.get('/events/:id', { ...customer, schema: { tags: ['events'], security: sec, params: idParams } }, async (req) => {
    const e = (await db.query(
      `SELECT e.id, e.name, e.event_type AS "eventType", co.code AS "countryCode", e.city, e.location, e.latitude, e.longitude,
              e.event_date AS "eventDate", e.starts_at AS "startsAt", e.ends_at AS "endsAt", e.expected_guests AS "expectedGuests",
              e.budget_amount AS "budgetAmount", e.budget_currency AS "budgetCurrency", e.notes, e.status, e.created_at AS "createdAt"
         FROM events e JOIN countries co ON co.id = e.country_id WHERE e.id = $1 AND e.customer_id = $2`, [req.params.id, requireUser(req).id])).rows[0];
    if (!e) throw notFound();
    const bookings = (await db.query(`${bookingSelect('customer')} WHERE b.event_id = $1 ORDER BY b.start_at`, [e.id])).rows as { id: string; number: string; status: string; serviceTitle: unknown; startAt: Date; total: string; upfrontAmount: string; paidAmount: string; remainingAmount: string; currency: string }[];
    const totals = totalsByCurrency(bookings);
    const inBudgetCurrency = e.budgetCurrency ? totals[e.budgetCurrency] : undefined;
    return {
      ...e,
      // The event status is independent from each booking's status (clause 25).
      bookings: bookings.map((b) => ({ id: b.id, number: b.number, status: b.status, serviceTitle: b.serviceTitle, startAt: b.startAt, total: b.total,
        upfrontAmount: b.upfrontAmount, paidAmount: b.paidAmount, remainingAmount: b.remainingAmount, currency: b.currency })),
      totals,
      budget: e.budgetAmount ? {
        amount: e.budgetAmount, currency: e.budgetCurrency,
        committed: inBudgetCurrency?.committedTotal ?? '0.0000',
        remaining: fromUnits(toUnits(e.budgetAmount) - toUnits(inBudgetCurrency?.committedTotal ?? '0')),
        overBudget: toUnits(inBudgetCurrency?.committedTotal ?? '0') > toUnits(e.budgetAmount),
        // Bookings in other currencies are listed in `totals` and not converted implicitly.
        otherCurrencies: Object.keys(totals).filter((k) => k !== e.budgetCurrency),
      } : null,
    };
  });

  app.patch('/events/:id', { ...customer, schema: { tags: ['events'], security: sec, params: idParams, body: eventFields.omit({ countryCode: true }).partial() } }, async (req) => {
    const b = req.body;
    return withTx(db, async (c) => {
      const before = (await c.query('SELECT * FROM events WHERE id = $1 AND customer_id = $2 FOR UPDATE', [req.params.id, requireUser(req).id])).rows[0];
      if (!before) throw notFound();
      const has = (k: string) => Object.hasOwn(b, k);
      const cols: Record<string, string> = { name: 'name', eventType: 'event_type', city: 'city', location: 'location', latitude: 'latitude', longitude: 'longitude',
        eventDate: 'event_date', startsAt: 'starts_at', endsAt: 'ends_at', expectedGuests: 'expected_guests', budgetAmount: 'budget_amount',
        budgetCurrency: 'budget_currency', notes: 'notes', status: 'status' };
      const sets: string[] = [];
      const params: unknown[] = [req.params.id];
      for (const [k, col] of Object.entries(cols)) {
        if (!has(k)) continue;
        params.push((b as Record<string, unknown>)[k]);
        sets.push(`${col} = $${params.length}`);
      }
      if (sets.length) {
        try {
          await c.query(`UPDATE events SET ${sets.join(', ')} WHERE id = $1`, params);
        } catch (err) {
          if ((err as { code?: string }).code === '23514') throw badRequest('VALIDATION_FAILED', [{ path: '/', message: 'budget amount/currency and start/end must be consistent' }]);
          throw err;
        }
      }
      await audit(c, actorOf(req), { action: 'event.updated', entityType: 'event', entityId: req.params.id, before, after: b });
      return { id: req.params.id };
    });
  });

  // ---------------- Quote, cart and checkout (clause 30) ----------------
  app.post('/quote', { schema: { tags: ['cart'], body: itemInput } }, async (req) => {
    const q = await quote(db, req.body);
    const { providerId: _p, countryId: _c, maxBookingsPerSlot: _m, serviceTypeId: _t, ...pub } = q;
    return pub;
  });

  app.get('/cart', { ...customer, schema: { tags: ['cart'], security: sec } }, async (req) => viewCart(db, requireUser(req).id));

  app.post('/cart/items', { ...customer, schema: { tags: ['cart'], security: sec, body: itemInput } }, async (req, reply) => {
    const r = await addToCart(db, requireUser(req).id, req.body, actorOf(req));
    return reply.status(201).send({ id: r.id, total: r.quote.total, currency: r.quote.currency, upfrontAmount: r.quote.upfrontAmount });
  });

  app.post('/cart/coupon', {
    ...customer, schema: { tags: ['cart'], security: sec, body: z.object({ code: z.string().trim().min(3).max(30), itemIds: z.array(z.uuid()).max(50).optional() }) },
  }, async (req) => previewCoupon(db, requireUser(req).id, req.body.code, req.body.itemIds));

  app.delete('/cart/items/:id', { ...customer, schema: { tags: ['cart'], security: sec, params: idParams } }, async (req, reply) => {
    const r = await db.query('DELETE FROM cart_items WHERE id = $1 AND customer_id = $2', [req.params.id, requireUser(req).id]);
    if (!r.rowCount) throw notFound();
    return reply.status(204).send();
  });

  app.post('/checkout', {
    ...customer,
    schema: {
      tags: ['cart'], security: sec,
      headers: z.object({ 'idempotency-key': z.string().min(8).max(100).optional() }).passthrough(),
      body: z.object({ itemIds: z.array(z.uuid()).min(1).max(50).optional(), acceptTerms: z.boolean(), couponCode: z.string().trim().max(30).optional() }),
    },
  }, async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string') throw badRequest('IDEMPOTENCY_KEY_REQUIRED');
    const r = await checkout(db, requireUser(req).id, { itemIds: req.body.itemIds, acceptTerms: req.body.acceptTerms, idempotencyKey: key, couponCode: req.body.couponCode }, actorOf(req));
    const order = await loadOrder(db, r.orderId, 'customer');
    return reply.status(r.replayed ? 200 : 201).send(order);
  });

  async function loadOrder(exec: Executor, id: string, audience: 'customer' | 'staff') {
    const o = (await exec.query(
      `SELECT o.id, o.number, o.customer_id AS "customerId", o.event_id AS "eventId", o.country_id AS "countryId", o.currency_code AS currency,
              o.subtotal, o.total, o.upfront_total AS "upfrontTotal", o.status, o.created_at AS "createdAt"
         FROM orders o WHERE o.id = $1`, [id])).rows[0];
    if (!o) return null;
    const rows = (await exec.query(`${bookingSelect(audience)} WHERE b.order_id = $1 ORDER BY b.start_at`, [id])).rows;
    o.bookings = audience === 'customer' ? await forCustomer(exec, rows) : rows.map(strip);
    return o;
  }

  // ---------------- Customer bookings ----------------
  app.get('/orders/:id', { ...customer, schema: { tags: ['bookings'], security: sec, params: idParams } }, async (req) => {
    const o = await loadOrder(db, req.params.id, 'customer');
    if (!o || o.customerId !== requireUser(req).id) throw notFound();
    return o;
  });

  app.get('/bookings', {
    ...customer,
    schema: { tags: ['bookings'], security: sec, querystring: paginationQuery.extend({ when: z.enum(['upcoming', 'past', 'all']).default('all'), status: z.enum(STATUSES).optional() }) },
  }, async (req) => {
    const q = req.query;
    return forCustomer(db, (await db.query(
      `${bookingSelect('customer')} WHERE b.customer_id = $1 AND ($2::text IS NULL OR b.status = $2)
         AND ($3 = 'all' OR ($3 = 'upcoming' AND b.end_at > now()) OR ($3 = 'past' AND b.end_at <= now()))
       ORDER BY b.start_at ${q.when === 'past' ? 'DESC' : 'ASC'} LIMIT $4 OFFSET $5`,
      [requireUser(req).id, q.status ?? null, q.when, q.limit, q.offset])).rows);
  });

  app.get('/bookings/:id', { ...customer, schema: { tags: ['bookings'], security: sec, params: idParams } }, async (req) => {
    const row = (await db.query(`${bookingSelect('customer')} WHERE b.id = $1 AND b.customer_id = $2`, [req.params.id, requireUser(req).id])).rows[0];
    if (!row) throw notFound();
    const [b] = await forCustomer(db, [row]);
    return { ...b, history: await bookingHistory(db, row.id) };
  });

  app.get('/bookings/:id/cancellation-preview', { ...customer, schema: { tags: ['bookings'], security: sec, params: idParams } }, async (req) => {
    const own = await db.query('SELECT 1 FROM bookings WHERE id = $1 AND customer_id = $2', [req.params.id, requireUser(req).id]);
    if (!own.rowCount) throw notFound();
    // Shown before confirming, so the customer sees the policy outcome first (clause 49).
    return quoteCancellation(db, req.params.id, 'customer');
  });

  app.post('/bookings/:id/cancel', { ...customer, schema: { tags: ['bookings'], security: sec, params: idParams, body: z.object({ reason: reasonSchema }) } },
    async (req) => cancelBooking(db, req.params.id, 'customer', req.body.reason, actorOf(req), { customerId: requireUser(req).id }));

  app.get('/bookings/:id/refunds', { ...customer, schema: { tags: ['bookings'], security: sec, params: idParams } }, async (req) => {
    if (!(await db.query('SELECT 1 FROM bookings WHERE id = $1 AND customer_id = $2', [req.params.id, requireUser(req).id])).rowCount) throw notFound();
    return (await db.query(
      `SELECT r.id, r.number, r.amount, r.currency_code AS currency, r.status, r.source, r.reason, r.created_at AS "createdAt", r.executed_at AS "completedAt"
         FROM refunds r JOIN bookings b ON b.id = r.booking_id WHERE r.booking_id = $1 AND b.customer_id = $2 ORDER BY r.created_at`,
      [req.params.id, requireUser(req).id])).rows;
  });

  // ---------------- Provider panel ----------------
  app.get('/provider/bookings', {
    ...provider,
    schema: { tags: ['provider-panel'], security: sec, querystring: paginationQuery.extend({ status: z.enum(STATUSES).optional(), serviceId: z.uuid().optional(), when: z.enum(['upcoming', 'past', 'all']).default('upcoming') }) },
  }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    const q = req.query;
    return (await db.query<Row>(
      `${bookingSelect('provider')} WHERE b.provider_id = $1 AND ($2::text IS NULL OR b.status = $2) AND ($3::uuid IS NULL OR b.service_id = $3)
         AND ($4 = 'all' OR ($4 = 'upcoming' AND b.end_at > now()) OR ($4 = 'past' AND b.end_at <= now()))
       ORDER BY b.start_at LIMIT $5 OFFSET $6`, [p.id, q.status ?? null, q.serviceId ?? null, q.when, q.limit, q.offset])).rows.map(strip);
  });

  app.get('/provider/bookings/:id', { ...provider, schema: { tags: ['provider-panel'], security: sec, params: idParams } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    const b = (await db.query(`${bookingSelect('provider')} WHERE b.id = $1 AND b.provider_id = $2`, [req.params.id, p.id])).rows[0];
    if (!b) throw notFound();
    return { ...strip(b), history: await bookingHistory(db, b.id) };
  });

  app.post('/provider/bookings/:id/accept', { ...provider, schema: { tags: ['provider-panel'], security: sec, params: idParams } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: true });
    return providerDecision(db, p.id, req.params.id, 'accept', null, actorOf(req));
  });

  app.post('/provider/bookings/:id/reject', { ...provider, schema: { tags: ['provider-panel'], security: sec, params: idParams, body: z.object({ reason: reasonSchema }) } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: true });
    return providerDecision(db, p.id, req.params.id, 'reject', req.body.reason, actorOf(req));
  });

  for (const action of ['start', 'complete'] as const) {
    app.post(`/provider/bookings/:id/${action}`, { ...provider, schema: { tags: ['provider-panel'], security: sec, params: idParams } }, async (req) => {
      const p = await providerOf(db, req, { forWrite: true });
      return providerExecution(db, p.id, (req.params as { id: string }).id, action, actorOf(req));
    });
  }

  app.post('/provider/bookings/:id/no-show', { ...provider, schema: { tags: ['provider-panel'], security: sec, params: idParams } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: true });
    return markNoShow(db, p.id, req.params.id, actorOf(req));
  });

  app.post('/provider/bookings/:id/cancel', { ...provider, schema: { tags: ['provider-panel'], security: sec, params: idParams, body: z.object({ reason: reasonSchema }) } }, async (req) => {
    // Allowed even while suspended: cancelling protects the customer and refunds them.
    const p = await providerOf(db, req, { forWrite: false });
    return cancelBooking(db, req.params.id, 'provider', req.body.reason, actorOf(req), { providerId: p.id });
  });

  // ---------------- Admin ----------------
  app.get('/admin/bookings', {
    onRequest: deps.authenticate, preValidation: requirePermission('bookings.view'),
    schema: {
      tags: ['admin:bookings'], security: sec,
      querystring: paginationQuery.extend({ status: z.enum(STATUSES).optional(), providerId: z.uuid().optional(), customerId: z.uuid().optional(),
        serviceId: z.uuid().optional(), from: z.iso.date().optional(), to: z.iso.date().optional(), q: z.string().max(50).optional() }),
    },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'bookings.view');
    const q = req.query;
    // Page on the bookings table first, then build the full rows (paid amounts, names) for that page only.
    const { rows } = await db.query(
      `WITH page AS (
         SELECT b.id, b.start_at FROM bookings b
          WHERE ($1::uuid[] IS NULL OR b.country_id = ANY($1)) AND ($2::text IS NULL OR b.status = $2) AND ($3::uuid IS NULL OR b.provider_id = $3)
            AND ($4::uuid IS NULL OR b.customer_id = $4) AND ($5::uuid IS NULL OR b.service_id = $5)
            AND ($6::date IS NULL OR b.start_at >= $6::date) AND ($7::date IS NULL OR b.start_at < $7::date + 1)
            AND ($8::text IS NULL OR b.number = $8 OR b.order_id IN (SELECT o.id FROM orders o WHERE o.number = $8))
          ORDER BY b.start_at DESC, b.id LIMIT $9 OFFSET $10)
       ${bookingSelect('staff')} JOIN page ON page.id = b.id ORDER BY page.start_at DESC, b.id`,
      [scope, q.status ?? null, q.providerId ?? null, q.customerId ?? null, q.serviceId ?? null, q.from ?? null, q.to ?? null, q.q ?? null, q.limit, q.offset]);
    return rows.map(strip);
  });

  app.get('/admin/bookings/:id', {
    onRequest: deps.authenticate, preValidation: requirePermission('bookings.view'), schema: { tags: ['admin:bookings'], security: sec, params: idParams },
  }, async (req) => {
    const b = (await db.query(`${bookingSelect('staff')} WHERE b.id = $1`, [req.params.id])).rows[0];
    if (!b || !can(requireUser(req), 'bookings.view', b._countryId)) throw notFound();
    return { ...strip(b), history: await bookingHistory(db, b.id) };
  });

  app.get('/admin/orders/:id', {
    onRequest: deps.authenticate, preValidation: requirePermission('bookings.view'), schema: { tags: ['admin:bookings'], security: sec, params: idParams },
  }, async (req) => {
    const o = await loadOrder(db, req.params.id, 'staff');
    if (!o || !can(requireUser(req), 'bookings.view', o.countryId)) throw notFound();
    return o;
  });

  app.post('/admin/bookings/:id/cancel', {
    onRequest: deps.authenticate, preValidation: requirePermission('bookings.cancel'),
    schema: { tags: ['admin:bookings'], security: sec, params: idParams, body: z.object({ reason: reasonSchema, refundAmount: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/).optional() }) },
  }, async (req) => {
    const country = (await db.query<{ country_id: string }>('SELECT country_id FROM bookings WHERE id = $1', [req.params.id])).rows[0];
    if (!country) throw notFound();
    assertCan(requireUser(req), 'bookings.cancel', country.country_id);
    return cancelBooking(db, req.params.id, 'admin', req.body.reason, actorOf(req), { refundAmount: req.body.refundAmount });
  });

  app.get('/admin/cancellation-requests', {
    onRequest: deps.authenticate, preValidation: requirePermission('bookings.cancel'),
    schema: { tags: ['admin:bookings'], security: sec, querystring: paginationQuery.extend({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }) },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'bookings.cancel');
    return (await db.query(
      `SELECT r.id, r.booking_id AS "bookingId", b.number AS "bookingNumber", b.status AS "bookingStatus", r.reason, r.computed_refund AS "computedRefund",
              r.status, r.approved_refund AS "approvedRefund", r.decision_reason AS "decisionReason", r.created_at AS "createdAt", b.currency_code AS currency
         FROM cancellation_requests r JOIN bookings b ON b.id = r.booking_id
        WHERE ($1::uuid[] IS NULL OR b.country_id = ANY($1)) AND r.status = $2 ORDER BY r.created_at LIMIT $3 OFFSET $4`,
      [scope, req.query.status, req.query.limit, req.query.offset])).rows;
  });

  app.post('/admin/cancellation-requests/:id/decide', {
    onRequest: deps.authenticate, preValidation: requirePermission('bookings.cancel'),
    schema: {
      tags: ['admin:bookings'], security: sec, params: idParams,
      body: z.object({ decision: z.enum(['approve', 'reject']), refundAmount: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/).optional(), reason: reasonSchema }),
    },
  }, async (req) => {
    const r = (await db.query<{ country_id: string }>('SELECT b.country_id FROM cancellation_requests r JOIN bookings b ON b.id = r.booking_id WHERE r.id = $1', [req.params.id])).rows[0];
    if (!r) throw notFound();
    assertCan(requireUser(req), 'bookings.cancel', r.country_id);
    return decideCancellationRequest(db, req.params.id, req.body.decision, req.body.refundAmount, req.body.reason, actorOf(req));
  });
}
