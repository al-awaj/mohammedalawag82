import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, assertCan, can, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest } from '../../lib/errors.js';
import { reasonSchema } from '../common.js';
import { isSettingKey, SETTINGS } from './registry.js';

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
