import type { Executor } from '../../db/pool.js';
import { AppError } from '../../lib/errors.js';
import { fromUnits, mulRate, roundToMinor, toUnits } from '../../lib/money.js';
import { findRate } from '../reference/routes.js';

/**
 * Report filters. Dates are inclusive calendar days in UTC. `countries` is the caller's country scope
 * (null = all); every report respects it.
 */
export interface Filters {
  countries: string[] | null;
  countryId?: string | undefined;
  currency?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  providerId?: string | undefined;
  serviceTypeId?: string | undefined;
}

export type Row = Record<string, unknown>;
export interface ReportResult { rows: Row[]; moneyFields: string[]; notes?: string[]; counts?: Row[] }

const p = (f: Filters) => [f.countries, f.countryId ?? null, f.currency ?? null, f.from ?? null, f.to ?? null, f.providerId ?? null, f.serviceTypeId ?? null];
/** Standard WHERE fragment over a country column, a currency column and a timestamp column. */
const scope = (country: string, currency: string | null, ts: string | null) => [
  `($1::uuid[] IS NULL OR ${country} = ANY($1))`, `($2::uuid IS NULL OR ${country} = $2)`,
  currency ? `($3::text IS NULL OR ${currency} = $3)` : 'true',
  ts ? `($4::date IS NULL OR ${ts} >= $4::date)` : 'true',
  ts ? `($5::date IS NULL OR ${ts} < $5::date + 1)` : 'true',
  // Every parameter is typed even when a report does not filter on it (PostgreSQL needs a type for each).
  '($3::text IS NULL OR true) AND ($4::date IS NULL OR true) AND ($5::date IS NULL OR true) AND ($6::uuid IS NULL OR true) AND ($7::uuid IS NULL OR true)',
].join(' AND ');
const money = (col: string) => `coalesce(${col}, 0)::numeric(20,4)::text`;

/** Ledger movement of an account kind in the period, in its natural sign, per country and currency. */
async function ledgerByKind(c: Executor, f: Filters, kinds: string[]) {
  return (await c.query<{ country_id: string; currency: string; kind: string; amount: string }>(
    `SELECT a.country_id, a.currency_code AS currency, a.kind,
            ${money(`sum(CASE WHEN a.type IN ('asset', 'expense') THEN l.debit - l.credit ELSE l.credit - l.debit END)`)} AS amount
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.id = l.account_id
      WHERE ${scope('a.country_id', 'a.currency_code', 'e.occurred_at')} AND a.kind = ANY($8)
        AND ($6::uuid IS NULL OR l.provider_id = $6)
      GROUP BY a.country_id, a.currency_code, a.kind`, [...p(f), kinds])).rows;
}

// ---------------------------------------------------------------------------
// Clause 61: operational overview
// ---------------------------------------------------------------------------

