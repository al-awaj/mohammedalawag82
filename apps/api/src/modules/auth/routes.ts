import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, requireUser } from '../../auth/guard.js';
import { audit } from '../../lib/audit.js';
import { badRequest } from '../../lib/errors.js';
import { withTx } from '../../db/pool.js';
import { emailSchema, langSchema, optionalBody, passwordSchema, phoneSchema } from '../common.js';
import { AuthService } from './service.js';

const sessionSchema = z.object({ accessToken: z.string(), refreshToken: z.string(), expiresIn: z.number() });
const identifierSchema = z.union([phoneSchema, emailSchema]);
const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export async function authRoutes(app: App, deps: Deps) {
  const svc = new AuthService(deps.db, deps.config, deps.tokens);
  const auth = { onRequest: deps.authenticate };

  app.post('/auth/register', {
    ...strict,
    schema: {
      tags: ['auth'],
      body: z.object({
        accountType: z.enum(['customer', 'provider']).default('customer'),
        fullName: z.string().trim().min(2).max(200),
        phone: phoneSchema,
        email: emailSchema.optional(),
        countryCode: z.string().length(2).toUpperCase(),
        preferredLanguage: langSchema,
        password: passwordSchema,
        acceptTerms: z.boolean(),
      }),
      response: { 201: sessionSchema.extend({ userId: z.string() }) },
    },
  }, async (req, reply) => reply.status(201).send(await svc.register(req.body, actorOf(req))));

  app.post('/auth/login', {
    ...strict,
    schema: { tags: ['auth'], body: z.object({ identifier: identifierSchema, password: z.string().min(1).max(128) }), response: { 200: sessionSchema } },
  }, async (req) => svc.login(req.body.identifier, req.body.password, actorOf(req)));

  app.post('/auth/refresh', {
    ...strict,
    schema: { tags: ['auth'], body: z.object({ refreshToken: z.string().min(20) }), response: { 200: sessionSchema } },
  }, async (req) => svc.refresh(req.body.refreshToken, actorOf(req)));

  app.post('/auth/logout', {
    ...auth,
    schema: { tags: ['auth'], security: [{ bearer: [] }], body: optionalBody(z.object({ refreshToken: z.string().optional() })) },
  }, async (req, reply) => {
    await svc.logout(requireUser(req).id, req.body.refreshToken, actorOf(req));
    return reply.status(204).send();
  });

  app.post('/auth/verification/request', {
    ...auth, ...strict,
    schema: { tags: ['auth'], security: [{ bearer: [] }], body: z.object({ channel: z.enum(['phone', 'email']) }) },
  }, async (req, reply) => {
    await svc.requestVerification(requireUser(req).id, req.body.channel);
    return reply.status(202).send();
  });

  app.post('/auth/verification/confirm', {
    ...auth, ...strict,
    schema: { tags: ['auth'], security: [{ bearer: [] }], body: z.object({ channel: z.enum(['phone', 'email']), code: z.string().regex(/^\d{6}$/) }) },
  }, async (req, reply) => {
    await svc.confirmVerification(requireUser(req).id, req.body.channel, req.body.code, actorOf(req));
    return reply.status(204).send();
  });

  app.post('/auth/password/forgot', {
    ...strict,
    schema: { tags: ['auth'], body: z.object({ identifier: identifierSchema }) },
  }, async (req, reply) => {
    await svc.forgotPassword(req.body.identifier);
    return reply.status(202).send();
  });

  app.post('/auth/password/reset', {
    ...strict,
    schema: { tags: ['auth'], body: z.object({ identifier: identifierSchema, code: z.string().regex(/^\d{6}$/), newPassword: passwordSchema }) },
  }, async (req, reply) => {
    await svc.resetPassword(req.body.identifier, req.body.code, req.body.newPassword, actorOf(req));
    return reply.status(204).send();
  });

  app.post('/me/password', {
    ...auth, ...strict,
    schema: { tags: ['me'], security: [{ bearer: [] }], body: z.object({ currentPassword: z.string(), newPassword: passwordSchema }) },
  }, async (req, reply) => {
    await svc.changePassword(requireUser(req).id, req.body.currentPassword, req.body.newPassword, actorOf(req));
    return reply.status(204).send();
  });

  app.get('/me', { ...auth, schema: { tags: ['me'], security: [{ bearer: [] }] } }, async (req) => {
    const user = requireUser(req);
    const { rows } = await deps.db.query(
      `SELECT u.id, u.kind, u.full_name AS "fullName", u.phone, u.email, c.code AS "countryCode",
              u.preferred_language AS "preferredLanguage", u.phone_verified_at AS "phoneVerifiedAt",
              u.email_verified_at AS "emailVerifiedAt", u.created_at AS "createdAt"
         FROM users u LEFT JOIN countries c ON c.id = u.country_id WHERE u.id = $1`,
      [user.id],
    );
    const roles = user.kind === 'staff'
      ? (await deps.db.query(
          `SELECT r.code, co.code AS "countryCode" FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             LEFT JOIN countries co ON co.id = ur.country_id WHERE ur.user_id = $1 ORDER BY r.code`, [user.id])).rows
      : [];
    return { ...rows[0], roles, permissions: [...user.grants.keys()].sort() };
  });

  app.patch('/me', {
    ...auth,
    schema: {
      tags: ['me'], security: [{ bearer: [] }],
      body: z.object({ fullName: z.string().trim().min(2).max(200).optional(), preferredLanguage: langSchema.optional() }),
    },
  }, async (req) => {
    const user = requireUser(req);
    return withTx(deps.db, async (c) => {
      if (req.body.preferredLanguage) {
        const ok = await c.query('SELECT 1 FROM languages WHERE code = $1 AND is_active', [req.body.preferredLanguage]);
        if (!ok.rowCount) throw badRequest('LANGUAGE_NOT_SUPPORTED');
      }
      const before = (await c.query('SELECT full_name, preferred_language FROM users WHERE id = $1 FOR UPDATE', [user.id])).rows[0];
      const after = (await c.query(
        `UPDATE users SET full_name = coalesce($2, full_name), preferred_language = coalesce($3, preferred_language)
          WHERE id = $1 RETURNING full_name, preferred_language`,
        [user.id, req.body.fullName ?? null, req.body.preferredLanguage ?? null],
      )).rows[0];
      await audit(c, actorOf(req), { action: 'user.profile_updated', entityType: 'user', entityId: user.id, before, after });
      return { fullName: after.full_name, preferredLanguage: after.preferred_language };
    });
  });
}
