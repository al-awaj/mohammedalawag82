import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, can, countryScope, requireKind, requirePermission, requireUser } from '../../auth/guard.js';
import { audit } from '../../lib/audit.js';
import { getSetting } from '../settings/registry.js';
import { badRequest, conflict, forbidden, mapUniqueViolation, notFound } from '../../lib/errors.js';
import { notifyUser } from '../../lib/notify.js';
import { withTx } from '../../db/pool.js';
import { emailSchema, idParams, paginationQuery, phoneSchema, reasonSchema } from '../common.js';
import { ProviderApplicationService, STAFF_TRANSITIONS, type StaffAction } from './service.js';

const fields = z.object({
  businessName: z.string().trim().min(2).max(200),
  activityType: z.string().trim().min(2).max(100),
  countryCode: z.string().length(2).toUpperCase(),
  city: z.string().trim().min(2).max(100),
  phone: phoneSchema,
  email: emailSchema.nullish(),
  address: z.string().trim().max(500).nullish(),
  latitude: z.number().min(-90).max(90).nullish(),
  longitude: z.number().min(-180).max(180).nullish(),
  description: z.string().trim().max(5000).nullish(),
  payoutDetails: z.record(z.string(), z.unknown()).nullish(),
});

const STATUSES = ['draft', 'submitted', 'under_review', 'needs_info', 'approved', 'rejected', 'suspended', 'cancelled'] as const;