export async function overview(c: Executor, f: Filters): Promise<ReportResult> {
  const counts = await overviewCounts(c, f);
  const rows = (await c.query(
    `WITH b AS (
       SELECT b.*, coalesce((SELECT sum(a.verified_amount) FROM payment_allocations a JOIN payments py ON py.id = a.payment_id
                              WHERE a.booking_id = b.id AND py.status = 'succeeded'), 0) AS paid
         FROM bookings b JOIN services s ON s.id = b.service_id
        WHERE ${scope('b.country_id', 'b.currency_code', 'b.created_at')} AND ($6::uuid IS NULL OR b.provider_id = $6) AND ($7::uuid IS NULL OR s.service_type_id = $7))
     SELECT b.country_id AS "countryId", b.currency_code AS currency,
            count(*)::int AS "bookingsCreated",
            count(*) FILTER (WHERE status IN ('pending_provider_approval', 'awaiting_payment'))::int AS "bookingsPending",
            count(*) FILTER (WHERE status IN ('confirmed', 'in_progress'))::int AS "bookingsConfirmed",
            count(*) FILTER (WHERE status = 'completed')::int AS "bookingsCompleted",
            count(*) FILTER (WHERE status LIKE 'cancelled%' OR status IN ('rejected', 'expired'))::int AS "bookingsCancelled",
            count(*) FILTER (WHERE status = 'no_show')::int AS "bookingsNotDelivered",
            ${money(`sum(total) FILTER (WHERE status IN ('confirmed', 'in_progress', 'completed', 'no_show'))`)} AS "bookingsValue",
            ${money(`sum(paid)`)} AS paid,
            ${money(`sum(total - paid) FILTER (WHERE status IN ('confirmed', 'in_progress', 'completed'))`)} AS remaining
       FROM b GROUP BY b.country_id, b.currency_code ORDER BY 1, 2`, p(f))).rows;

  const extra = async (sql: string) => new Map((await c.query<{ k: string; v: string; n: number }>(sql, p(f))).rows.map((r) => [r.k, r]));
  const failed = await extra(
    `SELECT country_id || ':' || currency_code AS k, ${money('sum(amount)')} AS v, count(*)::int AS n FROM payments
      WHERE ${scope('country_id', 'currency_code', 'created_at')} AND status = 'failed' AND ($6::uuid IS NULL OR provider_id = $6) GROUP BY 1`);
  const refunded = await extra(
    `SELECT b.country_id || ':' || r.currency_code AS k, ${money('sum(r.amount)')} AS v, count(*)::int AS n FROM refunds r JOIN bookings b ON b.id = r.booking_id
      WHERE ${scope('b.country_id', 'r.currency_code', 'r.executed_at')} AND r.status = 'completed' AND ($6::uuid IS NULL OR b.provider_id = $6) GROUP BY 1`);
  const ledger = await ledgerByKind(c, f, ['commission_revenue']);
  const earnings = await extra(
    `SELECT country_id || ':' || currency_code || ':' || status AS k, ${money('sum(net_amount)')} AS v, count(*)::int AS n FROM provider_earnings
      WHERE ${scope('country_id', 'currency_code', null)} AND ($6::uuid IS NULL OR provider_id = $6) GROUP BY 1`);
  const settlements = await extra(
    `SELECT country_id || ':' || currency_code || ':' || status AS k, ${money('sum(amount)')} AS v, count(*)::int AS n FROM settlements
      WHERE ${scope('country_id', 'currency_code', 'created_at')} AND ($6::uuid IS NULL OR provider_id = $6) GROUP BY 1`);

  const keys = new Set([...rows.map((r) => `${r.countryId}:${r.currency.trim()}`), ...ledger.map((l) => `${l.country_id}:${l.currency.trim()}`)]);
  const byKey = new Map(rows.map((r) => [`${r.countryId}:${r.currency.trim()}`, r]));
  const sumStatus = (map: Map<string, { v: string }>, k: string, statuses: string[]) =>
    fromUnits(statuses.reduce((s, st) => s + toUnits(map.get(`${k}:${st}`)?.v ?? '0'), 0n));
  const out = [...keys].sort().map((k) => {
    const [countryId, currency] = k.split(':') as [string, string];
    const base = byKey.get(k) ?? { countryId, currency, bookingsCreated: 0, bookingsPending: 0, bookingsConfirmed: 0, bookingsCompleted: 0, bookingsCancelled: 0, bookingsNotDelivered: 0, bookingsValue: '0.0000', paid: '0.0000', remaining: '0.0000' };
    return {
      ...base, currency,
      failedPayments: failed.get(k)?.n ?? 0, failedPaymentsAmount: failed.get(k)?.v ?? '0.0000',
      refunded: refunded.get(k)?.v ?? '0.0000',
      commissionRevenue: ledger.find((l) => `${l.country_id}:${l.currency.trim()}` === k)?.amount ?? '0.0000',
      providerEarningsDue: sumStatus(earnings, k, ['due', 'ready_for_settlement', 'settlement_failed', 're_reviewed']),
      providerEarningsOnHold: sumStatus(earnings, k, ['on_hold_dispute']),
      providerEarningsSettled: sumStatus(earnings, k, ['settled']),
      settlementsPaid: sumStatus(settlements, k, ['paid']),
      settlementsPending: sumStatus(settlements, k, ['pending_approval', 'approved']),
    };
  });
  return {
    rows: out, counts,
    moneyFields: ['bookingsValue', 'paid', 'remaining', 'failedPaymentsAmount', 'refunded', 'commissionRevenue', 'providerEarningsDue', 'providerEarningsOnHold', 'providerEarningsSettled', 'settlementsPaid', 'settlementsPending'],
    notes: [
      'Booking value is not platform revenue: platform revenue is the recognised commission (clause 63).',
    ],
  };
}

