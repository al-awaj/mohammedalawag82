import { z } from 'zod';
import type { App, Deps } from '../../deps.js';
import { actorOf, can, requirePermission, requireUser } from '../../auth/guard.js';
import { withTx, type Executor } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, conflict, forbidden, notFound, unauthorized } from '../../lib/errors.js';
import { verifyPassword } from '../../lib/password.js';
import { sha256 } from '../../lib/tokens.js';
import { newSecret, openSecret, otpauthUrl, sealSecret, verifyCode } from '../../lib/totp.js';
import { idParams, reasonSchema } from '../common.js';
import { getSetting } from '../settings/registry.js';
import { AuthService } from './service.js';

const sec = [{ bearer: [] }];
const code = z.string().regex(/^\d{6}$/);
const MAX_ATTEMPTS = 5;
const strict = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

/** Two-step sign-in with an authenticator app (TOTP), mandatory for staff when the administration requires it. */
export async function mfaRoutes(app: App, deps: Deps) {
  const { db, config } = deps;
  const svc = new AuthService(db, config, deps.tokens);
  const issuer = 'Events Platform';

  async function pendingSecret(c: Executor, userId: string) {
    const u = (await c.query<{ email: string | null; phone: string | null }>('SELECT email, phone FROM users WHERE id = $1', [userId])).rows[0]!;
    const secret = newSecret();
    await c.query(
      `INSERT INTO user_mfa (user_id, secret_enc) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET secret_enc = EXCLUDED.secret_enc, last_step = 0, created_at = now() WHERE user_mfa.enabled_at IS NULL`,
      [userId, sealSecret(secret, config.JWT_SECRET)]);
    return { secret, otpauthUrl: otpauthUrl(secret, u.email ?? u.phone ?? userId, issuer) };
  }

  /** Checks a code against the user's secret; a code is accepted only once. Returns false when it does not match. */
  async function checkCode(c: Executor, userId: string, value: string): Promise<boolean> {
    const m = (await c.query<{ secret_enc: string; last_step: string }>('SELECT secret_enc, last_step FROM user_mfa WHERE user_id = $1 FOR UPDATE', [userId])).rows[0];
    if (!m) return false;
    const step = verifyCode(openSecret(m.secret_enc, config.JWT_SECRET), value, Number(m.last_step));
    if (step === null) return false;
    await c.query('UPDATE user_mfa SET last_step = $2 WHERE user_id = $1', [userId, step]);
    return true;
  }

  async function challenge(token: string) {
    const ch = (await db.query<{ user_id: string; purpose: 'verify' | 'setup'; expires_at: Date; attempts: number; consumed_at: Date | null; kind: 'customer' | 'provider' | 'staff' }>(
      `SELECT m.user_id, m.purpose, m.expires_at, m.attempts, m.consumed_at, u.kind FROM mfa_challenges m JOIN users u ON u.id = m.user_id
        WHERE m.token_hash = $1 AND u.status = 'active'`, [sha256(token)])).rows[0];
    if (!ch || ch.consumed_at || ch.expires_at <= new Date() || ch.attempts >= MAX_ATTEMPTS) throw unauthorized('MFA_CHALLENGE_INVALID');
    return ch;
  }

  app.post('/auth/mfa/setup', { ...strict, schema: { tags: ['auth'], body: z.object({ mfaToken: z.string().min(20) }) } }, async (req) => {
    const ch = await challenge(req.body.mfaToken);
    if (ch.purpose !== 'setup') throw conflict('MFA_ALREADY_ENABLED');
    return withTx(db, (c) => pendingSecret(c, ch.user_id));
  });

  app.post('/auth/mfa/verify', { ...strict, schema: { tags: ['auth'], body: z.object({ mfaToken: z.string().min(20), code }) } }, async (req) => {
    const ch = await challenge(req.body.mfaToken);
    const out = await withTx(db, async (c) => {
      if (!(await checkCode(c, ch.user_id, req.body.code))) return null;
      if (ch.purpose === 'setup') {
        await c.query('UPDATE user_mfa SET enabled_at = now() WHERE user_id = $1', [ch.user_id]);
        await audit(c, { ...actorOf(req), actorId: ch.user_id, actorKind: ch.kind }, { action: 'auth.mfa_enabled', entityType: 'user', entityId: ch.user_id });
      }
      await c.query('UPDATE mfa_challenges SET consumed_at = now() WHERE token_hash = $1', [sha256(req.body.mfaToken)]);
      return svc.sessionAfterMfa(c, ch.user_id, ch.kind, actorOf(req));
    });
    if (!out) {
      await db.query('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = $1', [sha256(req.body.mfaToken)]);
      throw unauthorized('MFA_CODE_INVALID');
    }
    return out;
  });

  // =============== Signed-in user ===============
  const auth = { onRequest: deps.authenticate };
  app.get('/me/mfa', { ...auth, schema: { tags: ['me'], security: sec } }, async (req) => {
    const u = requireUser(req);
    const m = (await db.query<{ enabled_at: Date | null }>('SELECT enabled_at FROM user_mfa WHERE user_id = $1', [u.id])).rows[0];
    return { enabled: !!m?.enabled_at, enabledAt: m?.enabled_at ?? null, required: u.kind === 'staff' && await getSetting(db, 'security.staff_mfa_required') };
  });

  app.post('/me/mfa/setup', { ...auth, ...strict, schema: { tags: ['me'], security: sec } }, async (req) => {
    const u = requireUser(req);
    const m = (await db.query<{ enabled_at: Date | null }>('SELECT enabled_at FROM user_mfa WHERE user_id = $1', [u.id])).rows[0];
    if (m?.enabled_at) throw conflict('MFA_ALREADY_ENABLED');
    return withTx(db, (c) => pendingSecret(c, u.id));
  });

  app.post('/me/mfa/enable', { ...auth, ...strict, schema: { tags: ['me'], security: sec, body: z.object({ code }) } }, async (req, reply) => {
    const u = requireUser(req);
    const ok = await withTx(db, async (c) => {
      const m = (await c.query<{ enabled_at: Date | null }>('SELECT enabled_at FROM user_mfa WHERE user_id = $1 FOR UPDATE', [u.id])).rows[0];
      if (!m) throw notFound();
      if (m.enabled_at) throw conflict('MFA_ALREADY_ENABLED');
      if (!(await checkCode(c, u.id, req.body.code))) return false;
      await c.query('UPDATE user_mfa SET enabled_at = now() WHERE user_id = $1', [u.id]);
      await audit(c, actorOf(req), { action: 'auth.mfa_enabled', entityType: 'user', entityId: u.id });
      return true;
    });
    if (!ok) throw unauthorized('MFA_CODE_INVALID');
    return reply.status(204).send();
  });

  app.post('/me/mfa/disable', {
    ...auth, ...strict, schema: { tags: ['me'], security: sec, body: z.object({ password: z.string().min(1).max(128), code }) },
  }, async (req, reply) => {
    const u = requireUser(req);
    if (u.kind === 'staff' && await getSetting(db, 'security.staff_mfa_required')) throw conflict('MFA_REQUIRED_BY_POLICY');
    const hash = (await db.query<{ password_hash: string }>('SELECT password_hash FROM user_credentials WHERE user_id = $1', [u.id])).rows[0]?.password_hash;
    if (!hash || !(await verifyPassword(req.body.password, hash))) throw unauthorized('AUTH_INVALID_CREDENTIALS');
    const ok = await withTx(db, async (c) => {
      if (!(await checkCode(c, u.id, req.body.code))) return false;
      await c.query('DELETE FROM user_mfa WHERE user_id = $1', [u.id]);
      await audit(c, actorOf(req), { action: 'auth.mfa_disabled', entityType: 'user', entityId: u.id });
      return true;
    });
    if (!ok) throw unauthorized('MFA_CODE_INVALID');
    return reply.status(204).send();
  });

  /** Lost phone: an administrator clears the second step; the person sets it up again at the next sign-in. */
  app.post('/admin/staff/:id/mfa/reset', {
    ...auth, preValidation: requirePermission('users.manage'), schema: { tags: ['admin:access'], security: sec, params: idParams, body: z.object({ reason: reasonSchema }) },
  }, async (req, reply) => {
    const actor = requireUser(req);
    if (!can(actor, 'users.manage')) throw forbidden();
    if (actor.id === req.params.id) throw new AppError('FORBIDDEN', 403);
    await withTx(db, async (c) => {
      const r = await c.query('DELETE FROM user_mfa WHERE user_id = $1', [req.params.id]);
      if (!r.rowCount) throw notFound();
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.params.id]);
      await audit(c, actorOf(req), { action: 'auth.mfa_reset', entityType: 'user', entityId: req.params.id, reason: req.body.reason });
    });
    return reply.status(204).send();
  });
}
