import { describe, expect, it } from 'vitest';
import { linesFromCamt053, linesFromCsv, normaliseAmount, parseCsv } from '../src/modules/reconciliation/import.js';
import { createStaff, upload, useApp } from './helpers.js';

/** Statement files for reconciliation: CSV with column mapping and CAMT.053 (clause 39). */
describe('statement parsing', () => {
  it('reads CSV with quotes, semicolons and amounts in several styles', () => {
    expect(parseCsv('a;b\n"x;1";"he said ""hi"""\n')).toEqual([['a', 'b'], ['x;1', 'he said "hi"']]);
    expect(normaliseAmount('1,234.50')).toEqual({ amount: '1234.50', negative: false });
    expect(normaliseAmount('1.234,50', true)).toEqual({ amount: '1234.50', negative: false });
    expect(normaliseAmount('(75.00)')).toEqual({ amount: '75.00', negative: true });
    expect(normaliseAmount('abc')).toBeNull();
    const csv = 'Reference,Amount,Currency,Type,State\npay_1,"5,000.00",SAR,Charge,captured\npay_2,-120,SAR,refund,succeeded\n,10,SAR,charge,paid\npay_4,10,SAR,mystery,paid\n';
    const r = linesFromCsv(csv, { reference: 'reference', amount: 'Amount', currency: 'Currency', kind: 'Type', status: 'State' });
    expect(r.lines).toEqual([
      { externalRef: 'pay_1', kind: 'payment', amount: '5000.00', currency: 'SAR', status: 'succeeded' },
      { externalRef: 'pay_2', kind: 'refund', amount: '120', currency: 'SAR', status: 'succeeded' },
    ]);
    expect(r.skipped.map((s) => s.row)).toEqual([4, 5]);
    expect(linesFromCsv(csv, { reference: 'nope', amount: 'Amount' }).skipped[0]!.reason).toMatch(/nope/);
    // Without a type column, the sign decides.
    expect(linesFromCsv('ref;amt\nA;-5\nB;7\n', { reference: 'ref', amount: 'amt', defaultCurrency: 'KWD' }).lines.map((l) => l.kind)).toEqual(['refund', 'payment']);
  });

  it('reads CAMT.053 entries', () => {
    const xml = `<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><Stmt>
      <Ntry><Amt Ccy="SAR">2500.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><NtryDtls><TxDtls><Refs><EndToEndId>PAY-0001</EndToEndId></Refs></TxDtls></NtryDtls></Ntry>
      <Ntry><Amt Ccy="SAR">300</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><AcctSvcrRef>RF-9</AcctSvcrRef></Ntry>
      <Ntry><Amt Ccy="SAR">10</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>PDNG</Sts><AcctSvcrRef>X</AcctSvcrRef></Ntry>
      <Ntry><Amt Ccy="SAR">10</Amt><CdtDbtInd>CRDT</CdtDbtInd></Ntry>
    </Stmt></BkToCstmrStmt></Document>`;
    const r = linesFromCamt053(xml);
    expect(r.lines).toEqual([
      { externalRef: 'PAY-0001', kind: 'payment', amount: '2500.00', currency: 'SAR', status: 'succeeded' },
      { externalRef: 'RF-9', kind: 'refund', amount: '300', currency: 'SAR', status: 'succeeded' },
    ]);
    expect(r.skipped).toHaveLength(2);
    expect(linesFromCamt053('<x/>').skipped[0]!.reason).toMatch(/CAMT/);
  });
});

describe('parse endpoint', () => {
  const ctx = useApp();
  it('needs finance.reconcile and returns lines without storing anything', async () => {
    const fin = await createStaff(ctx, [{ code: 'finance_officer' }]);
    const other = await createStaff(ctx, [{ code: 'services_supervisor' }]);
    const csv = Buffer.from('ref,amount\nP-1,100.00\n');
    expect((await upload(ctx, '/v1/admin/reconciliation/parse', other.token, csv, { format: 'csv', referenceColumn: 'ref', amountColumn: 'amount', defaultCurrency: 'SAR' })).status).toBe(403);
    const before = (await ctx.db.query('SELECT count(*)::int AS n FROM reconciliation_runs')).rows[0].n;
    const r = await upload(ctx, '/v1/admin/reconciliation/parse', fin.token, csv, { format: 'csv', referenceColumn: 'ref', amountColumn: 'amount', defaultCurrency: 'SAR' });
    expect(r.status).toBe(200);
    expect(r.body.lines).toEqual([{ externalRef: 'P-1', kind: 'payment', amount: '100.00', currency: 'SAR' }]);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM reconciliation_runs')).rows[0].n).toBe(before);
    expect((await upload(ctx, '/v1/admin/reconciliation/parse', fin.token, csv, { format: 'csv', referenceColumn: 'ref', amountColumn: 'amount' })).status).toBe(400);
  });
});