export async function overviewCounts(c: Executor, f: Filters) {
  return (await c.query(
    `SELECT co.id AS "countryId", co.code AS "countryCode",
       (SELECT count(*)::int FROM users u WHERE u.country_id = co.id AND u.kind = 'customer') AS customers,
       (SELECT count(*)::int FROM providers pr WHERE pr.country_id = co.id) AS providers,
       (SELECT count(*)::int FROM services s WHERE s.country_id = co.id AND s.status = 'published') AS "publishedServices",
       (SELECT count(*)::int FROM disputes d WHERE d.country_id = co.id AND d.status NOT IN ('settled', 'closed', 'rejected')) AS "openDisputes",
       (SELECT count(*)::int FROM disputes d WHERE d.country_id = co.id AND d.status IN ('settled', 'closed', 'rejected')) AS "closedDisputes"
       FROM countries co WHERE ($1::uuid[] IS NULL OR co.id = ANY($1)) AND ($2::uuid IS NULL OR co.id = $2) ORDER BY co.code`,
    [f.countries, f.countryId ?? null])).rows;
}

// ---------------------------------------------------------------------------
// Clause 63: financial reports
// ---------------------------------------------------------------------------

/** 63.1 Platform revenue = recognised commission; discounts borne and provider fees shown separately, never netted silently. */
export async function revenue(c: Executor, f: Filters): Promise<ReportResult> {
  const rows = await ledgerByKind(c, f, ['commission_revenue', 'platform_discount_cost', 'gateway_fees']);
  const keys = [...new Set(rows.map((r) => `${r.country_id}:${r.currency.trim()}`))].sort();
  return {
    rows: keys.map((k) => {
      const [countryId, currency] = k.split(':') as [string, string];
      const get = (kind: string) => rows.find((r) => r.country_id === countryId && r.currency.trim() === currency && r.kind === kind)?.amount ?? '0.0000';
      return { countryId, currency, commissionRevenue: get('commission_revenue'), platformDiscountCost: get('platform_discount_cost'), paymentProviderFees: get('gateway_fees') };
    }),
    moneyFields: ['commissionRevenue', 'platformDiscountCost', 'paymentProviderFees'],
  };
}

/** 63.2 Commissions booked (snapshot at booking) vs recognised (ledger) per country and currency. */
export async function commissions(c: Executor, f: Filters): Promise<ReportResult> {
  const booked = (await c.query<{ country_id: string; currency: string; booked: string; bookings: number }>(
    `SELECT b.country_id, bc.currency_code AS currency, ${money('sum(bc.commission_amount)')} AS booked, count(*)::int AS bookings
       FROM booking_commissions bc JOIN bookings b ON b.id = bc.booking_id JOIN services s ON s.id = b.service_id
      WHERE ${scope('b.country_id', 'bc.currency_code', 'bc.computed_at')} AND b.status NOT IN ('expired', 'rejected')
        AND ($6::uuid IS NULL OR b.provider_id = $6) AND ($7::uuid IS NULL OR s.service_type_id = $7)
      GROUP BY 1, 2`, p(f))).rows;
  const recognised = await ledgerByKind(c, f, ['commission_revenue']);
  const keys = [...new Set([...booked.map((r) => `${r.country_id}:${r.currency.trim()}`), ...recognised.map((r) => `${r.country_id}:${r.currency.trim()}`)])].sort();
  return {
    rows: keys.map((k) => {
      const [countryId, currency] = k.split(':') as [string, string];
      const b = booked.find((r) => `${r.country_id}:${r.currency.trim()}` === k);
      return { countryId, currency, bookings: b?.bookings ?? 0, commissionBooked: b?.booked ?? '0.0000',
        commissionRecognised: recognised.find((r) => `${r.country_id}:${r.currency.trim()}` === k)?.amount ?? '0.0000' };
    }),
    moneyFields: ['commissionBooked', 'commissionRecognised'],
  };
}

