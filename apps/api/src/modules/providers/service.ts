import type pg from 'pg';
import { withTx, type Db } from '../../db/pool.js';
import { assertCan, type AuthUser } from '../../auth/guard.js';
import type { Permission } from '../../auth/permissions.js';
import { audit, type ActorContext } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { enqueueMessage } from '../../lib/outbox.js';
import { currentTerms } from '../auth/service.js';
import { getSetting } from '../settings/registry.js';

export type AppStatus = 'draft' | 'submitted' | 'under_review' | 'needs_info' | 'approved' | 'rejected' | 'suspended' | 'cancelled';

export type StaffAction = 'start_review' | 'request_info' | 'approve' | 'reject' | 'suspend' | 'reactivate';

/** Staff transitions: allowed source statuses, target, required permission, whether a reason is mandatory. */
export const STAFF_TRANSITIONS: Record<StaffAction, { from: AppStatus[]; to: AppStatus; perm: Permission; reason: boolean }> = {
  start_review: { from: ['submitted'], to: 'under_review', perm: 'provider_applications.review', reason: false },
  request_info: { from: ['submitted', 'under_review'], to: 'needs_info', perm: 'provider_applications.review', reason: true },
  approve: { from: ['submitted', 'under_review'], to: 'approved', perm: 'provider_applications.approve', reason: false },
  reject: { from: ['submitted', 'under_review', 'needs_info'], to: 'rejected', perm: 'provider_applications.reject', reason: true },
  suspend: { from: ['approved'], to: 'suspended', perm: 'providers.manage', reason: true },
  reactivate: { from: ['suspended'], to: 'approved', perm: 'providers.manage', reason: true },
};

const EDITABLE: AppStatus[] = ['draft', 'needs_info'];

export interface ApplicationFields {
  businessName: string;
  activityType: string;
  countryCode: string;
  city: string;
  phone: string;
  email?: string | null | undefined;
  address?: string | null | undefined;
  latitude?: number | null | undefined;
  longitude?: number | null | undefined;
  description?: string | null | undefined;
  payoutDetails?: Record<string, unknown> | null | undefined;
}

interface AppRow {
  id: string; user_id: string; status: AppStatus; country_id: string; business_name: string; activity_type: string;
  city: string; address: string | null; latitude: string | null; longitude: string | null; description: string | null;
  payout_details: unknown; email: string | null; phone: string;
}

export class ProviderApplicationService {
  constructor(private readonly db: Db) {}

