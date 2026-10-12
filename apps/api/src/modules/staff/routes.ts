import type pg from 'pg';
import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, can, countryScope, requirePermission, requireUser, type AuthUser } from '../../auth/guard.js';
import { ALL_PERMISSIONS, type Permission } from '../../auth/permissions.js';
import { withTx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, mapUniqueViolation, notFound } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { emailSchema, i18nTextSchema, idParams, langSchema, paginationQuery, passwordSchema, phoneSchema, reasonSchema } from '../common.js';

const permissionList = z.array(z.string()).refine((ps) => ps.every((p) => (ALL_PERMISSIONS as string[]).includes(p)), 'unknown permission');
const assignment = z.object({ roleId: z.uuid(), countryId: z.uuid().nullable().default(null) });

/**
 * Anti-escalation: an actor may only grant a role if they themselves hold every permission
 * of that role in the target scope (global grants need global holdings).
 */
async function assertCanGrant(c: pg.PoolClient, actor: AuthUser, assignments: { roleId: string; countryId: string | null }[]) {
  for (const a of assignments) {
    const perms = (await c.query<{ permission_code: Permission }>('SELECT permission_code FROM role_permissions WHERE role_id = $1', [a.roleId])).rows;
    const exists = await c.query('SELECT 1 FROM roles WHERE id = $1', [a.roleId]);
    if (!exists.rowCount) throw badRequest('INVALID_REFERENCE');
    if (perms.some((p) => !can(actor, p.permission_code, a.countryId))) throw forbidden();
  }
}