/** 63.3 / 63.4 Payments grouped by method (and model) or by currency. */
export async function payments(c: Executor, f: Filters, by: 'method' | 'currency'): Promise<ReportResult> {
  const group = by === 'method' ? 'country_id, currency_code, model, method' : 'country_id, currency_code';
  const rows = (await c.query(
    `SELECT country_id AS "countryId", currency_code AS currency ${by === 'method' ? ', model, method' : ''},
            count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded, ${money(`sum(verified_amount) FILTER (WHERE status = 'succeeded')`)} AS "amountReceived",
            ${money(`sum(gateway_fee) FILTER (WHERE status = 'succeeded')`)} AS "providerFees",
            count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status IN ('pending', 'awaiting_verification'))::int AS "inProgress",
            count(*) FILTER (WHERE needs_attention IS NOT NULL)::int AS "needsAttention"
       FROM payments WHERE ${scope('country_id', 'currency_code', 'created_at')} AND ($6::uuid IS NULL OR provider_id = $6 OR EXISTS (
              SELECT 1 FROM payment_allocations a JOIN bookings b ON b.id = a.booking_id WHERE a.payment_id = payments.id AND b.provider_id = $6))
      GROUP BY ${group} ORDER BY ${group}`, p(f))).rows;
  return { rows: rows.map((r) => ({ ...r, currency: String(r.currency).trim() })), moneyFields: ['amountReceived', 'providerFees'] };
}

/** 63.5 Refunds by source and status. */
export async function refunds(c: Executor, f: Filters): Promise<ReportResult> {
  const rows = (await c.query(
    `SELECT b.country_id AS "countryId", r.currency_code AS currency, r.source, r.status, r.charge_to AS "chargedTo", count(*)::int AS count, ${money('sum(r.amount)')} AS amount
       FROM refunds r JOIN bookings b ON b.id = r.booking_id
      WHERE ${scope('b.country_id', 'r.currency_code', 'r.created_at')} AND ($6::uuid IS NULL OR b.provider_id = $6)
      GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4`, p(f))).rows;
  return { rows: rows.map((r) => ({ ...r, currency: String(r.currency).trim() })), moneyFields: ['amount'] };
}

/** 63.6 Provider earnings by status (payables kept apart from platform revenue). */
export async function earnings(c: Executor, f: Filters): Promise<ReportResult> {
  const rows = (await c.query(
    `SELECT e.country_id AS "countryId", e.currency_code AS currency, e.provider_id AS "providerId", pr.business_name AS "providerName", e.status,
            count(*)::int AS bookings, ${money('sum(e.collected_by_platform)')} AS "collectedByPlatform", ${money('sum(e.collected_directly)')} AS "collectedDirectly",
            ${money('sum(e.commission_amount)')} AS commission, ${money('sum(e.net_amount)')} AS net
       FROM provider_earnings e JOIN providers pr ON pr.id = e.provider_id
      WHERE ${scope('e.country_id', 'e.currency_code', 'e.created_at')} AND ($6::uuid IS NULL OR e.provider_id = $6)
      GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 4, 5`, p(f))).rows;
  return { rows: rows.map((r) => ({ ...r, currency: String(r.currency).trim() })), moneyFields: ['collectedByPlatform', 'collectedDirectly', 'commission', 'net'] };
}

/** 63.7 Settlements by kind and status. */
export async function settlements(c: Executor, f: Filters): Promise<ReportResult> {
  const rows = (await c.query(
    `SELECT s.country_id AS "countryId", s.currency_code AS currency, s.kind, s.status, count(*)::int AS count, ${money('sum(s.amount)')} AS amount
       FROM settlements s WHERE ${scope('s.country_id', 's.currency_code', 's.created_at')} AND ($6::uuid IS NULL OR s.provider_id = $6)
      GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`, p(f))).rows;
  return { rows: rows.map((r) => ({ ...r, currency: String(r.currency).trim() })), moneyFields: ['amount'] };
}

/** 63.8 Balances of cash boxes, bank accounts, wallets and gateway receivables at the end of the period. */
export async function fundBalances(c: Executor, f: Filters): Promise<ReportResult> {
  const rows = (await c.query(
    `SELECT a.country_id AS "countryId", a.currency_code AS currency, a.code, a.kind, a.name, a.is_active AS "isActive",
            ${money(`(SELECT sum(l.debit - l.credit) FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id
                       WHERE l.account_id = a.id AND ($5::date IS NULL OR e.occurred_at < $5::date + 1))`)} AS balance
       FROM ledger_accounts a WHERE ${scope('a.country_id', 'a.currency_code', null)} AND a.kind IN ('cash', 'bank', 'wallet', 'gateway')
      ORDER BY 1, 2, 3`, p(f))).rows;
  return { rows: rows.map((r) => ({ ...r, currency: String(r.currency).trim() })), moneyFields: ['balance'] };
}

