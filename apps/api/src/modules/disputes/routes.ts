import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, assertCan, can, countryScope, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { DOCUMENT_TYPES } from '../../lib/storage.js';
import { idParams, paginationQuery, reasonSchema } from '../common.js';
import { addStatement, decideDispute, holdEarning, openDispute, partyRole, settleDispute, staffAction, type DisputeRow } from './service.js';

const sec = [{ bearer: [] }];
const money = z.string().regex(/^\d{1,16}(\.\d{1,4})?$/);
const TYPES = ['service_not_delivered', 'service_quality', 'billing', 'refund', 'damage', 'behaviour', 'other'] as const;

const COLUMNS = `d.id, d.number, d.kind, d.booking_id AS "bookingId", b.number AS "bookingNumber", d.type, d.subject, d.description,
  d.complainant_role AS "complainantRole", d.respondent_role AS "respondentRole", d.disputed_amount AS "disputedAmount", d.currency_code AS currency,
  d.held_amount AS "heldAmount", d.status, d.decision, d.decided_at AS "decidedAt", d.closed_at AS "closedAt", d.created_at AS "createdAt"`;

export async function disputeRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const auth = { onRequest: deps.authenticate };

  // =============== Parties (customers and providers) ===============
  app.post('/disputes', {
    ...auth,
    schema: {
      tags: ['disputes'], security: sec,
      body: z.object({
        kind: z.enum(['dispute', 'complaint']).default('dispute'), bookingId: z.uuid().optional(), type: z.enum(TYPES),
        subject: z.string().trim().min(3).max(200), description: z.string().trim().min(10).max(10_000), disputedAmount: money.optional(),
      }),
    },
  }, async (req, reply) => reply.status(201).send(await openDispute(db, requireUser(req), req.body, actorOf(req))));

  app.get('/disputes', { ...auth, schema: { tags: ['disputes'], security: sec } }, async (req) => {
    const u = requireUser(req);
    if (u.kind === 'staff') throw forbidden();
    return (await db.query(
      `SELECT ${COLUMNS} FROM disputes d LEFT JOIN bookings b ON b.id = d.booking_id LEFT JOIN providers p ON p.id = b.provider_id
        WHERE d.complainant_id = $1
           OR (d.respondent_role = 'customer' AND b.customer_id = $1)
           OR (d.respondent_role = 'provider' AND p.user_id = $1)
        ORDER BY d.created_at DESC`, [u.id])).rows;
  });

  /** A party sees the case, shared events, their own statements, and evidence that is theirs or shared with them. */
  app.get('/disputes/:id', { ...auth, schema: { tags: ['disputes'], security: sec, params: idParams } }, async (req) => {
    const u = requireUser(req);
    const d = (await db.query(`SELECT ${COLUMNS}, d.complainant_id, d.booking_id FROM disputes d LEFT JOIN bookings b ON b.id = d.booking_id WHERE d.id = $1`, [req.params.id])).rows[0];
    if (!d || u.kind === 'staff') throw notFound();
    const role = await partyRole(db, { booking_id: d.booking_id, complainant_id: d.complainant_id, complainant_role: d.complainantRole, respondent_role: d.respondentRole }, u);
    if (!role) throw notFound();
    const events = (await db.query(
      `SELECT action, actor_role AS "actorRole", from_status AS "from", to_status AS "to", note, created_at AS at FROM dispute_events
        WHERE dispute_id = $1 AND (visibility = 'parties' OR (visibility = 'author' AND actor_id = $2)) ORDER BY created_at, id`, [d.id, u.id])).rows;
    const evidence = (await db.query(
      `SELECT id, party_role AS "partyRole", mime_type AS "mimeType", size_bytes AS "sizeBytes", sha256, description, created_at AS "createdAt"
         FROM dispute_evidence WHERE dispute_id = $1 AND (uploaded_by = $2 OR shared) ORDER BY created_at`, [d.id, u.id])).rows;
    const { complainant_id: _c, booking_id: _b, ...pub } = d;
    return { ...pub, myRole: role, events, evidence };
  });

  app.post('/disputes/:id/statements', { ...auth, schema: { tags: ['disputes'], security: sec, params: idParams, body: z.object({ note: z.string().trim().min(3).max(10_000) }) } },
    async (req) => addStatement(db, requireUser(req), req.params.id, req.body.note, actorOf(req)));

  app.post('/disputes/:id/evidence', { ...auth, schema: { tags: ['disputes'], security: sec, params: idParams, consumes: ['multipart/form-data'] } }, async (req, reply) => {
    const u = requireUser(req);
    const d = (await db.query<DisputeRow>('SELECT * FROM disputes WHERE id = $1', [req.params.id])).rows[0];
    if (!d) throw notFound();
    const role = u.kind === 'staff' ? (can(u, 'disputes.review', d.country_id) ? 'staff' : null) : await partyRole(db, d, u);
    if (!role) throw notFound();
    if (d.status === 'closed') throw badRequest('INVALID_STATUS_TRANSITION', { from: d.status });
    const file = await req.file();
    if (!file) throw badRequest('VALIDATION_FAILED', [{ path: '/file', message: 'file is required' }]);
    const desc = file.fields.description as { value?: unknown } | undefined;
    const stored = await deps.storage.save(`disputes/${d.id}`, await file.toBuffer(), DOCUMENT_TYPES);
    const id = await withTx(db, async (c) => {
      const eid = (await c.query<{ id: string }>(
        `INSERT INTO dispute_evidence (dispute_id, uploaded_by, party_role, file_key, mime_type, size_bytes, sha256, description) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [d.id, u.id, role, stored.key, stored.mime, stored.size, stored.sha256, typeof desc?.value === 'string' ? desc.value.slice(0, 500) : null])).rows[0]!.id;
      await c.query(`INSERT INTO dispute_events (dispute_id, actor_id, actor_role, action, note) VALUES ($1, $2, $3, 'evidence_added', $4)`, [d.id, u.id, role, stored.sha256]);
      await audit(c, actorOf(req), { action: 'dispute.evidence_added', entityType: 'dispute', entityId: d.id, after: { evidenceId: eid, sha256: stored.sha256 } });
      return eid;
    });
    return reply.status(201).send({ id });
  });

  app.get('/disputes/:id/evidence/:evidenceId', { ...auth, schema: { tags: ['disputes'], security: sec, params: z.object({ id: z.uuid(), evidenceId: z.uuid() }) } }, async (req, reply) => {
    const u = requireUser(req);
    const row = (await db.query<{ file_key: string; mime_type: string; uploaded_by: string; shared: boolean } & DisputeRow>(
      `SELECT e.file_key, e.mime_type, e.uploaded_by, e.shared, d.* FROM dispute_evidence e JOIN disputes d ON d.id = e.dispute_id WHERE e.id = $1 AND d.id = $2`,
      [req.params.evidenceId, req.params.id])).rows[0];
    if (!row) throw notFound();
    const allowed = u.kind === 'staff' ? can(u, 'disputes.view', row.country_id)
      : (await partyRole(db, row, u)) !== null && (row.uploaded_by === u.id || row.shared);
    if (!allowed) throw notFound();
    const f = await deps.storage.open(row.file_key);
    return reply.header('cache-control', 'private, no-store').type(row.mime_type).send(f.stream);
  });

  // =============== Staff ===============
  app.get('/admin/disputes', {
    onRequest: deps.authenticate, preValidation: requirePermission('disputes.view'),
    schema: { tags: ['admin:disputes'], security: sec, querystring: paginationQuery.extend({ status: z.string().max(30).optional(), assignedToMe: z.enum(['true']).optional(), kind: z.enum(['dispute', 'complaint']).optional() }) },
  }, async (req) => {
    const u = requireUser(req);
    const scope = countryScope(u, 'disputes.view');
    const q = req.query;
    return (await db.query(
      `SELECT ${COLUMNS}, d.assigned_to AS "assignedTo", d.country_id AS "countryId" FROM disputes d LEFT JOIN bookings b ON b.id = d.booking_id
        WHERE ($1::uuid[] IS NULL OR d.country_id = ANY($1)) AND ($2::text IS NULL OR d.status = $2) AND ($3::boolean IS NULL OR d.assigned_to = $4)
          AND ($5::text IS NULL OR d.kind = $5)
        ORDER BY d.created_at DESC LIMIT $6 OFFSET $7`, [scope, q.status ?? null, q.assignedToMe ? true : null, u.id, q.kind ?? null, q.limit, q.offset])).rows;
  });

  app.get('/admin/disputes/:id', { onRequest: deps.authenticate, preValidation: requirePermission('disputes.view'), schema: { tags: ['admin:disputes'], security: sec, params: idParams } }, async (req) => {
    const d = (await db.query(`SELECT ${COLUMNS}, d.assigned_to AS "assignedTo", d.country_id AS "countryId", d.complainant_id AS "complainantId" FROM disputes d LEFT JOIN bookings b ON b.id = d.booking_id WHERE d.id = $1`, [req.params.id])).rows[0];
    if (!d || !can(requireUser(req), 'disputes.view', d.countryId)) throw notFound();
    d.events = (await db.query(`SELECT action, actor_id AS "actorId", actor_role AS "actorRole", from_status AS "from", to_status AS "to", note, visibility, created_at AS at FROM dispute_events WHERE dispute_id = $1 ORDER BY created_at, id`, [d.id])).rows;
    d.evidence = (await db.query(`SELECT id, party_role AS "partyRole", uploaded_by AS "uploadedBy", mime_type AS "mimeType", sha256, description, shared, created_at AS "createdAt" FROM dispute_evidence WHERE dispute_id = $1 ORDER BY created_at`, [d.id])).rows;
    d.refunds = (await db.query(`SELECT id, number, amount, status, charge_to AS "chargeTo" FROM refunds WHERE dispute_id = $1 ORDER BY created_at`, [d.id])).rows;
    return d;
  });

  const scoped = async (req: { params: unknown }, perm: 'disputes.review' | 'disputes.decide', user: ReturnType<typeof requireUser>) => {
    const d = (await db.query<{ country_id: string }>('SELECT country_id FROM disputes WHERE id = $1', [(req.params as { id: string }).id])).rows[0];
    if (!d) throw notFound();
    assertCan(user, perm, d.country_id);
  };

  app.post('/admin/disputes/:id/actions', {
    onRequest: deps.authenticate, preValidation: requirePermission('disputes.review'),
    schema: {
      tags: ['admin:disputes'], security: sec, params: idParams,
      body: z.object({
        action: z.enum(['start_review', 'request_info', 'request_response', 'note', 'to_decision', 'assign', 'close']),
        note: z.string().trim().min(2).max(5000).optional(), from: z.enum(['customer', 'provider']).optional(), assignee: z.uuid().optional(),
      }),
    },
  }, async (req) => {
    await scoped(req, 'disputes.review', requireUser(req));
    return staffAction(db, req.params.id, req.body.action, req.body, actorOf(req));
  });

  app.post('/admin/disputes/:id/evidence/:evidenceId/share', {
    onRequest: deps.authenticate, preValidation: requirePermission('disputes.review'),
    schema: { tags: ['admin:disputes'], security: sec, params: z.object({ id: z.uuid(), evidenceId: z.uuid() }), body: z.object({ shared: z.boolean(), reason: reasonSchema }) },
  }, async (req) => {
    await scoped(req, 'disputes.review', requireUser(req));
    return withTx(db, async (c) => {
      const r = await c.query('UPDATE dispute_evidence SET shared = $3 WHERE id = $1 AND dispute_id = $2', [req.params.evidenceId, req.params.id, req.body.shared]);
      if (!r.rowCount) throw notFound();
      await audit(c, actorOf(req), { action: 'dispute.evidence_shared', entityType: 'dispute', entityId: req.params.id, after: { evidenceId: req.params.evidenceId, shared: req.body.shared }, reason: req.body.reason });
      return { shared: req.body.shared };
    });
  });

  app.post('/admin/disputes/:id/hold', {
    onRequest: deps.authenticate, preValidation: requirePermission('disputes.decide'),
    schema: { tags: ['admin:disputes'], security: sec, params: idParams, body: z.object({ amount: money }) },
  }, async (req) => {
    await scoped(req, 'disputes.decide', requireUser(req));
    return holdEarning(db, req.params.id, req.body.amount, actorOf(req));
  });

  app.post('/admin/disputes/:id/decide', {
    onRequest: deps.authenticate, preValidation: requirePermission('disputes.decide'),
    schema: {
      tags: ['admin:disputes'], security: sec, params: idParams,
      body: z.object({ outcome: z.enum(['approve', 'reject']), rationale: z.string().trim().min(10).max(5000), refundAmount: money.optional(), chargeTo: z.enum(['provider', 'platform']).optional() }),
    },
  }, async (req) => {
    await scoped(req, 'disputes.decide', requireUser(req));
    return decideDispute(db, req.params.id, req.body, actorOf(req));
  });

  app.post('/admin/disputes/:id/settle', {
    onRequest: deps.authenticate, preValidation: requirePermission('disputes.decide'), schema: { tags: ['admin:disputes'], security: sec, params: idParams },
  }, async (req) => {
    await scoped(req, 'disputes.decide', requireUser(req));
    return settleDispute(db, req.params.id, actorOf(req));
  });
}