async function replaceAssignments(c: pg.PoolClient, userId: string, actorId: string, assignments: { roleId: string; countryId: string | null }[]) {
  await c.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
  for (const a of assignments) {
    await c.query('INSERT INTO user_roles (user_id, role_id, country_id, granted_by) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [userId, a.roleId, a.countryId, actorId]);
  }
}

async function currentAssignments(c: pg.PoolClient | Deps['db'], userId: string) {
  return (await c.query<{ roleId: string; roleCode: string; countryId: string | null }>(
    `SELECT ur.role_id AS "roleId", r.code AS "roleCode", ur.country_id AS "countryId"
       FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 ORDER BY r.code`, [userId])).rows;
}

export async function staffRoutes(app: App, deps: Deps) {
  const { db } = deps;
  const auth = { onRequest: deps.authenticate };
  const sec = [{ bearer: [] }];

  app.get('/admin/permissions', { ...auth, preValidation: requirePermission('roles.view'), schema: { tags: ['admin:access'], security: sec } },
    async () => (await db.query('SELECT code, module, description FROM permissions ORDER BY module, code')).rows);

  // ---------------- Roles ----------------
  app.get('/admin/roles', { ...auth, preValidation: requirePermission('roles.view'), schema: { tags: ['admin:access'], security: sec } },
    async () => (await db.query(
      `SELECT r.id, r.code, r.name, r.description, r.is_system AS "isSystem",
              coalesce(array_agg(rp.permission_code ORDER BY rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions,
              (SELECT count(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS "assignedUsers"
         FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id GROUP BY r.id ORDER BY r.is_system DESC, r.code`)).rows);

  app.post('/admin/roles', {
    ...auth, preValidation: requirePermission('roles.manage'),
    schema: { tags: ['admin:access'], security: sec, body: z.object({ code: z.string().regex(/^[a-z][a-z0-9_]{2,49}$/), name: i18nTextSchema, description: i18nTextSchema.optional(), permissions: permissionList }) },
  }, async (req, reply) => {
    const actor = requireUser(req);
    const b = req.body;
    if (b.permissions.some((p) => !can(actor, p as Permission))) throw forbidden();
    const id = await withTx(db, async (c) => {
      let roleId: string;
      try {
        roleId = (await c.query<{ id: string }>('INSERT INTO roles (code, name, description) VALUES ($1, $2, $3) RETURNING id',
          [b.code, JSON.stringify(b.name), b.description ? JSON.stringify(b.description) : null])).rows[0]!.id;
      } catch (err) { mapUniqueViolation(err, { roles_code: 'CODE_TAKEN' }); }
      for (const p of b.permissions) await c.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [roleId, p]);
      await audit(c, actorOf(req), { action: 'role.created', entityType: 'role', entityId: roleId, after: b });
      return roleId;
    });
    return reply.status(201).send({ id });
  });

  app.patch('/admin/roles/:id', {
    ...auth, preValidation: requirePermission('roles.manage'),
    schema: { tags: ['admin:access'], security: sec, params: idParams, body: z.object({ name: i18nTextSchema.optional(), description: i18nTextSchema.optional(), permissions: permissionList.optional() }) },
  }, async (req) => {
    const actor = requireUser(req);
    const b = req.body;
    if (b.permissions?.some((p) => !can(actor, p as Permission))) throw forbidden();
    return withTx(db, async (c) => {
      const role = (await c.query<{ code: string; is_system: boolean }>('SELECT code, is_system FROM roles WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!role) throw notFound();
      if (role.code === 'system_admin' && b.permissions) throw conflict('SYSTEM_ROLE_LOCKED');
      const before = (await c.query('SELECT array_agg(permission_code ORDER BY permission_code) AS p FROM role_permissions WHERE role_id = $1', [req.params.id])).rows[0]?.p ?? [];
      await c.query('UPDATE roles SET name = coalesce($2, name), description = coalesce($3, description) WHERE id = $1',
        [req.params.id, b.name ? JSON.stringify(b.name) : null, b.description ? JSON.stringify(b.description) : null]);
      if (b.permissions) {
        await c.query('DELETE FROM role_permissions WHERE role_id = $1', [req.params.id]);
        for (const p of new Set(b.permissions)) await c.query('INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)', [req.params.id, p]);
      }
      await audit(c, actorOf(req), { action: 'role.updated', entityType: 'role', entityId: req.params.id, before: { permissions: before }, after: b });
      return { id: req.params.id };
    });
  });

  app.delete('/admin/roles/:id', {
    ...auth, preValidation: requirePermission('roles.manage'), schema: { tags: ['admin:access'], security: sec, params: idParams },
  }, async (req, reply) => {
    await withTx(db, async (c) => {
      const role = (await c.query<{ code: string; is_system: boolean }>('SELECT code, is_system FROM roles WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!role) throw notFound();
      if (role.is_system) throw conflict('SYSTEM_ROLE_LOCKED');
      const used = await c.query('SELECT 1 FROM user_roles WHERE role_id = $1 LIMIT 1', [req.params.id]);
      if (used.rowCount) throw conflict('ROLE_IN_USE');
      await c.query('DELETE FROM roles WHERE id = $1', [req.params.id]);
      await audit(c, actorOf(req), { action: 'role.deleted', entityType: 'role', entityId: req.params.id, before: role });
    });
    return reply.status(204).send();
  });

  // ---------------- Users (all kinds, country-scoped listing) ----------------
  app.get('/admin/users', {
    ...auth, preValidation: requirePermission('users.view'),
    schema: { tags: ['admin:access'], security: sec, querystring: paginationQuery.extend({ kind: z.enum(['customer', 'provider', 'staff']).optional(), q: z.string().max(100).optional() }) },
  }, async (req) => {
    const scope = countryScope(requireUser(req), 'users.view');
    const { rows } = await db.query(
      `SELECT u.id, u.kind, u.full_name AS "fullName", u.phone, u.email, c.code AS "countryCode", u.status,
              u.preferred_language AS "preferredLanguage", u.phone_verified_at AS "phoneVerifiedAt", u.last_login_at AS "lastLoginAt",
              u.created_at AS "createdAt", count(*) OVER() AS total
         FROM users u LEFT JOIN countries c ON c.id = u.country_id
        WHERE ($1::uuid[] IS NULL OR u.country_id = ANY($1)) AND ($2::text IS NULL OR u.kind = $2)
          AND ($3::text IS NULL OR u.full_name ILIKE '%' || $3 || '%' OR u.phone LIKE '%' || $3 || '%' OR u.email::text ILIKE '%' || $3 || '%')
        ORDER BY u.created_at DESC LIMIT $4 OFFSET $5`,
      [scope, req.query.kind ?? null, req.query.q ?? null, req.query.limit, req.query.offset],
    );
    return { total: Number(rows[0]?.total ?? 0), items: rows.map(({ total: _t, ...r }) => r) };
  });

  app.post('/admin/users/:id/status', {
    ...auth, preValidation: requirePermission('users.manage'),
    schema: { tags: ['admin:access'], security: sec, params: idParams, body: z.object({ status: z.enum(['active', 'disabled']), reason: reasonSchema }) },
  }, async (req) => {
    const actor = requireUser(req);
    if (actor.id === req.params.id) throw forbidden('CANNOT_MODIFY_SELF');
    return withTx(db, async (c) => {
      const u = (await c.query<{ status: string; country_id: string | null; kind: string }>('SELECT status, country_id, kind FROM users WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!u) throw notFound();
      // Staff accounts and users without a country need global scope.
      if (!can(actor, 'users.manage', u.kind === 'staff' ? null : u.country_id)) throw forbidden();
      await c.query('UPDATE users SET status = $2 WHERE id = $1', [req.params.id, req.body.status]);
      if (req.body.status === 'disabled') {
        await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.params.id]);
      }
      await audit(c, actorOf(req), { action: 'user.status_changed', entityType: 'user', entityId: req.params.id, before: { status: u.status }, after: { status: req.body.status }, reason: req.body.reason });
      return { status: req.body.status };
    });
  });

  // ---------------- Staff accounts ----------------
  app.post('/admin/staff', {
    ...auth, preValidation: requirePermission('users.manage'),
    schema: {
      tags: ['admin:access'], security: sec,
      body: z.object({
        fullName: z.string().trim().min(2).max(200), email: emailSchema, phone: phoneSchema.optional(), password: passwordSchema,
        preferredLanguage: langSchema.default('ar'), countryId: z.uuid().nullable().default(null), jobTitle: z.string().max(100).optional(),
        roles: z.array(assignment).default([]),
      }),
    },
  }, async (req, reply) => {
    const actor = requireUser(req);
    if (!can(actor, 'users.manage')) throw forbidden(); // creating staff needs global scope
    const b = req.body;
    const id = await withTx(db, async (c) => {
      await assertCanGrant(c, actor, b.roles);
      let userId: string;
      try {
        userId = (await c.query<{ id: string }>(
          `INSERT INTO users (kind, full_name, phone, email, country_id, preferred_language, email_verified_at)
           VALUES ('staff', $1, $2, $3, $4, $5, now()) RETURNING id`,
          [b.fullName, b.phone ?? null, b.email, b.countryId, b.preferredLanguage])).rows[0]!.id;
      } catch (err) { mapUniqueViolation(err, { users_phone: 'PHONE_TAKEN', users_email: 'EMAIL_TAKEN' }); }
      await c.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [userId, await hashPassword(b.password)]);
      await c.query('INSERT INTO staff_profiles (user_id, job_title, created_by) VALUES ($1, $2, $3)', [userId, b.jobTitle ?? null, actor.id]);
      await replaceAssignments(c, userId, actor.id, b.roles);
      await audit(c, actorOf(req), { action: 'staff.created', entityType: 'user', entityId: userId, after: { ...b, password: undefined } });
      return userId;
    });
    return reply.status(201).send({ id });
  });

  app.get('/admin/staff', { ...auth, preValidation: requirePermission('users.view'), schema: { tags: ['admin:access'], security: sec } }, async (req) => {
    if (!can(requireUser(req), 'users.view')) throw forbidden();
    return (await db.query(
      `SELECT u.id, u.full_name AS "fullName", u.email, u.phone, u.status, u.preferred_language AS "preferredLanguage",
              s.job_title AS "jobTitle", u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt",
              coalesce(json_agg(json_build_object('roleId', r.id, 'roleCode', r.code, 'countryId', ur.country_id))
                       FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
         FROM users u JOIN staff_profiles s ON s.user_id = u.id
         LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
        WHERE u.kind = 'staff' GROUP BY u.id, s.job_title ORDER BY u.created_at`)).rows;
  });

  app.patch('/admin/staff/:id', {
    ...auth, preValidation: requirePermission('users.manage'),
    schema: { tags: ['admin:access'], security: sec, params: idParams, body: z.object({ fullName: z.string().trim().min(2).max(200).optional(), jobTitle: z.string().max(100).optional(), preferredLanguage: langSchema.optional() }) },
  }, async (req) => {
    if (!can(requireUser(req), 'users.manage')) throw forbidden();
    return withTx(db, async (c) => {
      const before = (await c.query(`SELECT u.full_name, u.preferred_language, s.job_title FROM users u JOIN staff_profiles s ON s.user_id = u.id WHERE u.id = $1 FOR UPDATE OF u`, [req.params.id])).rows[0];
      if (!before) throw notFound();
      await c.query('UPDATE users SET full_name = coalesce($2, full_name), preferred_language = coalesce($3, preferred_language) WHERE id = $1',
        [req.params.id, req.body.fullName ?? null, req.body.preferredLanguage ?? null]);
      if (req.body.jobTitle !== undefined) await c.query('UPDATE staff_profiles SET job_title = $2 WHERE user_id = $1', [req.params.id, req.body.jobTitle]);
      await audit(c, actorOf(req), { action: 'staff.updated', entityType: 'user', entityId: req.params.id, before, after: req.body });
      return { id: req.params.id };
    });
  });

  app.put('/admin/staff/:id/roles', {
    ...auth, preValidation: requirePermission('roles.manage'),
    schema: { tags: ['admin:access'], security: sec, params: idParams, body: z.object({ roles: z.array(assignment), reason: reasonSchema }) },
  }, async (req) => {
    const actor = requireUser(req);
    if (actor.id === req.params.id) throw forbidden('CANNOT_MODIFY_SELF');
    return withTx(db, async (c) => {
      const u = (await c.query('SELECT 1 FROM users WHERE id = $1 AND kind = $2 FOR UPDATE', [req.params.id, 'staff'])).rows[0];
      if (!u) throw notFound();
      const before = await currentAssignments(c, req.params.id);
      // Revoking also requires being able to grant what is being removed.
      await assertCanGrant(c, actor, [...before, ...req.body.roles]);
      await replaceAssignments(c, req.params.id, actor.id, req.body.roles);
      const after = await currentAssignments(c, req.params.id);
      await audit(c, actorOf(req), { action: 'staff.roles_changed', entityType: 'user', entityId: req.params.id, before, after, reason: req.body.reason });
      return { roles: after };
    });
  });
}