/**
 * 63.9 Realised exchange differences posted to the FX account. The platform settles every booking in
 * its own currency, so this is non-zero only once conversions are posted; report conversions are
 * listed with each report that uses them (rate, date, source).
 */
export async function fxDifferences(c: Executor, f: Filters): Promise<ReportResult> {
  const rows = (await c.query(
    `SELECT a.country_id AS "countryId", a.currency_code AS currency, e.number AS "entryNumber", e.occurred_at AS "occurredAt", e.description,
            ${money('l.debit - l.credit')} AS amount
       FROM journal_lines l JOIN journal_entries e ON e.id = l.entry_id JOIN ledger_accounts a ON a.id = l.account_id
      WHERE ${scope('a.country_id', 'a.currency_code', 'e.occurred_at')} AND a.kind = 'fx_difference' AND ($6::uuid IS NULL OR l.provider_id = $6)
      ORDER BY e.occurred_at`, p(f))).rows;
  return { rows: rows.map((r) => ({ ...r, currency: String(r.currency).trim() })), moneyFields: ['amount'],
    notes: rows.length ? [] : ['No realised FX differences: all transactions settle in the booking currency.'] };
}

/** 63.10 Bookings with what was paid and what remains. */
export async function bookingsPayments(c: Executor, f: Filters & { limit: number; offset: number }): Promise<ReportResult> {
  const rows = (await c.query(
    `SELECT b.number, b.country_id AS "countryId", b.currency_code AS currency, b.status, b.start_at AS "startAt", pr.business_name AS "providerName",
            ${money('b.total')} AS total, ${money('b.upfront_amount')} AS "upfrontRequired", ${money('pd.paid')} AS paid,
            ${money(`CASE WHEN b.status IN ('confirmed', 'in_progress', 'completed', 'awaiting_payment') THEN b.total - pd.paid ELSE 0 END`)} AS remaining,
            b.balance_due_at AS "balanceDueAt"
       FROM bookings b JOIN providers pr ON pr.id = b.provider_id JOIN services s ON s.id = b.service_id
       CROSS JOIN LATERAL (SELECT coalesce(sum(a.verified_amount), 0) AS paid FROM payment_allocations a JOIN payments py ON py.id = a.payment_id
                            WHERE a.booking_id = b.id AND py.status = 'succeeded') pd
      WHERE ${scope('b.country_id', 'b.currency_code', 'b.start_at')} AND ($6::uuid IS NULL OR b.provider_id = $6) AND ($7::uuid IS NULL OR s.service_type_id = $7)
      ORDER BY b.start_at LIMIT $8 OFFSET $9`, [...p(f), f.limit, f.offset])).rows;
  return { rows: rows.map((r) => ({ ...r, currency: String(r.currency).trim() })), moneyFields: ['total', 'upfrontRequired', 'paid', 'remaining'] };
}

/** 63.11 Discounts and promotions: who bore what. */
export async function discounts(c: Executor, f: Filters): Promise<ReportResult> {
  const rows = (await c.query(
    `SELECT b.country_id AS "countryId", b.currency_code AS currency, pm.code, pm.cost_bearer AS "costBearer", count(*)::int AS bookings,
            ${money('sum(b.discount_amount)')} AS discount, ${money('sum(b.discount_platform_borne)')} AS "platformBorne", ${money('sum(b.discount_provider_borne)')} AS "providerBorne"
       FROM promotion_redemptions r JOIN bookings b ON b.id = r.booking_id JOIN promotions pm ON pm.id = r.promotion_id
      WHERE ${scope('b.country_id', 'b.currency_code', 'r.created_at')} AND r.status = 'active' AND ($6::uuid IS NULL OR b.provider_id = $6)
      GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3`, p(f))).rows;
  return { rows: rows.map((r) => ({ ...r, currency: String(r.currency).trim() })), moneyFields: ['discount', 'platformBorne', 'providerBorne'] };
}

