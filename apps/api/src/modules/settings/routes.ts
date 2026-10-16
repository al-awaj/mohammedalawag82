import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, assertCan, can, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { reasonSchema } from '../common.js';
import { getSetting, isSettingKey, SETTINGS } from './registry.js';

export async function settingsRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const auth = { onRequest: deps.authenticate };
  const sec = [{ bearer: [] }];

  app.get('/admin/settings', { ...auth, preValidation: requirePermission('settings.view'), schema: { tags: ['admin:settings'], security: sec } }, async (req) => {
    const user = requireUser(req);
    const stored = (await db.query<{ key: string; scope_type: string; scope_id: string | null; value: unknown; updated_at: Date }>(
      'SELECT key, scope_type, scope_id, value, updated_at FROM settings ORDER BY key')).rows
      .filter((s) => can(user, 'settings.view', s.scope_id));
    return Object.entries(SETTINGS).map(([key, d]) => ({
      key, description: d.description, default: d.default, scopes: d.scopes,
      values: stored.filter((s) => s.key === key).map((s) => ({ scope: s.scope_type, countryId: s.scope_id, value: s.value, updatedAt: s.updated_at })),
    }));
  });

  app.put('/admin/settings/:key', {
    ...auth, preValidation: requirePermission('settings.manage'),
    schema: {
      tags: ['admin:settings'], security: sec, params: z.object({ key: z.string() }),
      body: z.object({ scope: z.enum(['global', 'country']), countryId: z.uuid().optional(), value: z.unknown(), reason: reasonSchema }),
    },
  }, async (req) => {
    const user = requireUser(req);
    const { key } = req.params;
    if (!isSettingKey(key)) throw badRequest('UNKNOWN_SETTING');
    if (key === 'branding.logo') throw badRequest('VALIDATION_FAILED', [{ path: '/key', message: 'upload the logo with POST /admin/branding/logo' }]);
    const def = SETTINGS[key];
    const b = req.body;
    if (!(def.scopes as readonly string[]).includes(b.scope) || (b.scope === 'country') !== Boolean(b.countryId)) throw badRequest('SCOPE_NOT_ALLOWED');
    const parsed = def.schema.safeParse(b.value);
    if (!parsed.success) throw badRequest('INVALID_SETTING_VALUE', parsed.error.issues.map((i) => i.message));
    const scopeId = b.countryId ?? null;
    assertCan(user, 'settings.manage', scopeId);

    return withTx(db, async (c) => {
      const old = (await c.query<{ value: unknown }>(
        'SELECT value FROM settings WHERE key = $1 AND scope_type = $2 AND scope_id IS NOT DISTINCT FROM $3 FOR UPDATE', [key, b.scope, scopeId])).rows[0];
      await c.query(
        `INSERT INTO settings (key, scope_type, scope_id, value, updated_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (key, scope_type, scope_id) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, b.scope, scopeId, JSON.stringify(parsed.data), user.id]);
      await c.query(
        'INSERT INTO setting_history (key, scope_type, scope_id, old_value, new_value, reason, changed_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [key, b.scope, scopeId, old ? JSON.stringify(old.value) : null, JSON.stringify(parsed.data), b.reason, user.id]);
      await audit(c, actorOf(req), { action: 'setting.changed', entityType: 'setting', entityId: `${key}@${b.scope}:${scopeId ?? '*'}`, before: old?.value ?? null, after: parsed.data, reason: b.reason });
      return { key, scope: b.scope, countryId: scopeId, value: parsed.data };
    });
  });

  // =============== Branding (public) ===============
  const brandingQuery = z.object({ country: z.string().regex(/^[A-Z]{2}$/).optional() });
  async function countryIdOf(code?: string) {
    return code ? (await db.query<{ id: string }>('SELECT id FROM countries WHERE code = $1 AND is_active', [code])).rows[0]?.id ?? null : null;
  }

  app.get('/branding', { schema: { tags: ['reference'], querystring: brandingQuery } }, async (req, reply) => {
    const cid = await countryIdOf(req.query.country);
    const logo = await getSetting(db, 'branding.logo', cid);
    reply.header('cache-control', 'public, max-age=60');
    return {
      name: await getSetting(db, 'branding.name', cid), primaryColor: await getSetting(db, 'branding.primary_color', cid),
      logoUrl: logo ? `/v1/branding/logo${req.query.country ? `?country=${req.query.country}` : ''}` : null,
      contact: await getSetting(db, 'contact.info', cid), social: await getSetting(db, 'contact.social', cid),
    };
  });

  app.get('/branding/logo', { schema: { tags: ['reference'], querystring: brandingQuery } }, async (req, reply) => {
    const key = await getSetting(db, 'branding.logo', await countryIdOf(req.query.country));
    if (!key) throw notFound();
    const f = await deps.storage.open(key);
    const mime = key.endsWith('.webp') ? 'image/webp' : key.endsWith('.jpg') || key.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
    return reply.header('cache-control', 'public, max-age=300').header('x-content-type-options', 'nosniff').type(mime).send(f.stream);
  });

  /** Logo upload: stored as the branding.logo setting (global or per country) with its history and audit like any setting. */
  app.post('/admin/branding/logo', {
    ...auth, preValidation: requirePermission('settings.manage'), schema: { tags: ['admin:settings'], security: sec, consumes: ['multipart/form-data'] },
  }, async (req) => {
    const user = requireUser(req);
    const file = await req.file();
    if (!file) throw badRequest('VALIDATION_FAILED', [{ path: '/file', message: 'file is required' }]);
    const field = (n: string) => { const f = file.fields[n] as { value?: unknown } | undefined; return typeof f?.value === 'string' && f.value.trim() ? f.value.trim() : undefined; };
    const countryId = field('countryId') ?? null;
    const reason = field('reason');
    if (!reason || reason.length < 3) throw badRequest('VALIDATION_FAILED', [{ path: '/reason', message: 'reason is required' }]);
    if (countryId && !z.uuid().safeParse(countryId).success) throw badRequest('VALIDATION_FAILED', [{ path: '/countryId', message: 'invalid id' }]);
    assertCan(user, 'settings.manage', countryId);
    const stored = await deps.storage.save('branding', await file.toBuffer(), ['image/png', 'image/jpeg', 'image/webp']);
    const scope = countryId ? 'country' : 'global';
    return withTx(db, async (c) => {
      const old = (await c.query<{ value: unknown }>(
        'SELECT value FROM settings WHERE key = $1 AND scope_type = $2 AND scope_id IS NOT DISTINCT FROM $3 FOR UPDATE', ['branding.logo', scope, countryId])).rows[0];
      await c.query(
        `INSERT INTO settings (key, scope_type, scope_id, value, updated_by) VALUES ('branding.logo', $1, $2, $3, $4)
         ON CONFLICT (key, scope_type, scope_id) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [scope, countryId, JSON.stringify(stored.key), user.id]);
      await c.query('INSERT INTO setting_history (key, scope_type, scope_id, old_value, new_value, reason, changed_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        ['branding.logo', scope, countryId, old ? JSON.stringify(old.value) : null, JSON.stringify(stored.key), reason, user.id]);
      await audit(c, actorOf(req), { action: 'setting.changed', entityType: 'setting', entityId: `branding.logo@${scope}:${countryId ?? '*'}`, before: old?.value ?? null, after: stored.key, reason });
      return { logo: stored.key };
    });
  });

  app.get('/admin/settings/:key/history', {
    ...auth, preValidation: requirePermission('settings.view'), schema: { tags: ['admin:settings'], security: sec, params: z.object({ key: z.string() }) },
  }, async (req) => {
    const user = requireUser(req);
    const rows = (await db.query(
      `SELECT h.scope_type AS scope, h.scope_id AS "countryId", h.old_value AS "oldValue", h.new_value AS "newValue", h.reason,
              u.full_name AS "changedBy", h.changed_at AS "changedAt"
         FROM setting_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.key = $1 ORDER BY h.changed_at DESC`, [req.params.key])).rows;
    return rows.filter((r) => can(user, 'settings.view', r.countryId));
  });
}
