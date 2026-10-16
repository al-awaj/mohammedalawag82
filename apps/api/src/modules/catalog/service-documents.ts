import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, can, requireKind, requireUser } from '../../auth/guard.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { DOCUMENT_TYPES } from '../../lib/storage.js';
import { idParams } from '../common.js';
import { providerOf } from './shared.js';

const sec = [{ bearer: [] }];
const COLUMNS = `d.id, d.doc_type AS "docType", d.mime_type AS "mimeType", d.size_bytes AS "sizeBytes", d.created_at AS "createdAt"`;

/**
 * Documents a service type requires for each service (licences, permits). The provider uploads them; staff reviewing
 * the service read them. They are never public, and a replaced document is kept for the record.
 */
export async function serviceDocumentRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const guard = { onRequest: deps.authenticate, preValidation: requireKind('provider') };

  async function required(serviceId: string) {
    return (await db.query<{ required_documents: string[] }>(
      'SELECT t.required_documents FROM services s JOIN service_types t ON t.id = s.service_type_id WHERE s.id = $1', [serviceId])).rows[0]?.required_documents ?? [];
  }
  async function current(serviceId: string) {
    return (await db.query(`SELECT ${COLUMNS} FROM service_documents d WHERE d.service_id = $1 AND d.replaced_at IS NULL ORDER BY d.doc_type`, [serviceId])).rows;
  }

  app.get('/provider/services/:id/documents', { ...guard, schema: { tags: ['provider-panel'], security: sec, params: idParams } }, async (req) => {
    const p = await providerOf(db, req, { forWrite: false });
    const s = (await db.query<{ provider_id: string }>('SELECT provider_id FROM services WHERE id = $1', [req.params.id])).rows[0];
    if (!s || s.provider_id !== p.id) throw notFound();
    return { required: await required(req.params.id), documents: await current(req.params.id) };
  });

  app.post('/provider/services/:id/documents', {
    ...guard, schema: { tags: ['provider-panel'], security: sec, params: idParams, consumes: ['multipart/form-data'] },
  }, async (req, reply) => {
    const p0 = await providerOf(db, req, { forWrite: true });
    const owner = (await db.query<{ provider_id: string }>('SELECT provider_id FROM services WHERE id = $1', [req.params.id])).rows[0];
    if (!owner || owner.provider_id !== p0.id) throw notFound();
    const file = await req.file();
    if (!file) throw badRequest('VALIDATION_FAILED', [{ path: '/file', message: 'file is required' }]);
    const docType = (file.fields.docType as { value?: unknown } | undefined)?.value;
    const types = await required(req.params.id);
    if (typeof docType !== 'string' || !types.includes(docType)) throw badRequest('VALIDATION_FAILED', [{ path: '/docType', message: `one of: ${types.join(', ') || '(none required)'}` }]);
    const stored = await deps.storage.save(`service-documents/${req.params.id}`, await file.toBuffer(), DOCUMENT_TYPES);
    try {
      const id = await withTx(db, async (c) => {
        await c.query('SELECT 1 FROM services WHERE id = $1 FOR UPDATE', [req.params.id]);
        const replaced = (await c.query<{ id: string }>(
          `UPDATE service_documents SET replaced_at = now() WHERE service_id = $1 AND doc_type = $2 AND replaced_at IS NULL RETURNING id`, [req.params.id, docType])).rows;
        const docId = (await c.query<{ id: string }>(
          `INSERT INTO service_documents (service_id, doc_type, file_key, mime_type, size_bytes, uploaded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [req.params.id, docType, stored.key, stored.mime, stored.size, requireUser(req).id])).rows[0]!.id;
        await audit(c, actorOf(req), { action: 'service.document_uploaded', entityType: 'service', entityId: req.params.id,
          after: { documentId: docId, docType, sha256: stored.sha256, replaced: replaced.map((r) => r.id) } });
        return docId;
      });
      return reply.status(201).send({ id, docType });
    } catch (err) {
      await deps.storage.remove(stored.key);
      throw err;
    }
  });

  app.get('/admin/services/:id/documents', {
    onRequest: deps.authenticate, preValidation: requireKind('staff'), schema: { tags: ['admin:catalog'], security: sec, params: idParams },
  }, async (req) => {
    const s = (await db.query<{ country_id: string }>('SELECT country_id FROM services WHERE id = $1', [req.params.id])).rows[0];
    if (!s || !can(requireUser(req), 'services.view', s.country_id)) throw notFound();
    return { required: await required(req.params.id), documents: await current(req.params.id) };
  });

  /** The file itself: its provider, or staff who can view services in that country (each staff view is audited). */
  app.get('/service-documents/:id/file', {
    onRequest: deps.authenticate, schema: { tags: ['catalog'], security: sec, params: z.object({ id: z.uuid() }) },
  }, async (req, reply) => {
    const user = requireUser(req);
    const d = (await db.query<{ file_key: string; mime_type: string; doc_type: string; service_id: string; country_id: string; owner: string }>(
      `SELECT d.file_key, d.mime_type, d.doc_type, d.service_id, s.country_id, p.user_id AS owner
         FROM service_documents d JOIN services s ON s.id = d.service_id JOIN providers p ON p.id = s.provider_id WHERE d.id = $1`, [req.params.id])).rows[0];
    if (!d) throw notFound();
    const staff = user.kind === 'staff' && can(user, 'services.view', d.country_id);
    if (!staff && d.owner !== user.id) throw notFound();
    if (staff) await audit(db, actorOf(req), { action: 'service.document_viewed', entityType: 'service', entityId: d.service_id, after: { documentId: req.params.id } });
    const f = await deps.storage.open(d.file_key);
    return reply.header('cache-control', 'private, no-store').header('content-disposition', `inline; filename="${d.doc_type}"`).type(d.mime_type).send(f.stream);
  });
}
