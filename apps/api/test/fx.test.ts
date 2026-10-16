import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, upload, PDF, useApp } from './helpers.js';
import { marketplace } from './fixtures.js';

/** Payments received in another currency (clause 11): stored conversion, exchange difference in the ledger. */
const ctx = useApp();
let m: Awaited<ReturnType<typeof marketplace>>;
beforeAll(async () => { m = await marketplace(ctx, 'PAY_SANDBOX_FX_SECRET'); });

async function transfer() {
  const h = await m.hall();
  const c = await m.customer();
  const o = await m.order(c.token, h.serviceId);
  const r = await ctx.app.inject({ method: 'POST', url: `/v1/orders/${o.id}/payments`, headers: { authorization: `Bearer ${c.token}`, 'idempotency-key': randomUUID() },
    payload: { model: 'platform', method: 'bank_transfer', purpose: 'upfront' } });
  const p = JSON.parse(r.body);
  await upload(ctx, `/v1/payments/${p.id}/proofs`, c.token, PDF, {}, 'proof.pdf');
  return p as { id: string; amount: string };
}
const review = (id: string, body: object) => api(ctx, 'POST', `/v1/admin/payments/${id}/review`, { token: m.financeA.token, body: { decision: 'approve', note: 'Transfer seen on the statement', ...body } });

describe('foreign-currency receipts', () => {
  it('needs a rate, stores the conversion and books the exchange difference', async () => {
    const p = await transfer(); // 5,000 SAR upfront
    expect((await review(p.id, { received: { currency: 'EUR', amount: '1330' } })).body.error.code).toBe('FX_RATE_MISSING');
    await api(ctx, 'POST', '/v1/admin/exchange-rates', { token: m.admin.token, body: { base: 'EUR', quote: 'SAR', rate: '3.75', source: 'Central bank' } });
    // 1,330 USD × 3.75 = 4,987.50 SAR; the customer is credited 5,000; a 12.50 SAR bank fee.
    const r = await review(p.id, { received: { currency: 'EUR', amount: '1330', conversionFee: '12.50' } });
    expect(r.status).toBe(200);
    const row = (await ctx.db.query('SELECT received_currency, received_amount, fx_rate, fx_rate_source, converted_amount, fx_conversion_fee, fx_difference, verified_amount FROM payments WHERE id = $1', [p.id])).rows[0];
    expect(row).toMatchObject({ received_currency: 'EUR', received_amount: '1330.0000', fx_rate_source: 'Central bank', converted_amount: '4987.5000', fx_conversion_fee: '12.5000', fx_difference: '12.5000', verified_amount: '5000.0000' });
    expect(Number(row.fx_rate)).toBe(3.75);
    const lines = (await ctx.db.query(
      `SELECT a.kind, l.debit, l.credit FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.source_type = 'payment' AND e.source_id = $1 ORDER BY a.kind`, [p.id])).rows;
    const by = Object.fromEntries(lines.map((l) => [l.kind, l]));
    expect(by.bank).toMatchObject({ debit: '4975.0000' });         // what really reached the account
    expect(by.gateway_fees).toMatchObject({ debit: '12.5000' });   // the bank's conversion fee
    expect(by.fx_difference).toMatchObject({ debit: '12.5000' });  // exchange loss
    expect(by.customer_advances).toMatchObject({ credit: '5000.0000' });
    // A later rate change never rewrites it.
    await api(ctx, 'POST', '/v1/admin/exchange-rates', { token: m.admin.token, body: { base: 'EUR', quote: 'SAR', rate: '3.80', source: 'Central bank' } });
    await expect(ctx.db.query('UPDATE payments SET fx_rate = 3.8 WHERE id = $1', [p.id])).rejects.toThrow(/immutable/);
  });

  it('accepts an entered rate and books a gain as a credit', async () => {
    const p = await transfer();
    const r = await review(p.id, { received: { currency: 'EUR', amount: '1340', rate: '3.75', rateSource: 'Bank advice 7781' } });
    expect(r.status).toBe(200);
    const row = (await ctx.db.query('SELECT fx_difference, fx_rate_source FROM payments WHERE id = $1', [p.id])).rows[0];
    expect(row).toMatchObject({ fx_difference: '-25.0000', fx_rate_source: 'Bank advice 7781' });
    const fx = (await ctx.db.query(
      `SELECT l.credit FROM journal_lines l JOIN ledger_accounts a ON a.id = l.account_id JOIN journal_entries e ON e.id = l.entry_id
        WHERE e.source_id = $1 AND a.kind = 'fx_difference'`, [p.id])).rows[0];
    expect(fx.credit).toBe('25.0000');
  });
});
