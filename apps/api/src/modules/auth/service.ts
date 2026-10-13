import type pg from 'pg';
import type { Config } from '../../config.js';
import { withTx, type Db, type Executor } from '../../db/pool.js';
import { audit, type ActorContext } from '../../lib/audit.js';
import { AppError, badRequest, conflict, mapUniqueViolation, notFound, unauthorized } from '../../lib/errors.js';
import { enqueueMessage } from '../../lib/outbox.js';
import { notifyUser } from '../../lib/notify.js';
import { getDummyHash, hashPassword, verifyPassword } from '../../lib/password.js';
import { randomOtp, randomToken, sha256, type TokenService } from '../../lib/tokens.js';

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_SECONDS = 60;

export interface RegisterInput {
  accountType: 'customer' | 'provider';
  fullName: string;
  phone: string;
  email?: string | undefined;
  countryCode: string;
  preferredLanguage: string;
  password: string;
  acceptTerms: boolean;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface CountryRow { id: string; phone_prefix: string; is_active: boolean }

/** Latest published version of a terms kind: country-specific first, then platform-wide. */
export async function currentTerms(exec: Executor, kind: string, countryId: string): Promise<{ id: string } | null> {
  const { rows } = await exec.query<{ id: string }>(
    `SELECT id FROM terms_versions WHERE kind = $1 AND (country_id = $2 OR country_id IS NULL)
      ORDER BY (country_id IS NOT NULL) DESC, published_at DESC LIMIT 1`,
    [kind, countryId],
  );
  return rows[0] ?? null;
}

export class AuthService {
  constructor(private readonly db: Db, private readonly config: Config, private readonly tokens: TokenService) {}

