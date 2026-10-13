import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  CORS_ORIGINS: z.string().default(''),
  STORAGE_DIR: z.string().default('./storage'),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  MAX_VIDEO_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  // Which reverse proxies may set X-Forwarded-For (client IP for rate limits and the audit log):
  // a hop count ("1"), or addresses/CIDRs ("loopback", "10.0.0.0/8,127.0.0.1"). Empty = trust none.
  TRUST_PROXY: z.string().default('loopback').transform((v) => (v === '' ? false : /^\d+$/.test(v) ? Number(v) : v.split(',').map((x) => x.trim()))),
  RATE_LIMIT_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // File storage: local disk (a persistent volume) or any S3-compatible private bucket.
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.url().optional(),
  S3_FORCE_PATH_STYLE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PREFIX: z.string().optional(),
}).superRefine((c, ctx) => {
  const fail = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (c.STORAGE_DRIVER === 's3' && !c.S3_BUCKET) fail('S3_BUCKET', 'required when STORAGE_DRIVER=s3');
  if ((c.S3_ACCESS_KEY_ID === undefined) !== (c.S3_SECRET_ACCESS_KEY === undefined)) fail('S3_SECRET_ACCESS_KEY', 'set both S3 keys or neither');
  // Production refuses settings that are only acceptable on a developer machine.
  if (c.NODE_ENV === 'production') {
    if (/change-me|example|secret-that/i.test(c.JWT_SECRET) || new Set(c.JWT_SECRET).size < 10) fail('JWT_SECRET', 'use a random value (openssl rand -base64 48), not the example');
    for (const o of c.CORS_ORIGINS.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!o.startsWith('https://')) fail('CORS_ORIGINS', `${o}: production origins must use https`);
    }
    if (/\/\/app:app@/.test(c.DATABASE_URL)) fail('DATABASE_URL', 'the development database password is not allowed in production');
    if (!c.RATE_LIMIT_ENABLED) fail('RATE_LIMIT_ENABLED', 'must stay enabled in production');
  }
});

export type Config = z.infer<typeof schema>;

/** Optional settings that deployment tools often pass as empty strings when unset. */
const EMPTY_MEANS_UNSET = ['S3_BUCKET', 'S3_ENDPOINT', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PREFIX', 'S3_REGION', 'S3_FORCE_PATH_STYLE', 'STORAGE_DRIVER'];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([k, v]) => !(EMPTY_MEANS_UNSET.includes(k) && v === '')));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