export async function providerRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const svc = new ProviderApplicationService(db);
  const providerOnly = { onRequest: deps.authenticate, preValidation: requireKind('provider') };

  async function loadApplication(id: string, includeSensitive: boolean) {
    const a = (await db.query(
      `SELECT a.id, a.user_id AS "userId", a.status, a.business_name AS "businessName", a.activity_type AS "activityType",
              co.code AS "countryCode", a.country_id AS "countryId", a.city, a.phone, a.email, a.address, a.latitude, a.longitude,
              a.description, ${includeSensitive ? 'a.payout_details' : 'NULL'} AS "payoutDetails",
              a.submitted_at AS "submittedAt", a.decided_at AS "decidedAt", d.full_name AS "decidedBy",
              a.decision_reason AS "decisionReason", a.created_at AS "createdAt", a.updated_at AS "updatedAt"
         FROM provider_applications a JOIN countries co ON co.id = a.country_id
         LEFT JOIN users d ON d.id = a.decided_by WHERE a.id = $1`, [id])).rows[0];
    if (!a) return null;
    a.documents = (await db.query(
      `SELECT id, doc_type AS "docType", original_name AS "originalName", mime_type AS "mimeType", size_bytes AS "sizeBytes",
              sha256, created_at AS "createdAt" FROM provider_application_documents WHERE application_id = $1 ORDER BY created_at`, [id])).rows;
    a.history = (await db.query(
      `SELECT e.from_status AS "from", e.to_status AS "to", e.reason, u.full_name AS "actor", e.created_at AS "at"
         FROM provider_application_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.application_id = $1 ORDER BY e.created_at, e.id`, [id])).rows;
    return a;
  }

  // ---------------- Applicant (provider account) ----------------
  app.post('/provider-applications', { ...providerOnly, schema: { tags: ['provider-onboarding'], security: [{ bearer: [] }], body: fields } },
    async (req, reply) => reply.status(201).send({ id: await svc.create(requireUser(req), req.body, actorOf(req)) }));

  /** What an application in a country must include, so the form can ask for it up front. */
  app.get('/provider-applications/requirements', {
    ...providerOnly, schema: { tags: ['provider-onboarding'], security: [{ bearer: [] }], querystring: z.object({ country: z.string().length(2).toUpperCase() }) },
  }, async (req) => {
    const c = (await db.query<{ id: string }>('SELECT id FROM countries WHERE code = $1 AND is_active', [req.query.country])).rows[0];
    if (!c) throw notFound();
    return { requiredDocuments: await getSetting(db, 'providers.required_documents', c.id) };
  });

  app.get('/provider-applications/mine', { ...providerOnly, schema: { tags: ['provider-onboarding'], security: [{ bearer: [] }] } }, async (req) => {
    const ids = (await db.query<{ id: string }>('SELECT id FROM provider_applications WHERE user_id = $1 ORDER BY created_at DESC', [requireUser(req).id])).rows;
    return Promise.all(ids.map((r) => loadApplication(r.id, true)));
  });

  app.patch('/provider-applications/:id', {
    ...providerOnly, schema: { tags: ['provider-onboarding'], security: [{ bearer: [] }], params: idParams, body: fields.partial() },
  }, async (req, reply) => {
    await svc.update(requireUser(req), req.params.id, req.body, actorOf(req));
    return reply.status(204).send();
  });

  app.post('/provider-applications/:id/documents', {
    ...providerOnly,
    schema: { tags: ['provider-onboarding'], security: [{ bearer: [] }], params: idParams, consumes: ['multipart/form-data'] },
  }, async (req, reply) => {
    const file = await req.file();
    if (!file) throw badRequest('VALIDATION_FAILED', [{ path: '/file', message: 'file is required' }]);
    const docTypeField = file.fields.docType as { value?: unknown } | undefined;
    const docType = typeof docTypeField?.value === 'string' ? docTypeField.value : '';
    if (!/^[a-z_]{2,50}$/.test(docType)) throw badRequest('VALIDATION_FAILED', [{ path: '/docType', message: 'docType field must precede the file' }]);
    const buf = await file.toBuffer();
    const stored = await deps.storage.save(`provider-applications/${req.params.id}`, buf);
    const id = await svc.addDocument(requireUser(req), req.params.id, {
      docType, key: stored.key, originalName: file.filename.slice(0, 255), mime: stored.mime, size: stored.size, sha256: stored.sha256,
    }, actorOf(req));
    return reply.status(201).send({ id, docType, mimeType: stored.mime, sizeBytes: stored.size });
  });

  app.post('/provider-applications/:id/submit', {
    ...providerOnly, schema: { tags: ['provider-onboarding'], security: [{ bearer: [] }], params: idParams, body: z.object({ acceptTerms: z.boolean() }) },
  }, async (req, reply) => {
    await svc.submit(requireUser(req), req.params.id, req.body.acceptTerms, actorOf(req));
    return reply.status(204).send();
  });

  app.post('/provider-applications/:id/cancel', {
    ...providerOnly, schema: { tags: ['provider-onboarding'], security: [{ bearer: [] }], params: idParams },
  }, async (req, reply) => {
    await svc.cancel(requireUser(req), req.params.id, actorOf(req));
    return reply.status(204).send();
  });

  /** The approved provider's own business profile (provider panel). */
  app.get('/provider/me', { ...providerOnly, schema: { tags: ['provider-panel'], security: [{ bearer: [] }] } }, async (req) => {
    const p = (await db.query(
      `SELECT p.id, p.business_name AS "businessName", p.activity_type AS "activityType", c.code AS "countryCode", p.city,
              p.address, p.latitude, p.longitude, p.description, p.payout_details AS "payoutDetails", p.status,
              p.status_reason AS "statusReason", p.show_identity AS "showIdentity",
              p.interim_settlement_eligible AS "interimSettlementEligible", p.created_at AS "createdAt"
         FROM providers p JOIN countries c ON c.id = p.country_id WHERE p.user_id = $1`, [requireUser(req).id])).rows[0];
    if (!p) throw notFound();
    return p;
  });

  /** Day-to-day details an approved provider keeps up to date directly; every change is audited. */
  app.patch('/provider/me', {
    ...providerOnly,
    schema: {
      tags: ['provider-panel'], security: [{ bearer: [] }],
      body: z.object({
        city: fields.shape.city, address: fields.shape.address, description: fields.shape.description,
        latitude: fields.shape.latitude, longitude: fields.shape.longitude,
      }).partial().refine((b) => Object.keys(b).length > 0, 'nothing to change'),
    },
  }, async (req) => {
    const b = req.body;
    return withTx(db, async (c) => {
      const before = (await c.query('SELECT id, city, address, description, latitude, longitude, status FROM providers WHERE user_id = $1 FOR UPDATE', [requireUser(req).id])).rows[0];
      if (!before) throw notFound();
      if (before.status !== 'active') throw conflict('INVALID_STATUS', { status: before.status });
      const lat = b.latitude !== undefined ? b.latitude : before.latitude;
      const lng = b.longitude !== undefined ? b.longitude : before.longitude;
      if ((lat === null) !== (lng === null)) throw badRequest('VALIDATION_FAILED', [{ path: '/latitude', message: 'latitude and longitude go together' }]);
      const has = (k: string) => Object.hasOwn(b, k);
      await c.query(
        `UPDATE providers SET city = coalesce($2, city), address = CASE WHEN $3 THEN $4 ELSE address END,
           description = CASE WHEN $5 THEN $6 ELSE description END, latitude = $7, longitude = $8 WHERE id = $1`,
        [before.id, b.city ?? null, has('address'), b.address ?? null, has('description'), b.description ?? null, lat, lng]);
      const { id: _i, status: _s, ...prev } = before;
      await audit(c, actorOf(req), { action: 'provider.profile_updated', entityType: 'provider', entityId: before.id, before: prev, after: b });
      return { ok: true };
    });
  });

  /** Name, activity and payout details change only after the administration approves (clause 7). */
  const changeFields = z.object({
    businessName: fields.shape.businessName, activityType: fields.shape.activityType,
    payoutDetails: z.record(z.string(), z.unknown()),
  }).partial();
  app.post('/provider/me/change-requests', {
    ...providerOnly,
    schema: {
      tags: ['provider-panel'], security: [{ bearer: [] }],
      body: z.object({ changes: changeFields.refine((x) => Object.keys(x).length > 0, 'nothing to change'), note: z.string().trim().max(1000).nullish() }),
    },
  }, async (req, reply) => {
    const user = requireUser(req);
    const id = await withTx(db, async (c) => {
      const p = (await c.query<{ id: string; status: string }>('SELECT id, status FROM providers WHERE user_id = $1', [user.id])).rows[0];
      if (!p) throw notFound();
      if (p.status !== 'active') throw conflict('INVALID_STATUS', { status: p.status });
      const row = await c.query<{ id: string }>(
        `INSERT INTO provider_profile_changes (provider_id, changes, note, requested_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [p.id, JSON.stringify(req.body.changes), req.body.note ?? null, user.id]).catch((e) => mapUniqueViolation(e, { provider_profile_changes_open: 'CHANGE_REQUEST_PENDING' }));
      // Payout details are sensitive: the audit trail records that they changed, not their content.
      await audit(c, actorOf(req), { action: 'provider.change_requested', entityType: 'provider', entityId: p.id,
        after: { requestId: row.rows[0]!.id, fields: Object.keys(req.body.changes) } });
      return row.rows[0]!.id;
    });
    return reply.status(201).send({ id });
  });

  app.get('/provider/me/change-requests', { ...providerOnly, schema: { tags: ['provider-panel'], security: [{ bearer: [] }] } }, async (req) => {
    return (await db.query(
      `SELECT r.id, r.changes, r.note, r.status, r.decision_reason AS "decisionReason", r.decided_at AS "decidedAt", r.created_at AS "createdAt"
         FROM provider_profile_changes r JOIN providers p ON p.id = r.provider_id WHERE p.user_id = $1 ORDER BY r.created_at DESC`,
      [requireUser(req).id])).rows;
  });

  app.post('/provider/me/change-requests/:id/withdraw', { ...providerOnly, schema: { tags: ['provider-panel'], security: [{ bearer: [] }], params: idParams } }, async (req) => {
    return withTx(db, async (c) => {
      const r = (await c.query<{ id: string; status: string; provider_id: string }>(
        `SELECT r.id, r.status, r.provider_id FROM provider_profile_changes r JOIN providers p ON p.id = r.provider_id
          WHERE r.id = $1 AND p.user_id = $2 FOR UPDATE OF r`, [req.params.id, requireUser(req).id])).rows[0];
      if (!r) throw notFound();
      if (r.status !== 'pending') throw conflict('INVALID_STATUS', { status: r.status });
      await c.query(`UPDATE provider_profile_changes SET status = 'withdrawn', decided_at = now() WHERE id = $1`, [r.id]);
      await audit(c, actorOf(req), { action: 'provider.change_withdrawn', entityType: 'provider', entityId: r.provider_id, after: { requestId: r.id } });
      return { ok: true };
    });
  });

  // ---------------- Staff review ----------------
  app.get('/admin/provider-applications', {
    onRequest: deps.authenticate, preValidation: requirePermission('provider_applications.view'),
    schema: {
      tags: ['admin:providers'], security: [{ bearer: [] }],
      querystring: paginationQuery.extend({ status: z.enum(STATUSES).optional(), countryCode: z.string().length(2).toUpperCase().optional(), q: z.string().max(100).optional() }),
    },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'provider_applications.view');
    const { rows } = await db.query(
      `SELECT a.id, a.status, a.business_name AS "businessName", a.activity_type AS "activityType", co.code AS "countryCode",
              a.city, a.phone, a.submitted_at AS "submittedAt", a.decided_at AS "decidedAt", a.created_at AS "createdAt",
              count(*) OVER() AS total
         FROM provider_applications a JOIN countries co ON co.id = a.country_id
        WHERE ($1::uuid[] IS NULL OR a.country_id = ANY($1))
          AND ($2::text IS NULL OR a.status = $2) AND ($3::text IS NULL OR co.code = $3)
          AND ($4::text IS NULL OR a.business_name ILIKE '%' || $4 || '%' OR a.phone LIKE '%' || $4 || '%')
        ORDER BY coalesce(a.submitted_at, a.created_at) DESC LIMIT $5 OFFSET $6`,
      [scope, req.query.status ?? null, req.query.countryCode ?? null, req.query.q ?? null, req.query.limit, req.query.offset],
    );
    return { total: Number(rows[0]?.total ?? 0), items: rows.map(({ total: _t, ...r }) => r) };
  });

  app.get('/admin/provider-applications/:id', {
    onRequest: deps.authenticate, preValidation: requirePermission('provider_applications.view'),
    schema: { tags: ['admin:providers'], security: [{ bearer: [] }], params: idParams },
  }, async (req) => {
    const user = requireUser(req);
    const country = (await db.query<{ country_id: string }>('SELECT country_id FROM provider_applications WHERE id = $1', [req.params.id])).rows[0];
    if (!country || !can(user, 'provider_applications.view', country.country_id)) throw notFound();
    return loadApplication(req.params.id, can(user, 'providers.view_sensitive', country.country_id));
  });

  /** Supporting documents: the applicant, or staff reviewing applications in that country (each staff view is audited). */
  app.get('/provider-applications/:id/documents/:docId', {
    onRequest: deps.authenticate,
    schema: { tags: ['provider-onboarding'], security: [{ bearer: [] }], params: z.object({ id: z.uuid(), docId: z.uuid() }) },
  }, async (req, reply) => {
    const user = requireUser(req);
    const d = (await db.query<{ file_key: string; mime_type: string; original_name: string; user_id: string; country_id: string }>(
      `SELECT d.file_key, d.mime_type, d.original_name, a.user_id, a.country_id FROM provider_application_documents d
         JOIN provider_applications a ON a.id = d.application_id WHERE d.id = $1 AND a.id = $2`, [req.params.docId, req.params.id])).rows[0];
    if (!d) throw notFound();
    const staff = user.kind === 'staff' && can(user, 'provider_applications.view', d.country_id);
    if (!staff && d.user_id !== user.id) throw notFound();
    if (staff) await audit(db, actorOf(req), { action: 'provider_application.document_viewed', entityType: 'provider_application', entityId: req.params.id, after: { documentId: req.params.docId } });
    const f = await deps.storage.open(d.file_key);
    return reply.header('cache-control', 'private, no-store').header('content-disposition', `inline; filename="${encodeURIComponent(d.original_name)}"`).type(d.mime_type).send(f.stream);
  });

  app.post('/admin/provider-applications/:id/actions', {
    // The exact permission depends on the action and country (checked in the handler); staff only before validation.
    onRequest: deps.authenticate, preValidation: requireKind('staff'),
    schema: {
      tags: ['admin:providers'], security: [{ bearer: [] }], params: idParams,
      body: z.object({ action: z.enum(Object.keys(STAFF_TRANSITIONS) as [StaffAction, ...StaffAction[]]), reason: reasonSchema.optional() }),
    },
  }, async (req) => {
    const user = requireUser(req);
    if (user.kind !== 'staff') throw notFound();
    return { status: await svc.act(user, req.params.id, req.body.action, req.body.reason, actorOf(req)) };
  });

  app.get('/admin/providers', {
    onRequest: deps.authenticate, preValidation: requirePermission('providers.view'),
    schema: { tags: ['admin:providers'], security: [{ bearer: [] }], querystring: paginationQuery.extend({ status: z.enum(['active', 'suspended']).optional(), q: z.string().max(100).optional() }) },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'providers.view');
    const { rows } = await db.query(
      `SELECT p.id, p.business_name AS "businessName", p.activity_type AS "activityType", c.code AS "countryCode", p.city,
              p.status, p.status_reason AS "statusReason", p.application_id AS "applicationId", u.phone, u.email,
              p.created_at AS "createdAt", count(*) OVER() AS total
         FROM providers p JOIN countries c ON c.id = p.country_id JOIN users u ON u.id = p.user_id
        WHERE ($1::uuid[] IS NULL OR p.country_id = ANY($1)) AND ($2::text IS NULL OR p.status = $2)
          AND ($3::text IS NULL OR p.business_name ILIKE '%' || $3 || '%')
        ORDER BY p.created_at DESC LIMIT $4 OFFSET $5`,
      [scope, req.query.status ?? null, req.query.q ?? null, req.query.limit, req.query.offset],
    );
    return { total: Number(rows[0]?.total ?? 0), items: rows.map(({ total: _t, ...r }) => r) };
  });

  // ---------------- Profile change requests (staff) ----------------
  app.get('/admin/provider-change-requests', {
    onRequest: deps.authenticate, preValidation: requirePermission('providers.view'),
    schema: { tags: ['admin:providers'], security: [{ bearer: [] }], querystring: paginationQuery.extend({ status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']).optional() }) },
  }, async (req) => {
    const user = requireUser(req);
    const scope = countryScope(user, 'providers.view');
    const { rows } = await db.query(
      `SELECT r.id, r.provider_id AS "providerId", p.business_name AS "businessName", p.activity_type AS "activityType", c.code AS "countryCode",
              p.country_id AS "countryId", r.changes, r.note, r.status, r.decision_reason AS "decisionReason", d.full_name AS "decidedBy",
              r.decided_at AS "decidedAt", r.created_at AS "createdAt", count(*) OVER() AS total
         FROM provider_profile_changes r JOIN providers p ON p.id = r.provider_id JOIN countries c ON c.id = p.country_id
         LEFT JOIN users d ON d.id = r.decided_by
        WHERE ($1::uuid[] IS NULL OR p.country_id = ANY($1)) AND ($2::text IS NULL OR r.status = $2)
        ORDER BY r.created_at DESC LIMIT $3 OFFSET $4`,
      [scope, req.query.status ?? null, req.query.limit, req.query.offset]);
    return {
      total: Number(rows[0]?.total ?? 0),
      items: rows.map(({ total: _t, countryId, ...r }) => {
        // Payout details are shown only to staff allowed to see sensitive provider data.
        if (r.changes.payoutDetails !== undefined && !can(user, 'providers.view_sensitive', countryId)) r.changes = { ...r.changes, payoutDetails: '***' };
        return r;
      }),
    };
  });

  app.post('/admin/provider-change-requests/:id/:decision', {
    onRequest: deps.authenticate, preValidation: requirePermission('providers.manage'),
    schema: {
      tags: ['admin:providers'], security: [{ bearer: [] }],
      params: z.object({ id: z.uuid(), decision: z.enum(['approve', 'reject']) }), body: z.object({ reason: reasonSchema.optional() }).nullish(),
    },
  }, async (req) => {
    const user = requireUser(req);
    const { decision } = req.params;
    const reason = req.body?.reason ?? null;
    if (decision === 'reject' && !reason) throw badRequest('REASON_REQUIRED');
    return withTx(db, async (c) => {
      const r = (await c.query<{ id: string; status: string; provider_id: string; country_id: string; user_id: string; changes: Record<string, unknown> }>(
        `SELECT r.id, r.status, r.provider_id, r.changes, p.country_id, p.user_id FROM provider_profile_changes r JOIN providers p ON p.id = r.provider_id
          WHERE r.id = $1 FOR UPDATE OF r`, [req.params.id])).rows[0];
      if (!r || !can(user, 'providers.manage', r.country_id)) throw notFound();
      if (r.status !== 'pending') throw conflict('INVALID_STATUS', { status: r.status });
      if ('payoutDetails' in r.changes && !can(user, 'providers.view_sensitive', r.country_id)) throw forbidden('PERMISSION_DENIED');
      const status = decision === 'approve' ? 'approved' : 'rejected';
      await c.query(`UPDATE provider_profile_changes SET status = $2, decided_by = $3, decided_at = now(), decision_reason = $4 WHERE id = $1`,
        [r.id, status, user.id, reason]);
      let before: Record<string, unknown> | undefined;
      if (status === 'approved') {
        const ch = r.changes as { businessName?: string; activityType?: string; payoutDetails?: unknown };
        before = (await c.query('SELECT business_name AS "businessName", activity_type AS "activityType" FROM providers WHERE id = $1 FOR UPDATE', [r.provider_id])).rows[0];
        await c.query(
          `UPDATE providers SET business_name = coalesce($2, business_name), activity_type = coalesce($3, activity_type),
             payout_details = CASE WHEN $4 THEN $5::jsonb ELSE payout_details END WHERE id = $1`,
          [r.provider_id, ch.businessName ?? null, ch.activityType ?? null, ch.payoutDetails !== undefined, ch.payoutDetails !== undefined ? JSON.stringify(ch.payoutDetails) : null]);
      }
      const shown = Object.fromEntries(Object.entries(r.changes).map(([k, v]) => [k, k === 'payoutDetails' ? '(changed)' : v]));
      await audit(c, actorOf(req), { action: `provider.change_${status}`, entityType: 'provider', entityId: r.provider_id, reason,
        before, after: { requestId: r.id, ...(status === 'approved' ? shown : {}) } });
      await notifyUser(c, r.user_id, 'provider.profile_change_decided', { status, reason: reason ?? '' });
      return { ok: true, status };
    });
  });
}
