import type { Executor } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { fromUnits, mulDiv, roundToMinor, toUnits } from '../../lib/money.js';
import { getSetting } from '../settings/registry.js';

/**
 * Issued documents (clause 65). Every document gets a number unique per country, kind and year, and
 * its printable content is frozen at issue time (`documents.data`, immutable in the database), so later
 * changes to settings, names or prices never alter an issued document.
 */
export type DocumentKind = 'invoice' | 'payment_receipt' | 'deposit_receipt' | 'refund_note' | 'settlement_note';
const PREFIX: Record<DocumentKind, string> = {
  invoice: 'INV', payment_receipt: 'RCT', deposit_receipt: 'DEP', refund_note: 'RFN', settlement_note: 'STN',
};

interface IssueInput {
  kind: DocumentKind;
  countryId: string;
  sourceType: 'booking' | 'payment' | 'refund' | 'settlement';
  sourceId: string;
  bookingId: string | null;
  customerId: string | null;
  providerId: string | null;
  currency: string;
  total: string;
  data: Record<string, unknown>;
}

export interface DocumentRow {
  id: string; number: string; kind: DocumentKind; country_id: string; source_type: string; source_id: string;
  customer_id: string | null; provider_id: string | null; booking_id: string | null; currency_code: string; total: string;
  data: Record<string, unknown>; issued_at: Date;
}

