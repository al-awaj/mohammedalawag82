import type { Executor } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { fromUnits, toUnits } from '../../lib/money.js';

/**
 * Reconciliation (clause 39): compares a payment provider's or bank's statement with what the platform
 * recorded for the same integration or fund account and period. It only reports findings; any
 * correction goes through the normal, audited payment and refund flows.
 */
export interface StatementLine {
  externalRef: string;
  kind: 'payment' | 'refund';
  amount: string;
  currency: string;
  status?: 'succeeded' | 'failed' | undefined;
}

export interface RunInput {
  countryId: string;
  integrationId?: string | undefined;
  accountId?: string | undefined;
  periodFrom: string;
  periodTo: string;
  sourceName: string;
  lines: StatementLine[];
}

type Status = 'matched' | 'amount_mismatch' | 'currency_mismatch' | 'missing_in_platform' | 'missing_in_statement' | 'status_mismatch';
interface Item {
  status: Status; kind: 'payment' | 'refund'; externalRef: string | null; paymentId: string | null; refundId: string | null;
  statementAmount: string | null; platformAmount: string | null; currency: string | null; note: string | null;
}
interface PlatformRecord { id: string; kind: 'payment' | 'refund'; external_ref: string | null; amount: string; currency: string; status: string; in_period: boolean }

