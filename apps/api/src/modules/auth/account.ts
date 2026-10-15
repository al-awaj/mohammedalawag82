import { readdir, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, conflict, unauthorized } from '../../lib/errors.js';
import { verifyPassword } from '../../lib/password.js';
import { pdfBrowserPath } from '../../lib/pdf.js';

const sec = [{ bearer: [] }];
const OPEN_BOOKINGS = ['pending_provider_approval', 'awaiting_payment', 'confirmed', 'in_progress'];
const OPEN_DISPUTES = ['new', 'under_review', 'awaiting_info', 'awaiting_response', 'deciding', 'resolution_approved'];

/** Personal data rights (clause 72): a copy of one's data, and closing a customer account by anonymising it. */
export async function accountRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const auth = { onRequest: deps.authenticate };

  app.get('/me/export', { ...auth, config: { rateLimit: { max: 5, timeWindow: '1 hour' } }, schema: { tags: ['me'], security: sec } }, async (req, reply) => {
    const u = requireUser(req);
    const q = async (sql: string) => (await db.query(sql, [u.id])).rows;
    const data = {
      exportedAt: new Date().toISOString(),
      profile: (await q(`SELECT u.id, u.kind, u.full_name AS "fullName", u.phone, u.email, c.code AS "country", u.preferred_language AS "language",
                                u.phone_verified_at AS "phoneVerifiedAt", u.email_verified_at AS "emailVerifiedAt", u.created_at AS "createdAt"
                           FROM users u LEFT JOIN countries c ON c.id = u.country_id WHERE u.id = $1`))[0],
      termsAccepted: await q(`SELECT t.kind, t.version, a.context, a.accepted_at AS "acceptedAt" FROM terms_acceptances a JOIN terms_versions t ON t.id = a.terms_version_id WHERE a.user_id = $1 ORDER BY a.accepted_at`),
      bookings: await q(`SELECT number, status, service_title AS service, start_at AS "startAt", end_at AS "endAt", total, currency_code AS currency, created_at AS "createdAt" FROM bookings WHERE customer_id = $1 ORDER BY created_at`),
      payments: await q(`SELECT number, method, purpose, status, amount, verified_amount AS "verifiedAmount", currency_code AS currency, created_at AS "createdAt" FROM payments WHERE customer_id = $1 ORDER BY created_at`),
      refunds: await q(`SELECT r.number, r.status, r.amount, r.currency_code AS currency, r.created_at AS "createdAt" FROM refunds r JOIN bookings b ON b.id = r.booking_id WHERE b.customer_id = $1 ORDER BY r.created_at`),
      events: await q(`SELECT name, event_type AS "type", city, location, event_date AS "date", expected_guests AS "guests", budget_amount AS budget, budget_currency AS "budgetCurrency", notes, created_at AS "createdAt" FROM events WHERE customer_id = $1 ORDER BY created_at`),
      reviews: await q(`SELECT rating, comment, status, created_at AS "createdAt" FROM reviews WHERE customer_id = $1 ORDER BY created_at`),
      disputes: await q(`SELECT number, kind, status, subject, description, created_at AS "createdAt" FROM disputes WHERE complainant_id = $1 ORDER BY created_at`),
      notifications: await q(`SELECT template_key AS "template", channel, status, created_at AS "createdAt" FROM message_outbox WHERE recipient_user_id = $1 ORDER BY created_at DESC LIMIT 1000`),
      ...(u.kind === 'provider' ? {
        provider: (await q(`SELECT business_name AS "businessName", city, address, description, status, created_at AS "createdAt" FROM providers WHERE user_id = $1`))[0] ?? null,
        services: await q(`SELECT s.title, s.status, s.base_price AS "basePrice", s.currency_code AS currency, s.created_at AS "createdAt" FROM services s JOIN providers p ON p.id = s.provider_id WHERE p.user_id = $1 ORDER BY s.created_at`),
      } : {}),
    };
    await audit(db, actorOf(req), { action: 'account.exported', entityType: 'user', entityId: u.id });
    return reply.header('content-disposition', 'attachment; filename="my-data.json"').header('cache-control', 'private, no-store').send(data);
  });

  /**
   * Closes a customer account. Financial records (bookings, payments, ledger, documents) are kept as the law requires,
   * but the name, phone, email and private notes are removed and the account can no longer sign in.
   */
  app.post('/me/delete', {
    ...auth, config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    schema: { tags: ['me'], security: sec, body: z.object({ password: z.string().min(1).max(128), confirm: z.literal(true) }) },
  }, async (req, reply) => {
    const u = requireUser(req);
    if (u.kind !== 'customer') throw new AppError('ACCOUNT_DELETION_BY_SUPPORT', 409);
    const hash = (await db.query<{ password_hash: string }>('SELECT password_hash FROM user_credentials WHERE user_id = $1', [u.id])).rows[0]?.password_hash;
    if (!hash || !(await verifyPassword(req.body.password, hash))) throw unauthorized('AUTH_INVALID_CREDENTIALS');
    await withTx(db, async (c) => {
      await c.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [u.id]);
      const open = (await c.query<{ bookings: number; disputes: number; refunds: number; payments: number }>(
        `SELECT (SELECT count(*)::int FROM bookings WHERE customer_id = $1 AND status = ANY($2)) AS bookings,
                (SELECT count(*)::int FROM disputes WHERE complainant_id = $1 AND status = ANY($3)) AS disputes,
                (SELECT count(*)::int FROM refunds r JOIN bookings b ON b.id = r.booking_id WHERE b.customer_id = $1 AND r.status IN ('requested', 'approved', 'processing')) AS refunds,
                (SELECT count(*)::int FROM payments WHERE customer_id = $1 AND status IN ('pending', 'awaiting_verification')) AS payments`,
        [u.id, OPEN_BOOKINGS, OPEN_DISPUTES])).rows[0]!;
      if (open.bookings || open.disputes || open.refunds || open.payments) throw conflict('ACCOUNT_HAS_OPEN_ITEMS', open);
      await c.query(
        `UPDATE users SET full_name = 'مستخدم محذوف', phone = NULL, email = $2, status = 'deleted', deleted_at = now(),
                phone_verified_at = NULL, email_verified_at = NULL WHERE id = $1`, [u.id, `deleted-${u.id}@deleted.invalid`]);
      await c.query('DELETE FROM user_credentials WHERE user_id = $1', [u.id]);
      await c.query('DELETE FROM user_mfa WHERE user_id = $1', [u.id]);
      await c.query('DELETE FROM cart_items WHERE customer_id = $1', [u.id]);
      await c.query('UPDATE events SET notes = NULL, location = NULL, latitude = NULL, longitude = NULL WHERE customer_id = $1', [u.id]);
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
      await c.query(`UPDATE message_outbox SET status = 'failed', last_error = 'account deleted' WHERE recipient_user_id = $1 AND status = 'pending'`, [u.id]);
      await audit(c, actorOf(req), { action: 'account.deleted', entityType: 'user', entityId: u.id });
    });
    return reply.status(204).send();
  });

  /** Health of the moving parts for administrators: database, migrations, worker, outbox, backups, storage, PDF. */
  app.get('/admin/system/status', { ...auth, preValidation: requirePermission('settings.view'), schema: { tags: ['admin:settings'], security: sec } }, async () => {
    const t0 = Date.now();
    const dbInfo = (await db.query<{ version: string; size: string }>(`SELECT version() AS version, pg_size_pretty(pg_database_size(current_database())) AS size`)).rows[0]!;
    const dbMs = Date.now() - t0;
    const migrations = (await db.query<{ name: string; applied_at: Date }>('SELECT name, applied_at FROM schema_migrations ORDER BY name DESC LIMIT 1').catch(() => ({ rows: [] as { name: string; applied_at: Date }[] }))).rows[0] ?? null;
    const worker = (await db.query<{ beat_at: Date; info: unknown }>(`SELECT beat_at, info FROM system_heartbeats WHERE name = 'worker'`)).rows[0] ?? null;
    const outbox = (await db.query<{ pending: number; failed: number; oldest: Date | null }>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending, count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '1 day')::int AS failed,
              min(created_at) FILTER (WHERE status = 'pending') AS oldest FROM message_outbox`)).rows[0]!;
    let lastBackup: { file: string; at: Date; bytes: number } | null = null;
    const dir = process.env.BACKUP_DIR;
    if (dir) {
      try {
        const files = (await readdir(dir)).filter((f) => f.endsWith('.dump') || f.endsWith('.tar') || f.endsWith('.gz'));
        for (const f of files) {
          const s = await stat(`${dir}/${f}`);
          if (!lastBackup || s.mtime > lastBackup.at) lastBackup = { file: f, at: s.mtime, bytes: s.size };
        }
      } catch { lastBackup = null; }
    }
    const workerAgeSec = worker ? Math.round((Date.now() - worker.beat_at.getTime()) / 1000) : null;
    return {
      checkedAt: new Date(), version: process.env.APP_VERSION ?? null, uptimeSec: Math.round(process.uptime()),
      database: { ok: true, latencyMs: dbMs, version: dbInfo.version.split(' ').slice(0, 2).join(' '), size: dbInfo.size },
      migrations: migrations ? { latest: migrations.name, appliedAt: migrations.applied_at } : null,
      worker: { ok: workerAgeSec !== null && workerAgeSec < 180, lastBeatAt: worker?.beat_at ?? null, ageSec: workerAgeSec },
      outbox: { ...outbox, ok: outbox.pending < 500 && !(outbox.oldest && Date.now() - outbox.oldest.getTime() > 15 * 60_000) },
      backups: { configured: !!dir, last: lastBackup, ok: !!lastBackup && Date.now() - lastBackup.at.getTime() < 36 * 3600_000 },
      storage: { driver: deps.config.STORAGE_DRIVER },
      pdf: { available: !!pdfBrowserPath() },
      errorAlerts: { configured: !!process.env.ERROR_WEBHOOK_URL },
    };
  });
}