/** 63.12 Disputes with a financial effect. */
export async function disputesFinancial(c: Executor, f: Filters): Promise<ReportResult> {
  const rows = (await c.query(
    `SELECT d.number, d.country_id AS "countryId", d.currency_code AS currency, d.status, d.type, ${money('d.disputed_amount')} AS "disputedAmount",
            ${money('d.held_amount')} AS "heldAmount", ${money(`(d.decision->>'refundAmount')::numeric`)} AS "decidedRefund", d.decision->>'chargeTo' AS "chargedTo",
            ${money(`(SELECT sum(r.amount) FROM refunds r WHERE r.dispute_id = d.id AND r.status = 'completed')`)} AS refunded
       FROM disputes d LEFT JOIN bookings b ON b.id = d.booking_id
      WHERE ${scope('d.country_id', 'd.currency_code', 'd.created_at')} AND (d.disputed_amount IS NOT NULL OR d.decision ? 'refundAmount')
        AND ($6::uuid IS NULL OR b.provider_id = $6)
      ORDER BY d.created_at`, p(f))).rows;
  return { rows: rows.map((r) => ({ ...r, currency: r.currency ? String(r.currency).trim() : null })), moneyFields: ['disputedAmount', 'heldAmount', 'decidedRefund', 'refunded'] };
}

/** 63.13 Trial balance per country and currency, from posted entries only (clause 64). */
export async function trialBalance(c: Executor, f: Filters): Promise<ReportResult> {
  const rows = (await c.query(
    `SELECT a.country_id AS "countryId", a.currency_code AS currency, a.code, a.kind, a.type,
            ${money(`sum(l.debit - l.credit) FILTER (WHERE $4::date IS NOT NULL AND e.occurred_at < $4::date)`)} AS opening,
            ${money(`sum(l.debit) FILTER (WHERE ($4::date IS NULL OR e.occurred_at >= $4::date) AND ($5::date IS NULL OR e.occurred_at < $5::date + 1))`)} AS debit,
            ${money(`sum(l.credit) FILTER (WHERE ($4::date IS NULL OR e.occurred_at >= $4::date) AND ($5::date IS NULL OR e.occurred_at < $5::date + 1))`)} AS credit,
            ${money(`sum(l.debit - l.credit) FILTER (WHERE $5::date IS NULL OR e.occurred_at < $5::date + 1)`)} AS closing
       FROM ledger_accounts a LEFT JOIN journal_lines l ON l.account_id = a.id LEFT JOIN journal_entries e ON e.id = l.entry_id
      WHERE ${scope('a.country_id', 'a.currency_code', null)}
      GROUP BY a.id ORDER BY a.country_id, a.currency_code, a.code`, p(f))).rows;
  const out = rows.map((r) => ({ ...r, currency: String(r.currency).trim() }));
  // Balanced per country and currency, never across currencies.
  const groups = new Map<string, { d: bigint; c: bigint }>();
  for (const r of out) {
    const k = `${r.countryId}:${r.currency}`;
    const g = groups.get(k) ?? { d: 0n, c: 0n };
    g.d += toUnits(String(r.debit));
    g.c += toUnits(String(r.credit));
    groups.set(k, g);
  }
  const unbalanced = [...groups.entries()].filter(([, g]) => g.d !== g.c).map(([k]) => k);
  return { rows: out, moneyFields: ['opening', 'debit', 'credit', 'closing'], notes: [unbalanced.length ? `UNBALANCED: ${unbalanced.join(', ')}` : 'Balanced for every country and currency.'] };
}

/** 63.14 Consolidated position by account kind across countries (per currency; convert with displayCurrency). */
export async function consolidated(c: Executor, f: Filters): Promise<ReportResult> {
  const rows = (await c.query(
    `SELECT a.currency_code AS currency, a.kind, a.type,
            ${money(`sum(CASE WHEN a.type IN ('asset', 'expense') OR a.kind = 'direct_payments_memo' THEN l.debit - l.credit ELSE l.credit - l.debit END)`)} AS balance
       FROM ledger_accounts a JOIN journal_lines l ON l.account_id = a.id JOIN journal_entries e ON e.id = l.entry_id
      WHERE ${scope('a.country_id', 'a.currency_code', null)} AND ($5::date IS NULL OR e.occurred_at < $5::date + 1)
        AND ($6::uuid IS NULL OR l.provider_id = $6)
      GROUP BY 1, 2, 3 ORDER BY 2, 1`, p(f))).rows;
  return { rows: rows.map((r) => ({ ...r, currency: String(r.currency).trim() })), moneyFields: ['balance'] };
}

// ---------------------------------------------------------------------------
// Clause 62: provider report
// ---------------------------------------------------------------------------