  async register(input: RegisterInput, ctx: ActorContext): Promise<{ userId: string } & SessionTokens> {
    if (!input.acceptTerms) throw badRequest('TERMS_NOT_ACCEPTED');
    const userId = await withTx(this.db, async (c) => {
      const country = (await c.query<CountryRow>('SELECT id, phone_prefix, is_active FROM countries WHERE code = $1', [input.countryCode])).rows[0];
      if (!country?.is_active) throw badRequest('COUNTRY_NOT_AVAILABLE');
      if (!input.phone.startsWith(country.phone_prefix)) throw badRequest('PHONE_COUNTRY_MISMATCH');
      const lang = await c.query('SELECT 1 FROM languages WHERE code = $1 AND is_active', [input.preferredLanguage]);
      if (!lang.rowCount) throw badRequest('LANGUAGE_NOT_SUPPORTED');

      const termsKind = input.accountType === 'provider' ? 'provider_terms' : 'customer_terms';
      const terms = await currentTerms(c, termsKind, country.id);
      const privacy = await currentTerms(c, 'privacy_policy', country.id);
      if (!terms || !privacy) throw badRequest('TERMS_NOT_PUBLISHED');

      let id: string;
      try {
        id = (await c.query<{ id: string }>(
          `INSERT INTO users (kind, full_name, phone, email, country_id, preferred_language)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [input.accountType, input.fullName, input.phone, input.email ?? null, country.id, input.preferredLanguage],
        )).rows[0]!.id;
      } catch (err) {
        mapUniqueViolation(err, { users_phone: 'PHONE_TAKEN', users_email: 'EMAIL_TAKEN' });
      }
      await c.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [id, await hashPassword(input.password)]);
      if (input.accountType === 'customer') await c.query('INSERT INTO customer_profiles (user_id) VALUES ($1)', [id]);
      for (const t of [terms, privacy]) {
        await c.query(
          `INSERT INTO terms_acceptances (user_id, terms_version_id, context, ip) VALUES ($1, $2, 'registration', $3)`,
          [id, t.id, ctx.ip],
        );
      }
      await audit(c, { ...ctx, actorId: id, actorKind: input.accountType }, {
        action: 'user.registered', entityType: 'user', entityId: id,
        after: { kind: input.accountType, countryCode: input.countryCode, phone: input.phone, email: input.email ?? null },
      });
      await this.issueCode(c, id, 'verify_phone', 'sms', input.phone, input.preferredLanguage);
      await notifyUser(c, id, input.accountType === 'provider' ? 'account.welcome_provider' : 'account.welcome', { name: input.fullName });
      return id;
    });
    return { userId, ...(await this.createSession(this.db, userId, input.accountType, ctx)) };
  }

  async login(identifier: string, password: string, ctx: ActorContext): Promise<SessionTokens> {
    const isEmail = identifier.includes('@');
    const { rows } = await this.db.query<{
      id: string; kind: 'customer' | 'provider' | 'staff'; status: string; locked_until: Date | null;
      failed_login_count: number; password_hash: string | null;
    }>(
      `SELECT u.id, u.kind, u.status, u.locked_until, u.failed_login_count, c.password_hash
         FROM users u LEFT JOIN user_credentials c ON c.user_id = u.id
        WHERE ${isEmail ? 'u.email = $1' : 'u.phone = $1'}`,
      [isEmail ? identifier.toLowerCase() : identifier],
    );
    const user = rows[0];
    if (!user?.password_hash) {
      await verifyPassword(password, await getDummyHash());
      throw unauthorized('AUTH_INVALID_CREDENTIALS');
    }
    if (user.locked_until && user.locked_until > new Date()) throw new AppError('AUTH_ACCOUNT_LOCKED', 423);

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      await withTx(this.db, async (c) => {
        const upd = await c.query<{ failed_login_count: number; locked: boolean }>(
          `UPDATE users SET failed_login_count = failed_login_count + 1,
                  locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
            WHERE id = $1 RETURNING failed_login_count, failed_login_count >= $2 AS locked`,
          [user.id, this.config.LOGIN_MAX_FAILURES, this.config.LOGIN_LOCK_MINUTES],
        );
        const r = upd.rows[0]!;
        await audit(c, { ...ctx, actorKind: 'anonymous' }, {
          action: r.locked ? 'auth.account_locked' : 'auth.login_failed', entityType: 'user', entityId: user.id,
          after: { failedCount: r.failed_login_count },
        });
        if (r.locked) await c.query('UPDATE users SET failed_login_count = 0 WHERE id = $1', [user.id]);
      });
      throw unauthorized('AUTH_INVALID_CREDENTIALS');
    }
    if (user.status !== 'active') throw new AppError('AUTH_ACCOUNT_DISABLED', 403);

    return withTx(this.db, async (c) => {
      await c.query('UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [user.id]);
      await audit(c, { ...ctx, actorId: user.id, actorKind: user.kind }, { action: 'auth.login', entityType: 'user', entityId: user.id });
      return this.createSession(c, user.id, user.kind, ctx);
    });
  }

  /** Rotates the refresh token. Presenting an already-rotated token revokes the whole family (theft signal). */
  async refresh(refreshToken: string, ctx: ActorContext): Promise<SessionTokens> {
    return withTx(this.db, async (c) => {
      const { rows } = await c.query<{ id: string; user_id: string; family_id: string; expires_at: Date; revoked_at: Date | null; kind: 'customer' | 'provider' | 'staff'; status: string }>(
        `SELECT t.id, t.user_id, t.family_id, t.expires_at, t.revoked_at, u.kind, u.status
           FROM refresh_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = $1 FOR UPDATE OF t`,
        [sha256(refreshToken)],
      );
      const tok = rows[0];
      if (!tok) throw unauthorized('AUTH_INVALID_REFRESH');
      if (tok.revoked_at) {
        await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [tok.family_id]);
        await audit(c, { ...ctx, actorId: tok.user_id, actorKind: tok.kind }, {
          action: 'auth.refresh_reuse_detected', entityType: 'user', entityId: tok.user_id,
        });
        return null;
      }
      if (tok.expires_at <= new Date() || tok.status !== 'active') throw unauthorized('AUTH_INVALID_REFRESH');
      const session = await this.createSession(c, tok.user_id, tok.kind, ctx, tok.family_id);
      await c.query(
        'UPDATE refresh_tokens SET revoked_at = now(), replaced_by = (SELECT id FROM refresh_tokens WHERE token_hash = $2) WHERE id = $1',
        [tok.id, sha256(session.refreshToken)],
      );
      return session;
    }).then((s) => {
      // Reuse detection must commit the revocation, then fail.
      if (!s) throw unauthorized('AUTH_INVALID_REFRESH');
      return s;
    });
  }

  async logout(userId: string, refreshToken: string | undefined, ctx: ActorContext): Promise<void> {
    await withTx(this.db, async (c) => {
      if (refreshToken) {
        await c.query(
          `UPDATE refresh_tokens SET revoked_at = now()
            WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2) AND revoked_at IS NULL`,
          [sha256(refreshToken), userId],
        );
      } else {
        await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      }
      await audit(c, ctx, { action: 'auth.logout', entityType: 'user', entityId: userId, after: { allSessions: !refreshToken } });
    });
  }

  async requestVerification(userId: string, channel: 'phone' | 'email'): Promise<void> {
    await withTx(this.db, async (c) => {
      const u = (await c.query<{ phone: string | null; email: string | null; phone_verified_at: Date | null; email_verified_at: Date | null; preferred_language: string }>(
        'SELECT phone, email, phone_verified_at, email_verified_at, preferred_language FROM users WHERE id = $1 FOR UPDATE', [userId],
      )).rows[0];
      if (!u) throw notFound();
      const target = channel === 'phone' ? u.phone : u.email;
      if (!target) throw badRequest('CONTACT_MISSING');
      if (channel === 'phone' ? u.phone_verified_at : u.email_verified_at) throw conflict('ALREADY_VERIFIED');
      await this.issueCode(c, userId, channel === 'phone' ? 'verify_phone' : 'verify_email', channel === 'phone' ? 'sms' : 'email', target, u.preferred_language);
    });
  }

  async confirmVerification(userId: string, channel: 'phone' | 'email', code: string, ctx: ActorContext): Promise<void> {
    await withTx(this.db, async (c) => {
      const purpose = channel === 'phone' ? 'verify_phone' : 'verify_email';
      const target = (await c.query<{ phone: string | null; email: string | null }>('SELECT phone, email FROM users WHERE id = $1', [userId])).rows[0];
      await this.consumeCode(c, userId, purpose, code, channel === 'phone' ? target?.phone : target?.email);
      await c.query(`UPDATE users SET ${channel === 'phone' ? 'phone_verified_at' : 'email_verified_at'} = now() WHERE id = $1`, [userId]);
      await audit(c, ctx, { action: `auth.${purpose}`, entityType: 'user', entityId: userId });
    });
  }

  /** Always succeeds from the caller's view, so accounts cannot be enumerated. */
  async forgotPassword(identifier: string): Promise<void> {
    const isEmail = identifier.includes('@');
    await withTx(this.db, async (c) => {
      const u = (await c.query<{ id: string; phone: string | null; email: string | null; preferred_language: string }>(
        `SELECT id, phone, email, preferred_language FROM users WHERE ${isEmail ? 'email' : 'phone'} = $1 AND status = 'active' FOR UPDATE`,
        [isEmail ? identifier.toLowerCase() : identifier],
      )).rows[0];
      if (!u) return;
      try {
        await this.issueCode(c, u.id, 'reset_password', isEmail ? 'email' : 'sms', identifier, u.preferred_language);
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'RATE_LIMITED')) throw err;
      }
    });
  }

  async resetPassword(identifier: string, code: string, newPassword: string, ctx: ActorContext): Promise<void> {
    const isEmail = identifier.includes('@');
    await withTx(this.db, async (c) => {
      const u = (await c.query<{ id: string; kind: 'customer' | 'provider' | 'staff' }>(
        `SELECT id, kind FROM users WHERE ${isEmail ? 'email' : 'phone'} = $1`, [isEmail ? identifier.toLowerCase() : identifier],
      )).rows[0];
      if (!u) throw badRequest('CODE_INVALID');
      await this.consumeCode(c, u.id, 'reset_password', code, isEmail ? identifier.toLowerCase() : identifier);
      await c.query('UPDATE user_credentials SET password_hash = $2, password_changed_at = now() WHERE user_id = $1', [u.id, await hashPassword(newPassword)]);
      await c.query('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [u.id]);
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [u.id]);
      await audit(c, { ...ctx, actorId: u.id, actorKind: u.kind }, { action: 'auth.password_reset', entityType: 'user', entityId: u.id });
    });
  }

  async changePassword(userId: string, current: string, next: string, ctx: ActorContext): Promise<void> {
    const row = (await this.db.query<{ password_hash: string }>('SELECT password_hash FROM user_credentials WHERE user_id = $1', [userId])).rows[0];
    if (!row || !(await verifyPassword(current, row.password_hash))) throw unauthorized('AUTH_INVALID_CREDENTIALS');
    await withTx(this.db, async (c) => {
      await c.query('UPDATE user_credentials SET password_hash = $2, password_changed_at = now() WHERE user_id = $1', [userId, await hashPassword(next)]);
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await audit(c, ctx, { action: 'auth.password_changed', entityType: 'user', entityId: userId });
    });
  }

  private async createSession(
    exec: Executor, userId: string, kind: 'customer' | 'provider' | 'staff', ctx: ActorContext, familyId?: string,
  ): Promise<SessionTokens> {
    const refreshToken = randomToken();
    await exec.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, ip)
       VALUES ($1, coalesce($2, gen_random_uuid()), $3, now() + make_interval(days => $4), $5)`,
      [userId, familyId ?? null, sha256(refreshToken), this.config.REFRESH_TOKEN_TTL_DAYS, ctx.ip],
    );
    return {
      accessToken: await this.tokens.signAccess({ sub: userId, kind }),
      refreshToken,
      expiresIn: this.config.ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  private async issueCode(
    c: pg.PoolClient, userId: string, purpose: string, channel: 'sms' | 'email', target: string, language: string,
  ): Promise<void> {
    const recent = await c.query(
      `SELECT 1 FROM verification_codes WHERE user_id = $1 AND purpose = $2 AND created_at > now() - make_interval(secs => $3)`,
      [userId, purpose, OTP_RESEND_SECONDS],
    );
    if (recent.rowCount) throw new AppError('RATE_LIMITED', 429);
    await c.query('UPDATE verification_codes SET consumed_at = now() WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL', [userId, purpose]);
    const code = randomOtp();
    await c.query(
      `INSERT INTO verification_codes (user_id, purpose, channel, target, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
      [userId, purpose, channel, target, sha256(`${userId}:${purpose}:${code}`), OTP_TTL_MINUTES],
    );
    await enqueueMessage(c, {
      channel, recipientUserId: userId, target, templateKey: `auth.${purpose}`, language,
      payload: { code, expiresInMinutes: OTP_TTL_MINUTES },
    });
  }

  private async consumeCode(c: pg.PoolClient, userId: string, purpose: string, code: string, expectedTarget?: string | null): Promise<void> {
    const row = (await c.query<{ id: string; code_hash: string; attempts: number; target: string }>(
      `SELECT id, code_hash, attempts, target FROM verification_codes
        WHERE user_id = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [userId, purpose],
    )).rows[0];
    if (!row || (expectedTarget && row.target !== expectedTarget)) throw badRequest('CODE_INVALID');
    if (row.attempts >= OTP_MAX_ATTEMPTS) throw new AppError('CODE_TOO_MANY_ATTEMPTS', 429);
    if (row.code_hash !== sha256(`${userId}:${purpose}:${code}`)) {
      // The failed attempt must persist although the request fails, so commit it here.
      // Precondition: callers invoke consumeCode before making any other writes in the transaction.
      await c.query('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      await c.query('COMMIT');
      await c.query('BEGIN');
      throw badRequest('CODE_INVALID');
    }
    await c.query('UPDATE verification_codes SET consumed_at = now() WHERE id = $1', [row.id]);
  }
}
