import type pg from 'pg';
import { withTx, type Db, type Executor } from '../../db/pool.js';
import { audit, systemActor, type ActorContext } from '../../lib/audit.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { fromUnits, toUnits } from '../../lib/money.js';
import { enqueueMessage } from '../../lib/outbox.js';
import { confirmHold, releaseBlock, reserve } from '../availability/engine.js';
import { currentTerms } from '../auth/service.js';
import { getSetting } from '../settings/registry.js';
import { quote, type ItemInput, type Quote } from './pricing.js';
import { computeCommission } from '../finance/commission.js';
import { evaluateCoupon } from '../promotions/service.js';
import { onBookingCompleted } from '../finance/earnings.js';
import { issueInvoice } from '../documents/service.js';

export type BookingStatus =
  | 'pending_provider_approval' | 'awaiting_payment' | 'confirmed' | 'in_progress' | 'completed' | 'no_show'
  | 'rejected' | 'expired' | 'cancelled_by_customer' | 'cancelled_by_provider' | 'cancelled_by_admin';

/** Statuses that still occupy the calendar. */
export const OCCUPYING: BookingStatus[] = ['pending_provider_approval', 'awaiting_payment', 'confirmed', 'in_progress'];
/** Before any money is involved: cancellable here without the refund process (phase 7). */
export const UNPAID: BookingStatus[] = ['pending_provider_approval', 'awaiting_payment'];
const TERMINAL: BookingStatus[] = ['completed', 'no_show', 'rejected', 'expired', 'cancelled_by_customer', 'cancelled_by_provider', 'cancelled_by_admin'];

interface BookingRow {
  id: string; number: string; order_id: string; customer_id: string; provider_id: string; country_id: string; status: BookingStatus;
  calendar_block_id: string | null; start_at: Date; end_at: Date; requires_provider_approval: boolean; service_id: string;
}