/** Issues a document once per business event; calling again returns the existing one (no duplicate numbers). */
async function issue(c: Executor, input: IssueInput): Promise<DocumentRow> {
  const existing = (await c.query<DocumentRow>(
    'SELECT * FROM documents WHERE kind = $1 AND source_id = $2 AND booking_id IS NOT DISTINCT FROM $3', [input.kind, input.sourceId, input.bookingId])).rows[0];
  if (existing) return existing;
  const country = (await c.query<{ code: string; name: unknown; timezone: string; tax_settings: Record<string, unknown>; invoice_settings: Record<string, unknown> }>(
    'SELECT code, name, timezone, tax_settings, invoice_settings FROM countries WHERE id = $1', [input.countryId])).rows[0]!;
  // Year in the country's own time zone, so numbering restarts at the local new year.
  const counter = (await c.query<{ year: number; value: number }>(
    `INSERT INTO document_counters (country_id, kind, year, last_value)
     VALUES ($1, $2, extract(year FROM now() AT TIME ZONE $3)::int, 1)
     ON CONFLICT (country_id, kind, year) DO UPDATE SET last_value = document_counters.last_value + 1
     RETURNING year, last_value AS value`, [input.countryId, input.kind, country.timezone])).rows[0]!;
  const number = `${PREFIX[input.kind]}-${country.code}-${counter.year}-${String(counter.value).padStart(6, '0')}`;
  const data = {
    platformName: await getSetting(c, 'documents.platform_name', input.countryId),
    country: { code: country.code, name: country.name },
    issuer: country.invoice_settings ?? {},
    ...input.data,
  };
  return (await c.query<DocumentRow>(
    `INSERT INTO documents (number, kind, country_id, source_type, source_id, customer_id, provider_id, booking_id, currency_code, total, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [number, input.kind, input.countryId, input.sourceType, input.sourceId, input.customerId, input.providerId, input.bookingId,
      input.currency, input.total, JSON.stringify(data)])).rows[0]!;
}

/**
 * Tax line, only when the country's tax settings define one. Contract (documented in docs/05):
 * `{ "rate": "15", "label": {"ar": "...", "en": "..."}, "pricesIncludeTax": true, "registrationNumber": "..." }`.
 * Prices are charged as published, so tax is shown only as the part included in the price; a country
 * configured with tax-exclusive prices gets no tax line rather than an amount that was never charged.
 */
async function taxLine(c: Executor, countryId: string, total: string, currency: string) {
  const t = (await c.query<{ tax_settings: Record<string, unknown> }>('SELECT tax_settings FROM countries WHERE id = $1', [countryId])).rows[0]!.tax_settings ?? {};
  const rate = typeof t.rate === 'string' || typeof t.rate === 'number' ? String(t.rate) : null;
  if (!rate || !/^\d{1,3}(\.\d{1,4})?$/.test(rate) || t.pricesIncludeTax !== true || !t.label) return null;
  const minor = (await c.query<{ m: number }>('SELECT minor_units AS m FROM currencies WHERE code = $1', [currency])).rows[0]?.m ?? 2;
  const r = toUnits(rate);
  const included = roundToMinor(mulDiv(toUnits(total), r, toUnits('100') + r), minor);
  return { label: t.label, rate, includedAmount: fromUnits(included), registrationNumber: t.registrationNumber ?? null };
}

async function paidFor(c: Executor, bookingId: string) {
  return (await c.query<{ v: string }>(
    `SELECT coalesce(sum(a.verified_amount), 0)::numeric(20,4)::text AS v FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
      WHERE a.booking_id = $1 AND p.status = 'succeeded'`, [bookingId])).rows[0]!.v;
}

interface BookingSnap {
  id: string; number: string; country_id: string; customer_id: string; provider_id: string; currency_code: string; status: string;
  service_title: unknown; package_name: unknown; pricing_unit: string; unit_price: string; quantity_factor: string; add_ons: unknown;
  subtotal: string; discount_amount: string; total: string; upfront_amount: string; balance_due_at: Date | null; start_at: Date; end_at: Date;
  guests: number | null; customer_name: string; customer_phone: string | null; provider_name: string; cancellation_policy: unknown;
}

async function bookingSnap(c: Executor, bookingId: string): Promise<BookingSnap> {
  const b = (await c.query<BookingSnap>(
    `SELECT b.id, b.number, b.country_id, b.customer_id, b.provider_id, b.currency_code, b.status, b.service_title, b.package_name,
            b.pricing_unit, b.unit_price, b.quantity_factor, b.add_ons, b.subtotal, b.discount_amount, b.total, b.upfront_amount,
            b.balance_due_at, b.start_at, b.end_at, b.guests, b.cancellation_policy,
            u.full_name AS customer_name, u.phone AS customer_phone, pr.business_name AS provider_name
       FROM bookings b JOIN users u ON u.id = b.customer_id JOIN providers pr ON pr.id = b.provider_id WHERE b.id = $1`, [bookingId])).rows[0];
  if (!b) throw notFound();
  return { ...b, currency_code: b.currency_code.trim() };
}

const bookingLines = (b: BookingSnap) => ({
  bookingNumber: b.number,
  service: b.service_title, package: b.package_name,
  startAt: b.start_at, endAt: b.end_at, guests: b.guests,
  customer: { name: b.customer_name, phone: b.customer_phone },
  provider: { name: b.provider_name },
  lines: [
    { description: b.package_name ?? b.service_title, unit: b.pricing_unit, unitPrice: b.unit_price, quantity: b.quantity_factor },
    ...((Array.isArray(b.add_ons) ? b.add_ons : []) as { name: unknown; price: string }[]).map((a) => ({ description: a.name, unitPrice: a.price, quantity: '1' })),
  ],
  subtotal: b.subtotal, discount: b.discount_amount, total: b.total, currency: b.currency_code,
});

/** Booking invoice, issued when the booking is confirmed. */
export async function issueInvoice(c: Executor, bookingId: string) {
  const b = await bookingSnap(c, bookingId);
  const paid = await paidFor(c, bookingId);
  return issue(c, {
    kind: 'invoice', countryId: b.country_id, sourceType: 'booking', sourceId: b.id, bookingId: b.id, customerId: b.customer_id,
    providerId: b.provider_id, currency: b.currency_code, total: b.total,
    data: {
      ...bookingLines(b),
      upfrontRequired: b.upfront_amount, paidAtIssue: paid, remainingAtIssue: fromUnits(toUnits(b.total) - toUnits(paid)),
      balanceDueAt: b.balance_due_at, cancellationPolicy: b.cancellation_policy,
      tax: await taxLine(c, b.country_id, b.total, b.currency_code),
    },
  });
}

/**
 * Receipt for money received by the platform. Direct payments go to the provider, so the platform
 * does not issue a receipt for them (the booking statement lists them as verified direct payments).
 */
export async function issuePaymentReceipt(c: Executor, paymentId: string) {
  const p = (await c.query<{ id: string; number: string; model: string; method: string; purpose: string; country_id: string; customer_id: string;
    currency_code: string; verified_amount: string; succeeded_at: Date; external_ref: string | null; customer_name: string }>(
    `SELECT p.id, p.number, p.model, p.method, p.purpose, p.country_id, p.customer_id, p.currency_code, p.verified_amount, p.succeeded_at,
            p.external_ref, u.full_name AS customer_name
       FROM payments p JOIN users u ON u.id = p.customer_id WHERE p.id = $1 AND p.status = 'succeeded'`, [paymentId])).rows[0];
  if (!p || p.model !== 'platform') return null;
  const allocations = (await c.query<{ booking_id: string; number: string; provider_id: string; provider_name: string; amount: string; total: string; upfront_amount: string }>(
    `SELECT a.booking_id, b.number, b.provider_id, pr.business_name AS provider_name, a.verified_amount AS amount, b.total, b.upfront_amount
       FROM payment_allocations a JOIN bookings b ON b.id = a.booking_id JOIN providers pr ON pr.id = b.provider_id
      WHERE a.payment_id = $1 AND a.verified_amount > 0 ORDER BY b.start_at`, [p.id])).rows;
  // A deposit receipt when this upfront payment covers a booking only partly (the rest is due later).
  const deposit = p.purpose === 'upfront' && allocations.some((a) => toUnits(a.upfront_amount) < toUnits(a.total));
  const providers = [...new Set(allocations.map((a) => a.provider_id))];
  const cur = p.currency_code.trim();
  return issue(c, {
    kind: deposit ? 'deposit_receipt' : 'payment_receipt', countryId: p.country_id, sourceType: 'payment', sourceId: p.id, bookingId: null,
    customerId: p.customer_id, providerId: providers.length === 1 ? providers[0]! : null, currency: cur, total: p.verified_amount,
    data: {
      paymentNumber: p.number, method: p.method, purpose: p.purpose, receivedAt: p.succeeded_at, reference: p.external_ref,
      customer: { name: p.customer_name }, amount: p.verified_amount, currency: cur,
      bookings: await Promise.all(allocations.map(async (a) => ({
        bookingNumber: a.number, provider: a.provider_name, applied: a.amount, bookingTotal: a.total,
        remainingAfter: fromUnits(toUnits(a.total) - toUnits(await paidFor(c, a.booking_id))),
      }))),
    },
  });
}

/** Refund note, issued when the money has actually gone back to the customer. */
export async function issueRefundNote(c: Executor, refundId: string) {
  const r = (await c.query<{ id: string; number: string; booking_id: string; amount: string; currency_code: string; reason: string; source: string;
    method: string; executed_at: Date; external_ref: string | null; payment_number: string }>(
    `SELECT r.id, r.number, r.booking_id, r.amount, r.currency_code, r.reason, r.source, r.method, r.executed_at, r.external_ref, p.number AS payment_number
       FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE r.id = $1 AND r.status = 'completed'`, [refundId])).rows[0];
  if (!r) return null;
  const b = await bookingSnap(c, r.booking_id);
  return issue(c, {
    kind: 'refund_note', countryId: b.country_id, sourceType: 'refund', sourceId: r.id, bookingId: b.id, customerId: b.customer_id,
    providerId: b.provider_id, currency: r.currency_code.trim(), total: r.amount,
    data: {
      refundNumber: r.number, bookingNumber: b.number, service: b.service_title, customer: { name: b.customer_name }, provider: { name: b.provider_name },
      originalPayment: r.payment_number, amount: r.amount, currency: r.currency_code.trim(), reason: r.reason, source: r.source, method: r.method,
      executedAt: r.executed_at, reference: r.external_ref,
    },
  });
}

/** Settlement note for the provider, issued when the transfer is recorded as paid. */
export async function issueSettlementNote(c: Executor, settlementId: string) {
  const s = (await c.query<{ id: string; number: string; provider_id: string; country_id: string; currency_code: string; kind: string; amount: string;
    method: string; paid_at: Date; external_ref: string | null; provider_name: string }>(
    `SELECT s.id, s.number, s.provider_id, s.country_id, s.currency_code, s.kind, s.amount, s.method, s.paid_at, s.external_ref, pr.business_name AS provider_name
       FROM settlements s JOIN providers pr ON pr.id = s.provider_id WHERE s.id = $1 AND s.status = 'paid'`, [settlementId])).rows[0];
  if (!s) return null;
  const items = (await c.query<{ number: string; amount: string; commission: string; collected: string }>(
    `SELECT b.number, i.amount, e.commission_amount AS commission, e.collected_by_platform AS collected
       FROM settlement_items i JOIN bookings b ON b.id = i.booking_id JOIN provider_earnings e ON e.id = i.earning_id
      WHERE i.settlement_id = $1 ORDER BY b.start_at`, [s.id])).rows;
  return issue(c, {
    kind: 'settlement_note', countryId: s.country_id, sourceType: 'settlement', sourceId: s.id, bookingId: null, customerId: null,
    providerId: s.provider_id, currency: s.currency_code.trim(), total: s.amount,
    data: {
      settlementNumber: s.number, settlementKind: s.kind, provider: { name: s.provider_name }, amount: s.amount, currency: s.currency_code.trim(),
      method: s.method, paidAt: s.paid_at, reference: s.external_ref,
      items: items.map((i) => ({ bookingNumber: i.number, amount: i.amount, collectedByPlatform: i.collected, commission: i.commission })),
    },
  });
}

// ---------------------------------------------------------------------------
// Statements (unnumbered, generated on demand from current data)
// ---------------------------------------------------------------------------

/** Booking statement: what was charged, paid, refunded and what remains, plus the documents issued. */
export async function bookingStatement(c: Executor, bookingId: string) {
  const b = await bookingSnap(c, bookingId);
  const payments = (await c.query(
    `SELECT p.number, p.model, p.method, p.purpose, p.status, a.amount AS requested, a.verified_amount AS "verifiedAmount", p.succeeded_at AS "succeededAt"
       FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.booking_id = $1 ORDER BY p.created_at`, [bookingId])).rows;
  const refunds = (await c.query(
    `SELECT number, amount, status, source, method, executed_at AS "executedAt" FROM refunds WHERE booking_id = $1 ORDER BY created_at`, [bookingId])).rows;
  const documents = (await c.query(
    `SELECT DISTINCT d.id, d.number, d.kind, d.total, d.issued_at AS "issuedAt" FROM documents d
       LEFT JOIN payment_allocations a ON a.payment_id = d.source_id
      WHERE d.booking_id = $1 OR a.booking_id = $1 ORDER BY 5`, [bookingId])).rows;
  const paid = await paidFor(c, bookingId);
  const refunded = (await c.query<{ v: string }>(`SELECT coalesce(sum(amount), 0)::numeric(20,4)::text AS v FROM refunds WHERE booking_id = $1 AND status = 'completed'`, [bookingId])).rows[0]!.v;
  const active = ['awaiting_payment', 'confirmed', 'in_progress', 'completed'].includes(b.status);
  return {
    kind: 'booking_statement', generatedAt: new Date(), status: b.status, ...bookingLines(b),
    upfrontRequired: b.upfront_amount, balanceDueAt: b.balance_due_at, paid, refunded,
    remaining: active ? fromUnits(toUnits(b.total) - toUnits(paid)) : '0.0000',
    payments, refunds, documents,
  };
}

/** Balance notice: the amount still due on a booking and when. */
export async function balanceNotice(c: Executor, bookingId: string) {
  const s = await bookingStatement(c, bookingId);
  return { kind: 'balance_notice', generatedAt: s.generatedAt, bookingNumber: s.bookingNumber, service: s.service, startAt: s.startAt,
    customer: s.customer, provider: s.provider, total: s.total, paid: s.paid, remaining: s.remaining, balanceDueAt: s.balanceDueAt, currency: s.currency };
}

/** Customer payment history across bookings. */
export async function paymentHistory(c: Executor, customerId: string) {
  const rows = (await c.query(
    `SELECT p.number, p.model, p.method, p.purpose, p.status, p.amount, p.verified_amount AS "verifiedAmount", p.currency_code AS currency,
            p.created_at AS "createdAt", p.succeeded_at AS "succeededAt",
            (SELECT json_agg(b.number ORDER BY b.number) FROM payment_allocations a JOIN bookings b ON b.id = a.booking_id WHERE a.payment_id = p.id) AS bookings
       FROM payments p WHERE p.customer_id = $1 ORDER BY p.created_at DESC`, [customerId])).rows;
  return { kind: 'payment_history', generatedAt: new Date(), payments: rows.map((r) => ({ ...r, currency: String(r.currency).trim() })) };
}

/**
 * Dispute record: the case, its timeline and decision. Parties see only what is shared with them
 * (events marked for the parties or written by themselves, their own and shared evidence); staff see all.
 */
export async function disputeRecord(c: Executor, disputeId: string, viewer: { staff: boolean; userId: string }) {
  const d = (await c.query(
    `SELECT d.id, d.number, d.kind, d.type, d.status, d.subject, d.description, d.disputed_amount AS "disputedAmount", d.currency_code AS currency,
            d.held_amount AS "heldAmount", d.decision, d.decided_at AS "decidedAt", d.closed_at AS "closedAt", d.created_at AS "createdAt",
            b.number AS "bookingNumber", d.country_id AS "countryId", d.booking_id AS "bookingId"
       FROM disputes d LEFT JOIN bookings b ON b.id = d.booking_id WHERE d.id = $1`, [disputeId])).rows[0];
  if (!d) throw notFound();
  const events = (await c.query(
    `SELECT actor_role AS "actorRole", action, from_status AS "from", to_status AS "to", note, created_at AS "at" FROM dispute_events
      WHERE dispute_id = $1 AND ($2 OR visibility = 'parties' OR (visibility = 'author' AND actor_id = $3)) ORDER BY created_at`,
    [disputeId, viewer.staff, viewer.userId])).rows;
  const evidence = (await c.query(
    `SELECT party_role AS "partyRole", mime_type AS "mimeType", size_bytes AS "sizeBytes", sha256, description, created_at AS "at" FROM dispute_evidence
      WHERE dispute_id = $1 AND ($2 OR shared OR uploaded_by = $3) ORDER BY created_at`, [disputeId, viewer.staff, viewer.userId])).rows;
  return { kind: 'dispute_record', generatedAt: new Date(), dispute: d, events, evidence };
}