export async function providerSummary(c: Executor, providerId: string, f: { from?: string | undefined; to?: string | undefined }): Promise<ReportResult> {
  const rows = (await c.query(
    `SELECT s.id AS "serviceId", s.title AS "serviceTitle", b.currency_code AS currency,
            count(b.*)::int AS bookings,
            count(b.*) FILTER (WHERE b.status = 'completed')::int AS completed,
            count(b.*) FILTER (WHERE b.status LIKE 'cancelled%' OR b.status = 'no_show')::int AS "cancelledOrNoShow",
            ${money(`sum(b.total) FILTER (WHERE b.status = 'completed')`)} AS "completedValue",
            ${money(`sum(pd.paid)`)} AS "paymentsReceived",
            ${money(`sum(e.commission_amount)`)} AS commission,
            ${money(`sum(e.net_amount)`)} AS net,
            ${money(`sum(st.settled)`)} AS settled,
            ${money(`sum(e.net_amount) - sum(st.settled)`)} AS outstanding,
            ${money(`sum(rf.refunded)`)} AS refunded,
            (SELECT round(avg(rv.rating), 2)::text FROM reviews rv WHERE rv.service_id = s.id AND rv.status = 'published') AS rating
       FROM services s JOIN bookings b ON b.service_id = s.id
       LEFT JOIN provider_earnings e ON e.booking_id = b.id
       CROSS JOIN LATERAL (SELECT coalesce(sum(a.verified_amount), 0) AS paid FROM payment_allocations a JOIN payments py ON py.id = a.payment_id WHERE a.booking_id = b.id AND py.status = 'succeeded') pd
       CROSS JOIN LATERAL (SELECT coalesce(sum(i.amount), 0) AS settled FROM settlement_items i WHERE i.booking_id = b.id AND i.status = 'paid') st
       CROSS JOIN LATERAL (SELECT coalesce(sum(r.amount), 0) AS refunded FROM refunds r WHERE r.booking_id = b.id AND r.status = 'completed') rf
      WHERE s.provider_id = $1 AND ($2::date IS NULL OR b.start_at >= $2::date) AND ($3::date IS NULL OR b.start_at < $3::date + 1)
      GROUP BY s.id, s.title, b.currency_code ORDER BY s.id`, [providerId, f.from ?? null, f.to ?? null])).rows;
  return { rows: rows.map((r) => ({ ...r, currency: String(r.currency).trim() })), moneyFields: ['completedValue', 'paymentsReceived', 'commission', 'net', 'settled', 'outstanding', 'refunded'] };
}

// ---------------------------------------------------------------------------
// Multi-currency (clause 63): convert only with a documented, dated rate; never sum currencies directly.
// ---------------------------------------------------------------------------

export interface FxUsed { from: string; to: string; rate: string; rateId: string | null; effectiveAt: Date; source: string; inverted: boolean }

export async function convert(c: Executor, result: ReportResult, displayCurrency: string, rateDate: Date) {
  const currencies = [...new Set(result.rows.map((r) => r.currency).filter(Boolean) as string[])];
  const rates = new Map<string, FxUsed>();
  const missing: string[] = [];
  for (const cur of currencies) {
    const r = await findRate(c, cur, displayCurrency, rateDate);
    if (!r) missing.push(`${cur}->${displayCurrency}`);
    else rates.set(cur, { from: cur, to: displayCurrency, rate: r.rate, rateId: r.id, effectiveAt: r.effectiveAt, source: r.source, inverted: r.inverted });
  }
  if (missing.length) throw new AppError('FX_RATE_MISSING', 409, { missing, rateDate });
  const minor = (await c.query<{ m: number }>('SELECT minor_units AS m FROM currencies WHERE code = $1', [displayCurrency])).rows[0]?.m ?? 2;
  const totals: Record<string, bigint> = Object.fromEntries(result.moneyFields.map((f) => [f, 0n]));
  const rows = result.rows.map((row) => {
    const fx = row.currency ? rates.get(String(row.currency)) : undefined;
    const extra: Row = {};
    for (const fld of result.moneyFields) {
      if (!fx || row[fld] === null || row[fld] === undefined) continue;
      const v = roundToMinor(mulRate(toUnits(String(row[fld])), fx.rate), minor);
      extra[`${fld}Converted`] = fromUnits(v);
      totals[fld]! += v;
    }
    // The original currency and amount stay next to the converted value (clause 63).
    return { ...row, ...extra, convertedCurrency: displayCurrency };
  });
  return {
    rows,
    convertedTotals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, fromUnits(v)])),
    fxRates: [...rates.values()],
  };
}