  async create(user: AuthUser, f: ApplicationFields, ctx: ActorContext): Promise<string> {
    if (user.kind !== 'provider') throw forbidden();
    return withTx(this.db, async (c) => {
      const countryId = await this.activeCountryId(c, f.countryCode);
      const open = await c.query(
        `SELECT 1 FROM provider_applications WHERE user_id = $1
            AND status IN ('draft','submitted','under_review','needs_info','approved','suspended')`, [user.id]);
      if (open.rowCount) throw conflict('APPLICATION_OPEN_EXISTS');
      const id = (await c.query<{ id: string }>(
        `INSERT INTO provider_applications (user_id, business_name, activity_type, country_id, city, phone, email, address,
                                            latitude, longitude, description, payout_details)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
        [user.id, f.businessName, f.activityType, countryId, f.city, f.phone, f.email ?? null, f.address ?? null,
          f.latitude ?? null, f.longitude ?? null, f.description ?? null, f.payoutDetails ? JSON.stringify(f.payoutDetails) : null],
      )).rows[0]!.id;
      await this.recordEvent(c, id, null, 'draft', user.id, null);
      await audit(c, ctx, { action: 'provider_application.created', entityType: 'provider_application', entityId: id, after: f });
      return id;
    });
  }

  async update(user: AuthUser, id: string, f: Partial<ApplicationFields>, ctx: ActorContext): Promise<void> {
    await withTx(this.db, async (c) => {
      const app = await this.lockOwned(c, user, id);
      if (!EDITABLE.includes(app.status)) throw conflict('INVALID_STATUS_TRANSITION');
      const countryId = f.countryCode ? await this.activeCountryId(c, f.countryCode) : null;
      const has = (k: keyof ApplicationFields) => Object.hasOwn(f, k);
      await c.query(
        `UPDATE provider_applications SET
           business_name = coalesce($2, business_name), activity_type = coalesce($3, activity_type),
           country_id = coalesce($4, country_id), city = coalesce($5, city), phone = coalesce($6, phone),
           email = CASE WHEN $7 THEN $8 ELSE email END, address = CASE WHEN $9 THEN $10 ELSE address END,
           latitude = CASE WHEN $11 THEN $12::numeric ELSE latitude END, longitude = CASE WHEN $11 THEN $13::numeric ELSE longitude END,
           description = CASE WHEN $14 THEN $15 ELSE description END,
           payout_details = CASE WHEN $16 THEN $17::jsonb ELSE payout_details END
         WHERE id = $1`,
        [id, f.businessName ?? null, f.activityType ?? null, countryId, f.city ?? null, f.phone ?? null,
          has('email'), f.email ?? null, has('address'), f.address ?? null,
          has('latitude') || has('longitude'), f.latitude ?? null, f.longitude ?? null,
          has('description'), f.description ?? null, has('payoutDetails'), f.payoutDetails ? JSON.stringify(f.payoutDetails) : null],
      );
      await audit(c, ctx, { action: 'provider_application.updated', entityType: 'provider_application', entityId: id, before: app, after: f });
    });
  }

  async addDocument(user: AuthUser, id: string, doc: { docType: string; key: string; originalName: string; mime: string; size: number; sha256: string }, ctx: ActorContext): Promise<string> {
    return withTx(this.db, async (c) => {
      const app = await this.lockOwned(c, user, id);
      if (!EDITABLE.includes(app.status)) throw conflict('INVALID_STATUS_TRANSITION');
      const docId = (await c.query<{ id: string }>(
        `INSERT INTO provider_application_documents (application_id, doc_type, file_key, original_name, mime_type, size_bytes, sha256, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [id, doc.docType, doc.key, doc.originalName, doc.mime, doc.size, doc.sha256, user.id],
      )).rows[0]!.id;
      await audit(c, ctx, { action: 'provider_application.document_added', entityType: 'provider_application', entityId: id, after: { docId, docType: doc.docType, sha256: doc.sha256 } });
      return docId;
    });
  }

  async submit(user: AuthUser, id: string, acceptTerms: boolean, ctx: ActorContext): Promise<void> {
    if (!acceptTerms) throw badRequest('TERMS_NOT_ACCEPTED');
    await withTx(this.db, async (c) => {
      const app = await this.lockOwned(c, user, id);
      if (!EDITABLE.includes(app.status)) throw conflict('INVALID_STATUS_TRANSITION');

      if (await getSetting(c, 'auth.require_phone_verification', app.country_id)) {
        const v = await c.query('SELECT 1 FROM users WHERE id = $1 AND phone_verified_at IS NOT NULL', [user.id]);
        if (!v.rowCount) throw badRequest('PHONE_NOT_VERIFIED');
      }
      const required = await getSetting(c, 'providers.required_documents', app.country_id);
      const present = new Set((await c.query<{ doc_type: string }>(
        'SELECT DISTINCT doc_type FROM provider_application_documents WHERE application_id = $1', [id])).rows.map((r) => r.doc_type));
      const missing = required.filter((d) => !present.has(d));
      if (missing.length) throw badRequest('APPLICATION_INCOMPLETE', { missingDocuments: missing });

      const terms = await currentTerms(c, 'provider_terms', app.country_id);
      if (!terms) throw badRequest('TERMS_NOT_PUBLISHED');
      await c.query(`INSERT INTO terms_acceptances (user_id, terms_version_id, context, ip) VALUES ($1, $2, 'provider_application', $3)`,
        [user.id, terms.id, ctx.ip]);
      await c.query(
        `UPDATE provider_applications SET status = 'submitted', submitted_at = now(), terms_version_id = $2,
                decision_reason = NULL WHERE id = $1`, [id, terms.id]);
      await this.recordEvent(c, id, app.status, 'submitted', user.id, null);
      await audit(c, ctx, { action: 'provider_application.submitted', entityType: 'provider_application', entityId: id, before: { status: app.status }, after: { status: 'submitted' } });
    });
  }

  async cancel(user: AuthUser, id: string, ctx: ActorContext): Promise<void> {
    await withTx(this.db, async (c) => {
      const app = await this.lockOwned(c, user, id);
      if (!['draft', 'submitted', 'needs_info'].includes(app.status)) throw conflict('INVALID_STATUS_TRANSITION');
      await c.query(`UPDATE provider_applications SET status = 'cancelled' WHERE id = $1`, [id]);
      await this.recordEvent(c, id, app.status, 'cancelled', user.id, null);
      await audit(c, ctx, { action: 'provider_application.cancelled', entityType: 'provider_application', entityId: id, before: { status: app.status }, after: { status: 'cancelled' } });
    });
  }

  /** Staff decision. Country-scoped permission check, reason enforcement, provider record sync, notification. */
  async act(staff: AuthUser, id: string, action: StaffAction, reason: string | undefined, ctx: ActorContext): Promise<AppStatus> {
    const tr = STAFF_TRANSITIONS[action];
    return withTx(this.db, async (c) => {
      const app = (await c.query<AppRow>('SELECT * FROM provider_applications WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!app) throw notFound();
      assertCan(staff, tr.perm, app.country_id);
      if (!tr.from.includes(app.status)) throw conflict('INVALID_STATUS_TRANSITION', { from: app.status, action });
      if (tr.reason && !reason) throw badRequest('REASON_REQUIRED');

      const isDecision = ['approve', 'reject', 'request_info', 'suspend', 'reactivate'].includes(action);
      await c.query(
        `UPDATE provider_applications SET status = $2,
                decided_at = CASE WHEN $3 THEN now() ELSE decided_at END,
                decided_by = CASE WHEN $3 THEN $4::uuid ELSE decided_by END,
                decision_reason = CASE WHEN $3 THEN $5 ELSE decision_reason END
          WHERE id = $1`,
        [id, tr.to, isDecision, staff.id, reason ?? null],
      );

      if (action === 'approve') {
        await c.query(
          `INSERT INTO providers (user_id, application_id, business_name, activity_type, country_id, city, address,
                                  latitude, longitude, description, payout_details, show_identity)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (user_id) DO UPDATE SET application_id = EXCLUDED.application_id, business_name = EXCLUDED.business_name,
             activity_type = EXCLUDED.activity_type, country_id = EXCLUDED.country_id, city = EXCLUDED.city,
             address = EXCLUDED.address, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
             description = EXCLUDED.description, payout_details = EXCLUDED.payout_details, status = 'active', status_reason = NULL`,
          [app.user_id, id, app.business_name, app.activity_type, app.country_id, app.city, app.address, app.latitude,
            app.longitude, app.description, app.payout_details ? JSON.stringify(app.payout_details) : null,
            await getSetting(c, 'providers.public_identity_visible', app.country_id)],
        );
      } else if (action === 'suspend' || action === 'reactivate') {
        await c.query(`UPDATE providers SET status = $2, status_reason = $3 WHERE application_id = $1`,
          [id, action === 'suspend' ? 'suspended' : 'active', reason]);
      }

      await this.recordEvent(c, id, app.status, tr.to, staff.id, reason ?? null);
      await audit(c, ctx, {
        action: `provider_application.${action}`, entityType: 'provider_application', entityId: id,
        before: { status: app.status }, after: { status: tr.to }, reason: reason ?? null,
      });
      if (action !== 'start_review') {
        const u = (await c.query<{ phone: string | null; preferred_language: string }>('SELECT phone, preferred_language FROM users WHERE id = $1', [app.user_id])).rows[0]!;
        if (u.phone) {
          await enqueueMessage(c, {
            channel: 'sms', recipientUserId: app.user_id, target: u.phone, templateKey: `provider_application.${tr.to}`,
            language: u.preferred_language, payload: { applicationId: id, reason: reason ?? null },
          });
        }
      }
      return tr.to;
    });
  }

  private async activeCountryId(c: pg.PoolClient, code: string): Promise<string> {
    const row = (await c.query<{ id: string }>('SELECT id FROM countries WHERE code = $1 AND is_active', [code])).rows[0];
    if (!row) throw badRequest('COUNTRY_NOT_AVAILABLE');
    return row.id;
  }

  private async lockOwned(c: pg.PoolClient, user: AuthUser, id: string): Promise<AppRow> {
    const app = (await c.query<AppRow>('SELECT * FROM provider_applications WHERE id = $1 FOR UPDATE', [id])).rows[0];
    // Same response for "missing" and "not yours" so ids cannot be probed.
    if (!app || app.user_id !== user.id) throw notFound();
    return app;
  }

  private async recordEvent(c: pg.PoolClient, id: string, from: AppStatus | null, to: AppStatus, actor: string, reason: string | null) {
    await c.query(
      'INSERT INTO provider_application_events (application_id, from_status, to_status, actor_id, reason) VALUES ($1, $2, $3, $4, $5)',
      [id, from, to, actor, reason],
    );
  }
}
