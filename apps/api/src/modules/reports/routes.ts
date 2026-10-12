import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import type { App, Deps } from '../../deps.js';
import { actorOf, assertCan, can, countryScope, requireKind, requirePermission, requireUser } from '../../auth/guard.js';
import type { Executor } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { forbidden } from '../../lib/errors.js';
import { providerOf } from '../catalog/shared.js';
import { toCsv } from './csv.js';
import * as R from './service.js';

const sec = [{ bearer: [] }];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);

export const REPORTS = [
  'overview', 'revenue', 'commissions', 'payments-by-method', 'payments-by-currency', 'refunds', 'provider-earnings',
  'settlements', 'fund-balances', 'fx-differences', 'bookings-payments', 'discounts', 'disputes', 'trial-balance', 'consolidated',
] as const;
type ReportName = (typeof REPORTS)[number];

const query = z.object({
  country: z.uuid().optional(),
  currency: currency.optional(),
  from: day.optional(),
  to: day.optional(),
  providerId: z.uuid().optional(),
  serviceTypeId: z.uuid().optional(),
  // Optional conversion for a consolidated view; originals are always kept (clause 63).
  displayCurrency: currency.optional(),
  rateDate: day.optional(),
  format: z.enum(['json', 'csv']).default('json'),
  limit: z.coerce.number().int().min(1).max(5000).default(1000),
  offset: z.coerce.number().int().min(0).default(0),
});

function run(c: Executor, name: ReportName, f: R.Filters & { limit: number; offset: number }): Promise<R.ReportResult> {
  switch (name) {
    case 'overview': return R.overview(c, f);
    case 'revenue': return R.revenue(c, f);
    case 'commissions': return R.commissions(c, f);
    case 'payments-by-method': return R.payments(c, f, 'method');
    case 'payments-by-currency': return R.payments(c, f, 'currency');
    case 'refunds': return R.refunds(c, f);
    case 'provider-earnings': return R.earnings(c, f);
    case 'settlements': return R.settlements(c, f);
    case 'fund-balances': return R.fundBalances(c, f);
    case 'fx-differences': return R.fxDifferences(c, f);
    case 'bookings-payments': return R.bookingsPayments(c, f);
    case 'discounts': return R.discounts(c, f);
    case 'disputes': return R.disputesFinancial(c, f);
    case 'trial-balance': return R.trialBalance(c, f);
    case 'consolidated': return R.consolidated(c, f);
  }
}

/** Sends the result as JSON or CSV; exports and conversions are logged with the rates used (clauses 63, 70). */
async function deliver(c: Executor, reply: FastifyReply, ctx: ReturnType<typeof actorOf>, report: string, params: Record<string, unknown>,
  result: R.ReportResult, q: { format: 'json' | 'csv'; displayCurrency?: string | undefined; rateDate?: string | undefined }) {
  let rows = result.rows;
  let conversion: Awaited<ReturnType<typeof R.convert>> | null = null;
  if (q.displayCurrency) {
    const rateDate = q.rateDate ? new Date(`${q.rateDate}T23:59:59.999Z`) : new Date();
    conversion = await R.convert(c, result, q.displayCurrency, rateDate);
    rows = conversion.rows;
  }
  if (q.format === 'csv' || conversion) {
    await c.query(
      `INSERT INTO report_runs (report, params, fx_rates, row_count, format, generated_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [report, JSON.stringify(params), JSON.stringify(conversion?.fxRates ?? []), rows.length, q.format, ctx.actorId]);
  }
  if (q.format === 'csv') {
    await audit(c, ctx, { action: 'report.exported', entityType: 'report', after: { report, params, rows: rows.length, fxRates: conversion?.fxRates ?? [] } });
    return reply.header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${report}.csv"`).send(toCsv(rows));
  }
  return reply.send({
    report, params, rows, moneyFields: result.moneyFields, notes: result.notes ?? [], ...(result.counts ? { counts: result.counts } : {}),
    ...(conversion ? { displayCurrency: q.displayCurrency, convertedTotals: conversion.convertedTotals, fxRates: conversion.fxRates } : {}),
  });
}

export async function reportRoutes(app: App, deps: Deps) {
  const { db } = deps;

  // =============== Admin: operational and financial reports (clauses 61, 63) ===============
  app.get('/admin/reports', { onRequest: deps.authenticate, preValidation: requirePermission('reports.view'), schema: { tags: ['reports'], security: sec } },
    async () => ({ reports: REPORTS }));

  app.get('/admin/reports/:report', {
    onRequest: deps.authenticate, preValidation: requirePermission('reports.view'),
    schema: { tags: ['reports'], security: sec, params: z.object({ report: z.enum(REPORTS) }), querystring: query },
  }, async (req, reply) => {
    const user = requireUser(req);
    const q = req.query;
    if (q.country) assertCan(user, 'reports.view', q.country);
    if (q.format === 'csv' && !(q.country ? can(user, 'reports.export', q.country) : user.grants.has('reports.export'))) throw forbidden();
    // Exports are limited to the countries the user may export, views to those they may view.
    const countries = q.format === 'csv' ? countryScope(user, 'reports.export') : countryScope(user, 'reports.view');
    const f = { countries, countryId: q.country, currency: q.currency, from: q.from, to: q.to, providerId: q.providerId, serviceTypeId: q.serviceTypeId, limit: q.limit, offset: q.offset };
    const params = Object.fromEntries(Object.entries({ ...q, countries }).filter(([, v]) => v !== undefined));
    const result = await run(db, req.params.report, f);
    return deliver(db, reply, actorOf(req), req.params.report, params, result, q);
  });

  // =============== Provider panel: own report (clause 62) ===============
  app.get('/provider/reports/summary', {
    onRequest: deps.authenticate, preValidation: requireKind('provider'),
    schema: { tags: ['reports'], security: sec, querystring: z.object({ from: day.optional(), to: day.optional(), format: z.enum(['json', 'csv']).default('json') }) },
  }, async (req, reply) => {
    const p = await providerOf(db, req, { forWrite: false });
    const result = await R.providerSummary(db, p.id, req.query);
    if (req.query.format === 'csv') {
      return reply.header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="provider-summary.csv"').send(toCsv(result.rows));
    }
    return reply.send({ rows: result.rows, moneyFields: result.moneyFields });
  });
}
