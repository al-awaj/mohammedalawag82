import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, assertCan, countryScope, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { idParams, paginationQuery, reasonSchema } from '../common.js';
import { consistencyChecks, runReconciliation } from './service.js';

const sec = [{ bearer: [] }];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const STATUSES = ['matched', 'amount_mismatch', 'currency_mismatch', 'missing_in_platform', 'missing_in_statement', 'status_mismatch'] as const;

export async function reconciliationRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const staff = (perm: Parameters<typeof requirePermission>[0]) => ({ onRequest: deps.authenticate, preValidation: requirePermission(perm) });

  app.post('/admin/reconciliation/runs', {
    ...staff('finance.reconcile'),
    schema: {
      tags: ['reconciliation'], security: sec,
      body: z.object({
        countryId: z.uuid(), integrationId: z.uuid().optional(), accountId: z.uuid().optional(),
        periodFrom: day, periodTo: day, sourceName: z.string().trim().min(2).max(200),
        lines: z.array(z.object({
          externalRef: z.string().trim().min(1).max(200), kind: z.enum(['payment', 'refund']),
          amount: z.string().regex(/^\d{1,16}(\.\d{1,4})?$/), currency: z.string().regex(/^[A-Z]{3}$/),
          status: z.enum(['succeeded', 'failed']).optional(),
        })).max(5000),
      }),
    },
  }, async (req, reply) => {
    const b = req.body;
    assertCan(requireUser(req), 'finance.reconcile', b.countryId);
    if (!b.integrationId === !b.accountId) throw badRequest('VALIDATION_FAILED', [{ path: '/integrationId', message: 'give exactly one of integrationId or accountId' }]);
    if (b.periodTo < b.periodFrom) throw badRequest('VALIDATION_FAILED', [{ path: '/periodTo', message: 'must not be before periodFrom' }]);
    const r = await withTx(db, async (c) => {
      const out = await runReconciliation(c, b, requireUser(req).id);
      await audit(c, actorOf(req), { action: 'reconciliation.run', entityType: 'reconciliation_run', entityId: out.id, after: { sourceName: b.sourceName, periodFrom: b.periodFrom, periodTo: b.periodTo, summary: out.summary } });
      return out;
    });
    return reply.status(201).send(r);
  });

  app.get('/admin/reconciliation/runs', {
    ...staff('finance.reconcile'),
    schema: { tags: ['reconciliation'], security: sec, querystring: paginationQuery.extend({ country: z.uuid().optional() }) },
  }, async (req) => {
    const u = requireUser(req);
    if (req.query.country) assertCan(u, 'finance.reconcile', req.query.country);
    return (await db.query(
      `SELECT id, country_id AS "countryId", integration_id AS "integrationId", account_id AS "accountId", period_from AS "periodFrom", period_to AS "periodTo",
              source_name AS "sourceName", summary, created_by AS "createdBy", created_at AS "createdAt"
         FROM reconciliation_runs x WHERE ($1::uuid[] IS NULL OR x.country_id = ANY($1)) AND ($2::uuid IS NULL OR x.country_id = $2)
        ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [countryScope(u, 'finance.reconcile'), req.query.country ?? null, req.query.limit, req.query.offset])).rows;
  });

  app.get('/admin/reconciliation/runs/:id', {
    ...staff('finance.reconcile'),
    schema: { tags: ['reconciliation'], security: sec, params: idParams, querystring: z.object({ status: z.enum(STATUSES).optional(), unresolved: z.stringbool().optional() }) },
  }, async (req) => {
    const run = (await db.query<{ country_id: string }>('SELECT * FROM reconciliation_runs WHERE id = $1', [req.params.id])).rows[0];
    if (!run) throw notFound();
    assertCan(requireUser(req), 'finance.reconcile', run.country_id);
    const items = (await db.query(
      `SELECT i.id, i.status, i.kind, i.external_ref AS "externalRef", p.number AS "paymentNumber", r.number AS "refundNumber",
              i.statement_amount AS "statementAmount", i.platform_amount AS "platformAmount", i.currency_code AS currency, i.note,
              i.resolved_by AS "resolvedBy", i.resolved_at AS "resolvedAt", i.resolution
         FROM reconciliation_items i LEFT JOIN payments p ON p.id = i.payment_id LEFT JOIN refunds r ON r.id = i.refund_id
        WHERE i.run_id = $1 AND ($2::text IS NULL OR i.status = $2) AND ($3::boolean IS NULL OR (i.resolved_at IS NULL) = $3)
        ORDER BY i.status, i.external_ref`, [req.params.id, req.query.status ?? null, req.query.unresolved ?? null])).rows;
    return { ...run, items: items.map((i) => ({ ...i, currency: i.currency ? String(i.currency).trim() : null })) };
  });

  // Records how a finding was handled; money corrections themselves go through payments/refunds.
  app.post('/admin/reconciliation/items/:id/resolve', {
    ...staff('finance.reconcile'),
    schema: { tags: ['reconciliation'], security: sec, params: idParams, body: z.object({ resolution: reasonSchema }) },
  }, async (req) => withTx(db, async (c) => {
    const it = (await c.query<{ status: string; resolved_at: Date | null; country_id: string }>(
      `SELECT i.status, i.resolved_at, r.country_id FROM reconciliation_items i JOIN reconciliation_runs r ON r.id = i.run_id WHERE i.id = $1 FOR UPDATE OF i`,
      [req.params.id])).rows[0];
    if (!it) throw notFound();
    assertCan(requireUser(req), 'finance.reconcile', it.country_id);
    if (it.resolved_at) throw conflict('RECONCILIATION_ITEM_RESOLVED');
    await c.query('UPDATE reconciliation_items SET resolved_by = $2, resolved_at = now(), resolution = $3 WHERE id = $1', [req.params.id, requireUser(req).id, req.body.resolution]);
    await audit(c, actorOf(req), { action: 'reconciliation.item_resolved', entityType: 'reconciliation_item', entityId: req.params.id, reason: req.body.resolution, after: { status: it.status } });
    return { id: req.params.id, resolved: true };
  }));

  app.get('/admin/reconciliation/checks', {
    ...staff('finance.reconcile'),
    schema: { tags: ['reconciliation'], security: sec, querystring: z.object({ country: z.uuid().optional() }) },
  }, async (req) => {
    const u = requireUser(req);
    if (req.query.country) assertCan(u, 'finance.reconcile', req.query.country);
    return consistencyChecks(db, countryScope(u, 'finance.reconcile'), req.query.country ?? null);
  });
}
