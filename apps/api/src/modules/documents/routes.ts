import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { App, Deps } from '../../deps.js';
import { assertCan, can, countryScope, requireKind, requirePermission, requireUser } from '../../auth/guard.js';
import type { Executor } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { idParams, paginationQuery } from '../common.js';
import { partyRole } from '../disputes/service.js';
import { renderHtml } from './render.js';
import { balanceNotice, bookingStatement, disputeRecord, paymentHistory, type DocumentRow } from './service.js';

const sec = [{ bearer: [] }];
const view = z.object({ format: z.enum(['json', 'html']).default('json'), lang: z.enum(['ar', 'en']).default('ar') });

const COLUMNS = `d.id, d.number, d.kind, d.country_id AS "countryId", d.source_type AS "sourceType", d.booking_id AS "bookingId",
  d.currency_code AS currency, d.total, d.issued_at AS "issuedAt"`;

/** Customer: own documents; provider: own documents; staff: documents.print in the document's country. */
async function canSee(c: Executor, req: FastifyRequest, doc: { country_id: string; customer_id: string | null; provider_id: string | null }) {
  const u = requireUser(req);
  if (u.kind === 'staff') return can(u, 'documents.print', doc.country_id);
  if (u.kind === 'customer') return doc.customer_id === u.id;
  if (!doc.provider_id) return false;
  return (await c.query('SELECT 1 FROM providers WHERE id = $1 AND user_id = $2', [doc.provider_id, u.id])).rowCount === 1;
}

/** Booking statements: the booking's customer, its provider, or staff with documents.print in its country. */
async function bookingAccess(c: Executor, req: FastifyRequest, bookingId: string) {
  const b = (await c.query<{ country_id: string; customer_id: string; provider_id: string }>(
    'SELECT country_id, customer_id, provider_id FROM bookings WHERE id = $1', [bookingId])).rows[0];
  if (!b || !(await canSee(c, req, b))) throw notFound();
}

function send(reply: FastifyReply, payload: { kind: string; number?: string | null; issuedAt?: unknown; data: Record<string, unknown> }, q: z.infer<typeof view>) {
  if (q.format === 'html') return reply.header('content-type', 'text/html; charset=utf-8').send(renderHtml(payload, q.lang));
  return reply.send(payload.number ? { id: (payload as { id?: string }).id, number: payload.number, kind: payload.kind, issuedAt: payload.issuedAt, data: payload.data } : payload.data);
}

export async function documentRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const auth = { onRequest: deps.authenticate };

  // =============== Own documents (customer / provider) ===============
  app.get('/documents', {
    ...auth, preValidation: requireKind('customer', 'provider'),
    schema: { tags: ['documents'], security: sec, querystring: paginationQuery.extend({ bookingId: z.uuid().optional() }) },
  }, async (req) => {
    const u = requireUser(req);
    const owner = u.kind === 'customer' ? 'd.customer_id = $1' : 'd.provider_id = (SELECT id FROM providers WHERE user_id = $1)';
    return (await db.query(
      `SELECT ${COLUMNS} FROM documents d WHERE ${owner} AND ($2::uuid IS NULL OR d.booking_id = $2)
        ORDER BY d.issued_at DESC LIMIT $3 OFFSET $4`, [u.id, req.query.bookingId ?? null, req.query.limit, req.query.offset])).rows;
  });

  app.get('/documents/:id', { ...auth, schema: { tags: ['documents'], security: sec, params: idParams, querystring: view } }, async (req, reply) => {
    const doc = (await db.query<DocumentRow>('SELECT * FROM documents WHERE id = $1', [req.params.id])).rows[0];
    if (!doc || !(await canSee(db, req, doc))) throw notFound();
    return send(reply, { ...doc, issuedAt: doc.issued_at }, req.query);
  });

  // =============== Statements (unnumbered, generated from current data) ===============
  app.get('/bookings/:id/statement', { ...auth, schema: { tags: ['documents'], security: sec, params: idParams, querystring: view } }, async (req, reply) => {
    await bookingAccess(db, req, req.params.id);
    const s = await bookingStatement(db, req.params.id);
    return send(reply, { kind: s.kind, data: s }, req.query);
  });

  app.get('/bookings/:id/balance-notice', { ...auth, schema: { tags: ['documents'], security: sec, params: idParams, querystring: view } }, async (req, reply) => {
    await bookingAccess(db, req, req.params.id);
    const s = await balanceNotice(db, req.params.id);
    return send(reply, { kind: s.kind, data: s }, req.query);
  });

  app.get('/me/payment-history', {
    ...auth, preValidation: requireKind('customer'), schema: { tags: ['documents'], security: sec, querystring: view },
  }, async (req, reply) => {
    const s = await paymentHistory(db, requireUser(req).id);
    return send(reply, { kind: s.kind, data: s }, req.query);
  });

  app.get('/disputes/:id/record', { ...auth, schema: { tags: ['documents'], security: sec, params: idParams, querystring: view } }, async (req, reply) => {
    const u = requireUser(req);
    const d = (await db.query<{ country_id: string; booking_id: string | null; complainant_id: string; complainant_role: 'customer' | 'provider'; respondent_role: 'customer' | 'provider' | null }>(
      'SELECT country_id, booking_id, complainant_id, complainant_role, respondent_role FROM disputes WHERE id = $1', [req.params.id])).rows[0];
    if (!d) throw notFound();
    const staff = u.kind === 'staff';
    if (staff ? !can(u, 'disputes.view', d.country_id) : !(await partyRole(db, d, u))) throw notFound();
    const s = await disputeRecord(db, req.params.id, { staff, userId: u.id });
    return send(reply, { kind: s.kind, data: s as unknown as Record<string, unknown> }, req.query);
  });

  // =============== Admin ===============
  app.get('/admin/documents', {
    ...auth, preValidation: requirePermission('documents.print'),
    schema: {
      tags: ['documents'], security: sec,
      querystring: paginationQuery.extend({
        country: z.uuid().optional(), kind: z.enum(['invoice', 'payment_receipt', 'deposit_receipt', 'refund_note', 'settlement_note']).optional(),
        bookingId: z.uuid().optional(), number: z.string().max(40).optional(),
      }),
    },
  }, async (req) => {
    const u = requireUser(req);
    const q = req.query;
    if (q.country) assertCan(u, 'documents.print', q.country);
    return (await db.query(
      `SELECT ${COLUMNS}, d.customer_id AS "customerId", d.provider_id AS "providerId" FROM documents d
        WHERE ($1::uuid[] IS NULL OR d.country_id = ANY($1)) AND ($2::uuid IS NULL OR d.country_id = $2) AND ($3::text IS NULL OR d.kind = $3)
          AND ($4::uuid IS NULL OR d.booking_id = $4) AND ($5::text IS NULL OR d.number = $5)
        ORDER BY d.issued_at DESC LIMIT $6 OFFSET $7`,
      [countryScope(u, 'documents.print'), q.country ?? null, q.kind ?? null, q.bookingId ?? null, q.number ?? null, q.limit, q.offset])).rows;
  });
}