export async function runReconciliation(c: Executor, input: RunInput, userId: string) {
  const seen = new Set<string>();
  for (const [i, l] of input.lines.entries()) {
    const k = `${l.kind}:${l.externalRef}`;
    if (seen.has(k)) throw badRequest('VALIDATION_FAILED', [{ path: `/lines/${i}/externalRef`, message: 'duplicate reference in statement' }]);
    seen.add(k);
  }
  if (input.integrationId && !(await c.query('SELECT 1 FROM payment_integrations WHERE id = $1 AND country_id = $2', [input.integrationId, input.countryId])).rowCount) throw notFound();
  if (input.accountId && !(await c.query('SELECT 1 FROM ledger_accounts WHERE id = $1 AND country_id = $2', [input.accountId, input.countryId])).rowCount) throw notFound();

  // Platform-side money movements through this integration or fund. Records outside the period are
  // loaded too so a line booked on a different day still matches instead of showing as missing.
  const channel = `(($2::uuid IS NOT NULL AND p.integration_id = $2) OR ($3::uuid IS NOT NULL AND p.account_id = $3))`;
  const records = (await c.query<PlatformRecord>(
    `SELECT p.id, 'payment' AS kind, p.external_ref, coalesce(p.verified_amount, p.amount)::numeric(20,4)::text AS amount, p.currency_code AS currency, p.status,
            (p.succeeded_at >= $4::date AND p.succeeded_at < $5::date + 1) AS in_period
       FROM payments p WHERE p.country_id = $1 AND p.model = 'platform' AND ${channel}
        AND (p.status = 'succeeded' OR p.external_ref IS NOT NULL)
     UNION ALL
     SELECT r.id, 'refund', r.external_ref, r.amount::numeric(20,4)::text, r.currency_code, r.status,
            (r.executed_at >= $4::date AND r.executed_at < $5::date + 1)
       FROM refunds r JOIN payments p ON p.id = r.payment_id
      WHERE p.country_id = $1 AND ${channel} AND (r.status = 'completed' OR r.external_ref IS NOT NULL)`,
    [input.countryId, input.integrationId ?? null, input.accountId ?? null, input.periodFrom, input.periodTo])).rows
    .map((r) => ({ ...r, currency: r.currency.trim() }));
  const byRef = new Map(records.filter((r) => r.external_ref).map((r) => [`${r.kind}:${r.external_ref}`, r]));
  const done = (r: PlatformRecord) => (r.kind === 'payment' ? r.status === 'succeeded' : r.status === 'completed');

  const items: Item[] = [];
  const matched = new Set<string>();
  for (const l of input.lines) {
    const r = byRef.get(`${l.kind}:${l.externalRef}`);
    const base = { kind: l.kind, externalRef: l.externalRef, statementAmount: fromUnits(toUnits(l.amount)), currency: l.currency };
    if (!r) { items.push({ ...base, status: 'missing_in_platform', paymentId: null, refundId: null, platformAmount: null, note: null }); continue; }
    matched.add(r.id);
    const ids = { paymentId: r.kind === 'payment' ? r.id : null, refundId: r.kind === 'refund' ? r.id : null, platformAmount: r.amount };
    const stmtOk = (l.status ?? 'succeeded') === 'succeeded';
    let status: Status = 'matched';
    let note: string | null = null;
    if (stmtOk !== done(r)) { status = 'status_mismatch'; note = `statement ${l.status ?? 'succeeded'}, platform ${r.status}`; }
    else if (l.currency !== r.currency) status = 'currency_mismatch';
    else if (toUnits(l.amount) !== toUnits(r.amount)) status = 'amount_mismatch';
    if (status === 'matched' && !r.in_period) note = 'recorded by the platform outside the statement period';
    items.push({ ...base, ...ids, status, note });
  }
  for (const r of records) {
    if (matched.has(r.id) || !r.in_period || !done(r)) continue;
    items.push({
      status: 'missing_in_statement', kind: r.kind, externalRef: r.external_ref, paymentId: r.kind === 'payment' ? r.id : null,
      refundId: r.kind === 'refund' ? r.id : null, statementAmount: null, platformAmount: r.amount, currency: r.currency,
      note: r.external_ref ? null : 'no external reference recorded on the platform',
    });
  }

  const summary: Record<string, unknown> = { lines: input.lines.length, counts: {} as Record<string, number>, totals: {} as Record<string, { statement: string; platform: string }> };
  const totals = new Map<string, { s: bigint; p: bigint }>();
  for (const it of items) {
    (summary.counts as Record<string, number>)[it.status] = ((summary.counts as Record<string, number>)[it.status] ?? 0) + 1;
    const k = `${it.kind}:${it.currency ?? '-'}`;
    const t = totals.get(k) ?? { s: 0n, p: 0n };
    t.s += toUnits(it.statementAmount ?? '0');
    t.p += toUnits(it.platformAmount ?? '0');
    totals.set(k, t);
  }
  summary.totals = Object.fromEntries([...totals].map(([k, t]) => [k, { statement: fromUnits(t.s), platform: fromUnits(t.p), difference: fromUnits(t.s - t.p) }]));

  const run = (await c.query<{ id: string }>(
    `INSERT INTO reconciliation_runs (country_id, integration_id, account_id, period_from, period_to, source_name, summary, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [input.countryId, input.integrationId ?? null, input.accountId ?? null, input.periodFrom, input.periodTo, input.sourceName, JSON.stringify(summary), userId])).rows[0]!;
  for (const it of items) {
    await c.query(
      `INSERT INTO reconciliation_items (run_id, status, kind, external_ref, payment_id, refund_id, statement_amount, platform_amount, currency_code, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [run.id, it.status, it.kind, it.externalRef, it.paymentId, it.refundId, it.statementAmount, it.platformAmount, it.currency, it.note]);
  }
  return { id: run.id, summary };
}

// ---------------------------------------------------------------------------
// Internal consistency checks: operations vs ledger (clauses 38-42)
// ---------------------------------------------------------------------------

export async function consistencyChecks(c: Executor, countries: string[] | null, countryId: string | null) {
  const scope = `($1::uuid[] IS NULL OR x.country_id = ANY($1)) AND ($2::uuid IS NULL OR x.country_id = $2)`;
  const q = async (sql: string) => (await c.query(sql, [countries, countryId])).rows;
  const checks = {
    // Every entry balances per currency (also enforced at commit; this re-verifies stored data).
    unbalancedEntries: await q(
      `SELECT x.number, l.currency_code AS currency, sum(l.debit)::text AS debit, sum(l.credit)::text AS credit
         FROM journal_entries x JOIN journal_lines l ON l.entry_id = x.id WHERE ${scope}
        GROUP BY x.id, x.number, l.currency_code HAVING sum(l.debit) <> sum(l.credit)`),
    // A succeeded payment without its ledger entry.
    paymentsWithoutEntry: await q(
      `SELECT x.number FROM payments x WHERE ${scope} AND x.status = 'succeeded'
          AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.idempotency_key = 'payment:' || x.id)`),
    // Verified amount must equal what was applied to bookings.
    paymentAllocationMismatch: await q(
      `SELECT x.number, x.verified_amount::text AS verified, sum(a.verified_amount)::text AS allocated
         FROM payments x JOIN payment_allocations a ON a.payment_id = x.id WHERE ${scope} AND x.status = 'succeeded'
        GROUP BY x.id HAVING x.verified_amount <> coalesce(sum(a.verified_amount), 0)`),
    // Completed bookings must have their completion entry and an earning record.
    completedWithoutEntry: await q(
      `SELECT x.number FROM bookings x WHERE ${scope} AND x.status = 'completed'
          AND (NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.idempotency_key = 'booking_completion:' || x.id)
               OR NOT EXISTS (SELECT 1 FROM provider_earnings pe WHERE pe.booking_id = x.id))`),
    refundsWithoutEntry: await q(
      `SELECT r.number FROM refunds r JOIN bookings x ON x.id = r.booking_id WHERE ${scope} AND r.status = 'completed'
          AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.idempotency_key = 'refund_payment:' || r.id)`),
    settlementsWithoutEntry: await q(
      `SELECT x.number FROM settlements x WHERE ${scope} AND x.status = 'paid'
          AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.idempotency_key = 'settlement:' || x.id)`),
    // Before a booking is completed or closed, its customer advances in the ledger must equal what was
    // received for it, less refunds charged to advances and interim settlements already paid.
    advancesMismatch: await q(
      `WITH open_b AS (
         SELECT x.id, x.number, x.country_id, x.currency_code FROM bookings x WHERE ${scope}
            AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.idempotency_key IN ('booking_completion:' || x.id, 'booking_closure:' || x.id)))
       SELECT b.number, b.currency_code AS currency, ledger.v::text AS ledger, expected.v::text AS expected
         FROM open_b b
         CROSS JOIN LATERAL (
           SELECT coalesce(sum(l.credit - l.debit), 0) AS v FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id
            WHERE l.booking_id = b.id AND a.kind = 'customer_advances') ledger
         CROSS JOIN LATERAL (
           SELECT coalesce((SELECT sum(al.verified_amount) FROM payment_allocations al JOIN payments p ON p.id = al.payment_id
                             WHERE al.booking_id = b.id AND p.status = 'succeeded' AND p.model = 'platform'), 0)
                - coalesce((SELECT sum(r.amount) FROM refunds r WHERE r.booking_id = b.id AND r.charge_to = 'customer_advances'
                             AND r.status IN ('approved', 'processing', 'completed')), 0)
                - coalesce((SELECT sum(i.amount) FROM settlement_items i JOIN settlements s ON s.id = i.settlement_id
                             WHERE i.booking_id = b.id AND s.kind = 'interim' AND i.status = 'paid'), 0) AS v) expected
        WHERE ledger.v <> expected.v`),
  };
  const issues = Object.values(checks).reduce((n, rows) => n + rows.length, 0);
  return { ok: issues === 0, issues, checks };
}