export async function lockBooking(c: Executor, id: string): Promise<BookingRow> {
  const b = (await c.query<BookingRow>('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id])).rows[0];
  if (!b) throw notFound();
  return b;
}

export async function notify(c: Executor, userId: string, templateKey: string, payload: Record<string, unknown>) {
  const u = (await c.query<{ phone: string | null; email: string | null; preferred_language: string }>(
    'SELECT phone, email, preferred_language FROM users WHERE id = $1', [userId])).rows[0];
  if (!u) return;
  const target = u.phone ?? u.email;
  if (!target) return;
  await enqueueMessage(c, { channel: u.phone ? 'sms' : 'email', recipientUserId: userId, target, templateKey, language: u.preferred_language, payload });
}

async function providerUserId(c: Executor, providerId: string): Promise<string> {
  return (await c.query<{ user_id: string }>('SELECT user_id FROM providers WHERE id = $1', [providerId])).rows[0]!.user_id;
}

/** An order is closed once every booking is final, completed once all final ones that went ahead completed. */
async function refreshOrderStatus(c: Executor, orderId: string) {
  await c.query(
    `UPDATE orders o SET status = CASE
        WHEN EXISTS (SELECT 1 FROM bookings b WHERE b.order_id = o.id AND b.status <> ALL($2)) THEN 'active'
        WHEN EXISTS (SELECT 1 FROM bookings b WHERE b.order_id = o.id AND b.status = 'completed') THEN 'completed'
        ELSE 'closed' END
      WHERE o.id = $1`, [orderId, TERMINAL]);
}

/** The single way a booking changes status: event row, audit row, order refresh. */
export async function transition(c: Executor, b: BookingRow, to: BookingStatus, ctx: ActorContext, reason: string | null, extra: Record<string, unknown> = {}) {
  const sets = ['status = $2'];
  const params: unknown[] = [b.id, to];
  for (const [col, v] of Object.entries(extra)) {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  }
  await c.query(`UPDATE bookings SET ${sets.join(', ')} WHERE id = $1`, params);
  await c.query('INSERT INTO booking_status_events (booking_id, from_status, to_status, actor_id, actor_kind, reason) VALUES ($1, $2, $3, $4, $5, $6)',
    [b.id, b.status, to, ctx.actorId, ctx.actorKind, reason]);
  await audit(c, ctx, { action: `booking.${to}`, entityType: 'booking', entityId: b.id, before: { status: b.status }, after: { status: to }, reason });
  // A coupon use on a booking that ends before any money changed hands does not count against its limits.
  if (['expired', 'rejected', 'cancelled_by_customer', 'cancelled_by_provider', 'cancelled_by_admin'].includes(to)) {
    await c.query(
      `UPDATE promotion_redemptions SET status = 'void' WHERE booking_id = $1 AND NOT EXISTS (
         SELECT 1 FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.booking_id = $1 AND p.status = 'succeeded')`, [b.id]);
  }
  await refreshOrderStatus(c, b.order_id);
  b.status = to;
}

export async function freeCalendar(c: Executor, b: BookingRow, actorId: string | null, reason: string) {
  if (!b.calendar_block_id) return;
  const active = await c.query(`SELECT 1 FROM calendar_blocks WHERE id = $1 AND status = 'active'`, [b.calendar_block_id]);
  if (active.rowCount) await releaseBlock(c, b.calendar_block_id, actorId, reason);
}

// ---------------------------------------------------------------------------
// Cart
// ---------------------------------------------------------------------------

export async function addToCart(db: Db, customerId: string, input: ItemInput, ctx: ActorContext) {
  return withTx(db, async (c) => {
    const q = await quote(c, input);
    if (input.eventId) await assertOwnEvent(c, customerId, input.eventId);
    const id = (await c.query<{ id: string }>(
      `INSERT INTO cart_items (customer_id, service_id, package_id, rental_item_id, event_id, start_at, end_at, units, guests, add_ons, notes, quoted_total, currency_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [customerId, q.serviceId, q.packageId, q.rentalItemId, input.eventId, q.start, q.end, q.units, q.guests, input.addOns.length ? [...new Set(input.addOns)] : [],
        input.notes, q.total, q.currency])).rows[0]!.id;
    await audit(c, ctx, { action: 'cart.item_added', entityType: 'cart_item', entityId: id, after: { serviceId: q.serviceId, total: q.total, currency: q.currency } });
    return { id, quote: q };
  });
}

interface CartRow {
  id: string; service_id: string; package_id: string | null; rental_item_id: string | null; event_id: string | null; start_at: Date; end_at: Date;
  units: number; guests: number | null; add_ons: string[]; notes: string | null; quoted_total: string; currency_code: string;
}

/** Rebuilds the request from a stored cart row so it is re-priced exactly like the original. */
async function cartRowToInput(c: Executor, r: CartRow): Promise<ItemInput> {
  const mode = (await c.query<{ booking_mode: string; timezone: string }>(
    `SELECT t.booking_mode, co.timezone FROM services s JOIN service_types t ON t.id = s.service_type_id JOIN countries co ON co.id = s.country_id WHERE s.id = $1`,
    [r.service_id])).rows[0]!;
  const loc = (await c.query<{ s: string; e: string }>(
    `SELECT to_char($1::timestamptz AT TIME ZONE $3, 'YYYY-MM-DD') AS s, to_char(($2::timestamptz AT TIME ZONE $3) - interval '1 day', 'YYYY-MM-DD') AS e`,
    [r.start_at, r.end_at, mode.timezone])).rows[0]!;
  return {
    serviceId: r.service_id, packageId: r.package_id, rentalItemId: r.rental_item_id, eventId: r.event_id, units: r.units, guests: r.guests,
    addOns: r.add_ons, notes: r.notes,
    ...(mode.booking_mode === 'time_slot' ? { startAt: r.start_at.toISOString(), endAt: r.end_at.toISOString() }
      : mode.booking_mode === 'full_day' ? { date: loc.s } : { startDate: loc.s, endDate: loc.e }),
  };
}

/**
 * Cart with live prices and availability. Availability is tested by attempting the real reservation
 * inside a savepoint that is always rolled back, so it uses exactly the checkout rules.
 */
export async function viewCart(db: Db, customerId: string) {
  const c = await db.connect();
  try {
    // Read-only: rolled back at the end, so nothing tried here (holds, inline expiry releases) persists.
    await c.query('BEGIN');
    const rows = (await c.query<CartRow>('SELECT * FROM cart_items WHERE customer_id = $1 ORDER BY created_at', [customerId])).rows;
    const items = [];
    for (const r of rows) {
      let q: Quote | null = null;
      let state: 'ok' | 'price_changed' | 'unavailable' | 'not_bookable' = 'ok';
      let problem: string | null = null;
      try {
        q = await quote(c, await cartRowToInput(c, r));
        await c.query('SAVEPOINT probe');
        try {
          await reserve(c, { serviceId: q.serviceId, rentalItemId: q.rentalItemId, start: q.start, end: q.end, units: q.calendarUnits, kind: 'hold', enforceSchedule: true, actorId: null });
        } finally {
          await c.query('ROLLBACK TO SAVEPOINT probe');
        }
        if (q.total !== r.quoted_total || q.currency !== r.currency_code.trim()) state = 'price_changed';
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        state = err.code === 'SLOT_UNAVAILABLE' ? 'unavailable' : 'not_bookable';
        problem = err.code;
      }
      items.push({
        id: r.id, serviceId: r.service_id, packageId: r.package_id, rentalItemId: r.rental_item_id, eventId: r.event_id,
        start: r.start_at, end: r.end_at, units: r.units, guests: r.guests, addOns: q?.addOns ?? r.add_ons, notes: r.notes,
        serviceTitle: q?.serviceTitle ?? null, packageName: q?.packageName ?? null,
        quotedTotal: r.quoted_total, currentTotal: q?.total ?? null, currency: q?.currency ?? r.currency_code.trim(),
        upfrontAmount: q?.upfrontAmount ?? null, balanceDueAt: q?.balanceDueAt ?? null, requiresProviderApproval: q?.requiresProviderApproval ?? null,
        cancellationPolicy: q?.cancellationPolicy ?? null, state, problem,
      });
    }
    // Totals per currency: amounts in different currencies are never added together.
    const acc: Record<string, { total: bigint; upfront: bigint }> = {};
    for (const i of items) {
      if (!i.currentTotal || !i.upfrontAmount) continue;
      const t = (acc[i.currency] ??= { total: 0n, upfront: 0n });
      t.total += toUnits(i.currentTotal);
      t.upfront += toUnits(i.upfrontAmount);
    }
    const totals = Object.fromEntries(Object.entries(acc).map(([cur, t]) => [cur, { total: fromUnits(t.total), upfront: fromUnits(t.upfront) }]));
    return { items, totals };
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

export async function assertOwnEvent(c: Executor, customerId: string, eventId: string) {
  const e = await c.query(`SELECT 1 FROM events WHERE id = $1 AND customer_id = $2 AND status <> 'cancelled'`, [eventId, customerId]);
  if (!e.rowCount) throw badRequest('EVENT_NOT_FOUND');
}

// ---------------------------------------------------------------------------
// Checkout: one order, one booking per service (clause 31), all-or-nothing.
// ---------------------------------------------------------------------------

export async function checkout(db: Db, customerId: string, opts: { itemIds?: string[] | undefined; acceptTerms: boolean; idempotencyKey: string; couponCode?: string | undefined }, ctx: ActorContext) {
  if (!opts.acceptTerms) throw badRequest('TERMS_NOT_ACCEPTED');

  const existing = (await db.query<{ id: string }>('SELECT id FROM orders WHERE customer_id = $1 AND idempotency_key = $2', [customerId, opts.idempotencyKey])).rows[0];
  if (existing) return { orderId: existing.id, replayed: true };

  // Re-price first in a separate transaction so a "price changed" answer also refreshes the quoted prices.
  const priceIssues = await withTx(db, async (c) => {
    const rows = (await c.query<CartRow>(
      `SELECT * FROM cart_items WHERE customer_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY created_at FOR UPDATE`,
      [customerId, opts.itemIds ?? null])).rows;
    if (!rows.length) throw badRequest('CART_EMPTY');
    const changed = [];
    for (const r of rows) {
      const q = await quote(c, await cartRowToInput(c, r));
      if (q.total !== r.quoted_total || q.currency !== r.currency_code.trim()) {
        changed.push({ itemId: r.id, previousTotal: r.quoted_total, currentTotal: q.total, currency: q.currency });
        await c.query('UPDATE cart_items SET quoted_total = $2, currency_code = $3 WHERE id = $1', [r.id, q.total, q.currency]);
      }
    }
    return changed;
  });
  if (priceIssues.length) throw conflict('PRICE_CHANGED', priceIssues);

  try {
    return await withTx(db, async (c) => {
      // Serialize checkouts of the same customer so a double-submitted key cannot create two orders.
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`checkout:${customerId}`]);
      const again = (await c.query<{ id: string }>('SELECT id FROM orders WHERE customer_id = $1 AND idempotency_key = $2', [customerId, opts.idempotencyKey])).rows[0];
      if (again) return { orderId: again.id, replayed: true };

      const customer = (await c.query<{ country_id: string; phone_verified_at: Date | null }>('SELECT country_id, phone_verified_at FROM users WHERE id = $1', [customerId])).rows[0]!;
      const rows = (await c.query<CartRow>(
        `SELECT * FROM cart_items WHERE customer_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY created_at FOR UPDATE`,
        [customerId, opts.itemIds ?? null])).rows;
      if (!rows.length) throw badRequest('CART_EMPTY');

      const quotes: { row: CartRow; q: Quote }[] = [];
      for (const row of rows) quotes.push({ row, q: await quote(c, await cartRowToInput(c, row)) });
      const countryId = quotes[0]!.q.countryId;
      const currency = quotes[0]!.q.currency;
      if (quotes.some(({ q }) => q.countryId !== countryId || q.currency !== currency)) throw badRequest('MIXED_CURRENCIES');
      if (await getSetting(c, 'booking.require_verified_phone', countryId) && !customer.phone_verified_at) throw badRequest('PHONE_NOT_VERIFIED');
      const eventIds = [...new Set(rows.map((r) => r.event_id).filter(Boolean))] as string[];
      for (const e of eventIds) await assertOwnEvent(c, customerId, e);

      const terms = await currentTerms(c, 'customer_terms', countryId);
      if (!terms) throw badRequest('TERMS_NOT_PUBLISHED');

      // Coupon (clause 55): validated under a lock on the promotion, then each item is re-priced with its share.
      let promotionId: string | null = null;
      if (opts.couponCode) {
        const ev = await evaluateCoupon(c, opts.couponCode, quotes.map(({ row, q }) => ({
          key: row.id, serviceId: q.serviceId, serviceTypeId: q.serviceTypeId, providerId: q.providerId, countryId: q.countryId, currency: q.currency, total: q.total, customerId,
        })), true);
        promotionId = ev.promotionId;
        for (const item of quotes) {
          const d = ev.byItem.get(item.row.id);
          if (d) item.q = await quote(c, await cartRowToInput(c, item.row), d);
        }
      }
      const discountTotal = fromUnits(quotes.reduce((a, { q }) => a + toUnits(q.discountAmount), 0n));
      const subtotalSum = fromUnits(quotes.reduce((a, { q }) => a + toUnits(q.subtotal), 0n));
      const total = fromUnits(quotes.reduce((a, { q }) => a + toUnits(q.total), 0n));
      const upfront = fromUnits(quotes.reduce((a, { q }) => a + toUnits(q.upfrontAmount), 0n));

      const order = (await c.query<{ id: string; number: string }>(
        `INSERT INTO orders (customer_id, event_id, country_id, currency_code, subtotal, total, upfront_total, idempotency_key, terms_version_id, discount_total, promotion_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, number`,
        [customerId, eventIds.length === 1 ? eventIds[0] : null, countryId, currency, subtotalSum, total, upfront, opts.idempotencyKey, terms.id, discountTotal, promotionId])).rows[0]!;
      await c.query(`INSERT INTO terms_acceptances (user_id, terms_version_id, context, ip) VALUES ($1, $2, 'booking', $3)`, [customerId, terms.id, ctx.ip]);

      const approvalHours = await getSetting(c, 'booking.approval_window_hours', countryId);
      // Lock services in a fixed order so concurrent multi-item checkouts cannot deadlock.
      quotes.sort((a, b) => a.q.serviceId.localeCompare(b.q.serviceId) || a.q.start.getTime() - b.q.start.getTime());
      const created = [];
      for (const { row, q } of quotes) {
        const bookingId = (await c.query<{ id: string }>('SELECT gen_random_uuid() AS id')).rows[0]!.id;
        const block = await reserve(c, {
          serviceId: q.serviceId, rentalItemId: q.rentalItemId, start: q.start, end: q.end, units: q.calendarUnits, kind: 'hold',
          enforceSchedule: true, bookingRef: bookingId, actorId: customerId,
          ...(q.requiresProviderApproval ? { holdMinutes: approvalHours * 60 } : {}),
        });
        if (q.packageId && q.maxBookingsPerSlot) {
          // Service row is locked by reserve(): counting here is race-free.
          const n = Number((await c.query<{ n: string }>(
            `SELECT count(*) AS n FROM bookings WHERE package_id = $1 AND status = ANY($2) AND tstzrange(start_at, end_at) && tstzrange($3, $4)`,
            [q.packageId, OCCUPYING, q.start, q.end])).rows[0]!.n);
          if (n >= q.maxBookingsPerSlot) throw conflict('PACKAGE_FULL', { itemId: row.id });
        }
        const status: BookingStatus = q.requiresProviderApproval ? 'pending_provider_approval' : 'awaiting_payment';
        const b = (await c.query<{ id: string; number: string }>(
          `INSERT INTO bookings (id, order_id, customer_id, provider_id, service_id, package_id, rental_item_id, event_id, country_id, start_at, end_at,
             units, guests, calendar_block_id, service_title, package_name, pricing_unit, unit_price, quantity_factor, add_ons, subtotal, total,
             currency_code, deposit_type, deposit_value, upfront_amount, balance_due_at, security_deposit_amount, cancellation_policy, terms_snapshot,
             requires_provider_approval, status, hold_expires_at, approval_deadline, customer_notes,
             promotion_id, discount_amount, discount_platform_borne, discount_provider_borne)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39)
           RETURNING id, number`,
          [bookingId, order.id, customerId, q.providerId, q.serviceId, q.packageId, q.rentalItemId, row.event_id, countryId, q.start, q.end,
            q.units, q.guests, block.id, JSON.stringify(q.serviceTitle), q.packageName ? JSON.stringify(q.packageName) : null, q.pricingUnit,
            q.unitPrice, q.quantityFactor, JSON.stringify(q.addOns), q.subtotal, q.total, q.currency, q.depositType, q.depositValue, q.upfrontAmount,
            q.balanceDueAt, q.securityDepositAmount, q.cancellationPolicy ? JSON.stringify(q.cancellationPolicy) : null,
            JSON.stringify(q.termsSnapshot), q.requiresProviderApproval, status, block.expiresAt,
            q.requiresProviderApproval ? block.expiresAt : null, row.notes,
            toUnits(q.discountAmount) > 0n ? promotionId : null, q.discountAmount, q.discountPlatformBorne, q.discountProviderBorne])).rows[0]!;
        if (toUnits(q.discountAmount) > 0n) {
          await c.query('INSERT INTO promotion_redemptions (promotion_id, order_id, booking_id, customer_id, discount_amount) VALUES ($1, $2, $3, $4, $5)',
            [promotionId, order.id, b.id, customerId, q.discountAmount]);
        }
        await c.query(`INSERT INTO booking_status_events (booking_id, from_status, to_status, actor_id, actor_kind) VALUES ($1, NULL, $2, $3, 'customer')`,
          [b.id, status, customerId]);
        // Commission rule and amount are fixed at booking time; later rule changes never touch it (clause 40).
        // Base = price minus what the provider gives up; a platform-borne discount does not cut the provider's commission base.
        const commissionBase = fromUnits(toUnits(q.total) + toUnits(q.discountPlatformBorne));
        await computeCommission(c, { bookingId: b.id, serviceId: q.serviceId, providerId: q.providerId, serviceTypeId: q.serviceTypeId, countryId, total: commissionBase, currency: q.currency }, new Date());
        await notify(c, await providerUserId(c, q.providerId), status === 'pending_provider_approval' ? 'booking.approval_requested' : 'booking.created',
          { bookingId: b.id, number: b.number, approvalDeadline: status === 'pending_provider_approval' ? block.expiresAt : null });
        created.push({ id: b.id, number: b.number, status, holdExpiresAt: block.expiresAt });
      }
      await c.query('DELETE FROM cart_items WHERE id = ANY($1)', [rows.map((r) => r.id)]);
      await audit(c, ctx, { action: 'order.created', entityType: 'order', entityId: order.id, after: { number: order.number, total, upfront, currency, bookings: created.map((b) => b.number) } });
      await notify(c, customerId, 'order.created', { orderId: order.id, number: order.number });
      await checkEventBudget(c, eventIds);
      return { orderId: order.id, replayed: false };
    });
  } catch (err) {
    // A concurrent duplicate that slipped past the advisory lock still hits the unique key.
    if ((err as { code?: string; constraint?: string }).code === '23505' && (err as { constraint?: string }).constraint === 'orders_customer_id_idempotency_key_key') {
      const o = (await db.query<{ id: string }>('SELECT id FROM orders WHERE customer_id = $1 AND idempotency_key = $2', [customerId, opts.idempotencyKey])).rows[0]!;
      return { orderId: o.id, replayed: true };
    }
    throw err;
  }
}

/** Notifies the customer once an event's committed cost passes its budget (same currency only). */
export async function checkEventBudget(c: Executor, eventIds: string[]) {
  for (const id of eventIds) {
    const r = (await c.query<{ customer_id: string; over: boolean; name: string }>(
      `SELECT e.customer_id, e.name, coalesce((SELECT sum(b.total) FROM bookings b WHERE b.event_id = e.id AND b.currency_code = e.budget_currency
                AND b.status = ANY($2)), 0) > e.budget_amount AS over
         FROM events e WHERE e.id = $1 AND e.budget_amount IS NOT NULL`, [id, OCCUPYING])).rows[0];
    if (r?.over) await notify(c, r.customer_id, 'event.budget_exceeded', { eventId: id, name: r.name });
  }
}

// ---------------------------------------------------------------------------
// Provider decisions (clause 29)
// ---------------------------------------------------------------------------

export async function providerDecision(db: Db, providerId: string, bookingId: string, decision: 'accept' | 'reject', reason: string | null, ctx: ActorContext) {
  return withTx(db, async (c) => {
    const b = await lockBooking(c, bookingId);
    if (b.provider_id !== providerId) throw notFound();
    if (b.status !== 'pending_provider_approval') throw conflict('INVALID_STATUS_TRANSITION', { from: b.status });
    const late = (await c.query<{ late: boolean }>('SELECT approval_deadline <= now() AS late FROM bookings WHERE id = $1', [b.id])).rows[0]!.late;
    if (late) throw conflict('INVALID_STATUS_TRANSITION', { reason: 'approval deadline passed' });

    if (decision === 'reject') {
      if (!reason) throw badRequest('REASON_REQUIRED');
      await freeCalendar(c, b, ctx.actorId, 'rejected by provider');
      // No payment can exist before acceptance in this flow, so nothing is refunded here (clause 29 step 7 applies from phase 6).
      await transition(c, b, 'rejected', ctx, reason, { decided_at: new Date(), decided_by: ctx.actorId, decision_reason: reason, hold_expires_at: null });
      await notify(c, b.customer_id, 'booking.rejected', { bookingId: b.id, number: b.number, reason });
      return { status: b.status };
    }
    // Accepted: keep the slot held for the payment window.
    const hours = await getSetting(c, 'booking.payment_window_hours', b.country_id);
    const exp = (await c.query<{ e: Date }>(
      `UPDATE calendar_blocks SET expires_at = now() + make_interval(hours => $2) WHERE id = $1 AND status = 'active' RETURNING expires_at AS e`,
      [b.calendar_block_id, hours])).rows[0];
    if (!exp) throw conflict('SLOT_UNAVAILABLE');
    await transition(c, b, 'awaiting_payment', ctx, null, { decided_at: new Date(), decided_by: ctx.actorId, hold_expires_at: exp.e, expiry_warning_sent_at: null });
    await notify(c, b.customer_id, 'booking.accepted', { bookingId: b.id, number: b.number, payBy: exp.e });
    return { status: b.status };
  });
}

/**
 * Entry point for the payments module (phase 6): the upfront requirement is met, so confirm.
 * An expired hold is re-checked against the calendar before confirming (clause 32).
 */
export async function confirmAfterPayment(c: pg.PoolClient, bookingId: string, ctx: ActorContext) {
  const b = await lockBooking(c, bookingId);
  if (b.status !== 'awaiting_payment' && b.status !== 'expired') throw conflict('INVALID_STATUS_TRANSITION', { from: b.status });
  if (!b.calendar_block_id) throw conflict('SLOT_UNAVAILABLE');
  const block = await confirmHold(c, b.calendar_block_id, b.id, ctx.actorId);
  await transition(c, b, 'confirmed', ctx, null, { calendar_block_id: block.id, hold_expires_at: null });
  // Booking invoice, numbered and frozen at confirmation (clause 65).
  await issueInvoice(c, b.id);
  await notify(c, b.customer_id, 'booking.confirmed', { bookingId: b.id, number: b.number });
  await notify(c, await providerUserId(c, b.provider_id), 'booking.confirmed', { bookingId: b.id, number: b.number });
  return b;
}

// ---------------------------------------------------------------------------
// Cancellation of unpaid bookings, execution status
// ---------------------------------------------------------------------------

export async function cancelUnpaid(db: Db, bookingId: string, by: 'customer' | 'provider' | 'admin', reason: string, ctx: ActorContext, owner?: { customerId?: string; providerId?: string }) {
  return withTx(db, async (c) => {
    const b = await lockBooking(c, bookingId);
    if (owner?.customerId && b.customer_id !== owner.customerId) throw notFound();
    if (owner?.providerId && b.provider_id !== owner.providerId) throw notFound();
    if (!UNPAID.includes(b.status)) {
      if (TERMINAL.includes(b.status)) throw conflict('INVALID_STATUS_TRANSITION', { from: b.status });
      throw conflict('CANCELLATION_REQUIRES_REFUND_FLOW');
    }
    await freeCalendar(c, b, ctx.actorId, `cancelled by ${by}`);
    const to: BookingStatus = by === 'customer' ? 'cancelled_by_customer' : by === 'provider' ? 'cancelled_by_provider' : 'cancelled_by_admin';
    // Only this booking is cancelled; other bookings in the same order are untouched (clause 31).
    await transition(c, b, to, ctx, reason, { hold_expires_at: null });
    const other = by === 'customer' ? await providerUserId(c, b.provider_id) : b.customer_id;
    await notify(c, other, 'booking.cancelled', { bookingId: b.id, number: b.number, reason });
    return { status: b.status };
  });
}

/** Start and completion. No-shows go through the cancellation policy (booking/cancellation.ts). */
export async function providerExecution(db: Db, providerId: string, bookingId: string, action: 'start' | 'complete', ctx: ActorContext) {
  return withTx(db, async (c) => {
    const b = await lockBooking(c, bookingId);
    if (b.provider_id !== providerId) throw notFound();
    const started = (await c.query<{ started: boolean; ended: boolean }>('SELECT start_at <= now() AS started, end_at <= now() AS ended FROM bookings WHERE id = $1', [b.id])).rows[0]!;
    const rules = {
      start: { from: ['confirmed'], to: 'in_progress', when: started.started },
      complete: { from: ['confirmed', 'in_progress'], to: 'completed', when: started.started },
    }[action] as { from: BookingStatus[]; to: BookingStatus; when: boolean };
    if (!rules.from.includes(b.status)) throw conflict('INVALID_STATUS_TRANSITION', { from: b.status });
    // A service cannot be marked done (which later unlocks the provider's earnings) before it has started.
    if (!rules.when) throw conflict('INVALID_STATUS_TRANSITION', { reason: 'the booking has not started yet' });
    await transition(c, b, rules.to, ctx, null);
    if (rules.to === 'completed') {
      await onBookingCompleted(c, b.id, ctx);
      await notify(c, b.customer_id, 'booking.completed', { bookingId: b.id, number: b.number });
    }
    return { status: b.status };
  });
}

// ---------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------

/** Expires bookings whose approval window or payment hold ran out, freeing their slots. */
export async function expireBookings(db: Db): Promise<number> {
  const ids = (await db.query<{ id: string }>(
    `SELECT id FROM bookings WHERE status = ANY($1) AND hold_expires_at <= now() ORDER BY hold_expires_at LIMIT 500`, [UNPAID])).rows;
  let n = 0;
  for (const { id } of ids) {
    await withTx(db, async (c) => {
      const b = await lockBooking(c, id);
      const due = (await c.query<{ due: boolean }>('SELECT hold_expires_at <= now() AS due FROM bookings WHERE id = $1', [id])).rows[0]!.due;
      if (!UNPAID.includes(b.status) || !due) return; // changed meanwhile (e.g. paid or accepted)
      await freeCalendar(c, b, null, 'expired');
      const reason = b.status === 'pending_provider_approval' ? 'provider did not respond in time' : 'payment not completed in time';
      await transition(c, b, 'expired', systemActor, reason, { hold_expires_at: null });
      await notify(c, b.customer_id, 'booking.expired', { bookingId: b.id, number: b.number, reason });
      n++;
    });
  }
  return n;
}

/** Warns customers shortly before an unpaid hold expires (clause 53), once per hold. */
export async function warnExpiringHolds(db: Db): Promise<number> {
  return withTx(db, async (c) => {
    const rows = (await c.query<{ id: string; number: string; customer_id: string; hold_expires_at: Date }>(
      `UPDATE bookings b SET expiry_warning_sent_at = now()
        WHERE b.status = 'awaiting_payment' AND b.expiry_warning_sent_at IS NULL AND b.hold_expires_at > now()
          AND b.hold_expires_at <= now() + make_interval(mins => (
            SELECT coalesce((SELECT (value)::int FROM settings WHERE key = 'booking.expiry_warning_minutes' AND scope_type = 'country' AND scope_id = b.country_id),
                            (SELECT (value)::int FROM settings WHERE key = 'booking.expiry_warning_minutes' AND scope_type = 'global'), 5)))
        RETURNING b.id, b.number, b.customer_id, b.hold_expires_at`)).rows;
    for (const r of rows) await notify(c, r.customer_id, 'booking.hold_expiring', { bookingId: r.id, number: r.number, expiresAt: r.hold_expires_at });
    return rows.length;
  });
}

export function assertCustomer(kind: string) {
  if (kind !== 'customer') throw forbidden();
}

/** Shows what a coupon would do to the cart (or selected items) without using it. */
export async function previewCoupon(db: Db, customerId: string, code: string, itemIds?: string[]) {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const rows = (await c.query<CartRow>(`SELECT * FROM cart_items WHERE customer_id = $1 AND ($2::uuid[] IS NULL OR id = ANY($2)) ORDER BY created_at`, [customerId, itemIds ?? null])).rows;
    if (!rows.length) throw badRequest('CART_EMPTY');
    const quotes = [];
    for (const row of rows) quotes.push({ row, q: await quote(c, await cartRowToInput(c, row)) });
    const ev = await evaluateCoupon(c, code, quotes.map(({ row, q }) => ({
      key: row.id, serviceId: q.serviceId, serviceTypeId: q.serviceTypeId, providerId: q.providerId, countryId: q.countryId, currency: q.currency, total: q.total, customerId,
    })), false);
    return {
      totalDiscount: fromUnits(ev.total),
      items: quotes.map(({ row, q }) => {
        const d = ev.byItem.get(row.id);
        const disc = d?.amount ?? 0n;
        return { itemId: row.id, total: q.total, discount: fromUnits(disc), totalAfterDiscount: fromUnits(toUnits(q.total) - disc), currency: q.currency };
      }),
    };
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
