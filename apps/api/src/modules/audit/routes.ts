import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { assertCan, requirePermission, requireUser } from '../../auth/guard.js';

export async function auditRoutes(app: App, deps: Deps) {
  app.get('/admin/audit-log', {
    onRequest: deps.authenticate, preValidation: requirePermission('audit.view'),
    schema: {
      tags: ['admin:audit'], security: [{ bearer: [] }],
      querystring: z.object({
        entityType: z.string().max(50).optional(), entityId: z.string().max(200).optional(), actorId: z.uuid().optional(),
        action: z.string().max(100).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(),
        // Keyset pagination: pass the smallest id from the previous page.
        before: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(500).default(100),
      }),
    },
  }, async (req) => {
    // Audit entries are not country-tagged; reading them requires global scope.
    assertCan(requireUser(req), 'audit.view');
    const q = req.query;
    const { rows } = await deps.db.query(
      `SELECT a.id, a.actor_id AS "actorId", u.full_name AS "actorName", a.actor_kind AS "actorKind", a.action,
              a.entity_type AS "entityType", a.entity_id AS "entityId", a.before, a.after, a.reason, host(a.ip) AS ip,
              a.request_id AS "requestId", a.created_at AS "createdAt"
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
        WHERE ($1::text IS NULL OR a.entity_type = $1) AND ($2::text IS NULL OR a.entity_id = $2)
          AND ($3::uuid IS NULL OR a.actor_id = $3) AND ($4::text IS NULL OR a.action LIKE $4 || '%')
          AND ($5::timestamptz IS NULL OR a.created_at >= $5) AND ($6::timestamptz IS NULL OR a.created_at < $6)
          AND ($7::bigint IS NULL OR a.id < $7)
        ORDER BY a.id DESC LIMIT $8`,
      [q.entityType ?? null, q.entityId ?? null, q.actorId ?? null, q.action ?? null, q.from ?? null, q.to ?? null, q.before ?? null, q.limit],
    );
    return { items: rows, nextBefore: rows.length === q.limit ? rows[rows.length - 1]!.id : null };
  });
}
