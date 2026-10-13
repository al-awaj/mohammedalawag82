import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

/** Production refuses development-only settings at startup instead of running insecurely. */
const good = {
  NODE_ENV: 'production', DATABASE_URL: 'postgres://events:Xk29dk3jd8@db:5432/events',
  JWT_SECRET: 'q8Fz3LmP0vN7wR2tY5uB9cD4eG6hJ1kA',
  CORS_ORIGINS: 'https://admin.example.org,https://www.example.org',
};

describe('configuration', () => {
  it('accepts a proper production configuration', () => {
    expect(loadConfig(good).NODE_ENV).toBe('production');
  });

  it('refuses example secrets, plain-http origins, the development database password and disabled rate limits in production', () => {
    expect(() => loadConfig({ ...good, JWT_SECRET: 'change-me-change-me-change-me-change-me' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...good, JWT_SECRET: 'a'.repeat(40) })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...good, CORS_ORIGINS: 'http://admin.example.org' })).toThrow(/CORS_ORIGINS/);
    expect(() => loadConfig({ ...good, DATABASE_URL: 'postgres://app:app@db:5432/events' })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...good, RATE_LIMIT_ENABLED: 'false' })).toThrow(/RATE_LIMIT_ENABLED/);
  });

  it('allows development defaults outside production', () => {
    expect(() => loadConfig({ ...good, NODE_ENV: 'development', JWT_SECRET: 'change-me-change-me-change-me-change-me', CORS_ORIGINS: 'http://localhost:3001' })).not.toThrow();
  });

  it('treats empty optional storage settings as unset (as compose passes them)', () => {
    expect(loadConfig({ ...good, STORAGE_DRIVER: '', S3_ENDPOINT: '', S3_BUCKET: '' }).STORAGE_DRIVER).toBe('local');
  });

  it('requires a bucket for object storage and both keys or neither', () => {
    expect(() => loadConfig({ ...good, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
    expect(() => loadConfig({ ...good, STORAGE_DRIVER: 's3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k' })).toThrow(/S3_SECRET_ACCESS_KEY/);
    expect(loadConfig({ ...good, STORAGE_DRIVER: 's3', S3_BUCKET: 'b' }).S3_BUCKET).toBe('b'); // instance role / default chain
  });
});
