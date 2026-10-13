import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { S3Storage } from '../src/lib/storage.js';
import { backup, restore } from '../src/ops/backup.js';
import { api, PNG, upload, uniq, type Ctx } from './helpers.js';
import { marketplace } from './fixtures.js';

/**
 * S3-compatible object storage against a real S3 API (SeaweedFS in CI: S3_TEST_ENDPOINT). Proves the
 * production storage path end to end: uploads, permission-checked serving, readiness, backup/restore.
 */
const endpoint = process.env.S3_TEST_ENDPOINT;
const base = loadConfig();
// One bucket, a fresh prefix per run (test servers like SeaweedFS allocate volumes per bucket).
const bucket = 'events-test';
const run = `run-${Date.now()}`;
const s3cfg = { STORAGE_DRIVER: 's3' as const, S3_BUCKET: bucket, S3_PREFIX: run, S3_ENDPOINT: endpoint, S3_REGION: 'us-east-1', S3_FORCE_PATH_STYLE: true, S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test-secret' };
const store = (sub?: string) => new S3Storage({ bucket, region: 'us-east-1', endpoint, forcePathStyle: true, accessKeyId: 'test', secretAccessKey: 'test-secret', prefix: sub ? `${run}-${sub}` : run }, 1024 * 1024);

describe.runIf(endpoint)('S3-compatible storage', () => {
  const ctx = {} as Ctx;
  let db: Db;

  beforeAll(async () => {
    const client = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test-secret' } });
    await client.send(new CreateBucketCommand({ Bucket: bucket })).catch((e: { name?: string }) => {
      if (e.name !== 'BucketAlreadyOwnedByYou' && e.name !== 'BucketAlreadyExists') throw e;
    });
    db = createPool(base.DATABASE_URL);
    ctx.db = db;
    ctx.app = (await buildApp({ ...base, ...s3cfg }, db)) as unknown as FastifyInstance;
    await ctx.app.ready();
  });
  afterAll(async () => {
    await ctx.app.close();
    await db.end();
  });

  it('stores, serves and removes files, with the same validation as local storage', async () => {
    const s = store('unit');
    const f = await s.save('services/x', PNG, ['image/png']);
    expect((await s.get(f.key)).equals(PNG)).toBe(true);
    expect((await s.open(f.key)).size).toBe(PNG.length);
    await expect(s.save('services/x', Buffer.from('<svg/>'), ['image/png'])).rejects.toMatchObject({ code: 'FILE_TYPE_NOT_ALLOWED' });
    await expect(s.open('../../etc/passwd')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const keys = [];
    for await (const k of s.keys()) keys.push(k);
    expect(keys).toEqual([f.key]);
    await s.remove(f.key);
    await expect(s.open(f.key)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('runs the platform on object storage: uploads go to the bucket and are served through permission checks', async () => {
    const m = await marketplace(ctx, 'PAY_SANDBOX_S3_SECRET');
    const h = await m.hall();
    const media = (await db.query('SELECT id, file_key FROM service_media WHERE service_id = $1', [h.serviceId])).rows[0];
    expect((await store().get(media.file_key)).equals(PNG)).toBe(true);
    const r = await ctx.app.inject({ method: 'GET', url: `/v1/media/${media.id}` });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(PNG)).toBe(true);
    // Unpublished media stays private even though it sits in the same bucket.
    const draft = await api(ctx, 'POST', '/v1/provider/services', { token: h.p.token, body: {
      serviceTypeId: m.hallType, title: { en: `Draft ${uniq()}` }, description: { en: 'D' }, city: 'Riyadh', currency: 'SAR', basePrice: '1000', pricingUnit: 'fixed', requiresProviderApproval: false } });
    const up = await upload(ctx, `/v1/provider/services/${draft.body.id}/media`, h.p.token, PNG);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/media/${up.body.id}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/v1/media/${up.body.id}`, headers: { authorization: `Bearer ${h.p.token}` } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/ready' })).json()).toMatchObject({ status: 'ready', checks: { storage: 'ok' } });
  });

  it('backs up the bucket and restores it into an empty prefix, verified', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'events-s3-'));
    const restoreUrl = base.DATABASE_URL.replace(/\/[^/?]+(\?|$)/, '/events_s3_restore_test$1');
    const admin = new pg.Client({ connectionString: base.DATABASE_URL });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS events_s3_restore_test WITH (FORCE)');
    await admin.query('CREATE DATABASE events_s3_restore_test');
    try {
      const b = await backup({ databaseUrl: base.DATABASE_URL, storage: store(), outDir: work });
      expect(b.manifest.fingerprint.storageFiles).toBeGreaterThan(0);
      const r = await restore({ backupDir: b.dir, databaseUrl: restoreUrl, storage: store('restored') });
      expect(r.fingerprint.storageKeys).toBe(b.manifest.fingerprint.storageKeys);
    } finally {
      await admin.query('DROP DATABASE IF EXISTS events_s3_restore_test WITH (FORCE)');
      await admin.end();
      await rm(work, { recursive: true, force: true });
    }
  });

  it('reports not ready when the bucket cannot be reached', async () => {
    const app = (await buildApp({ ...base, ...s3cfg, S3_BUCKET: 'does-not-exist-bucket' }, db)) as unknown as FastifyInstance;
    const r = await app.inject({ method: 'GET', url: '/ready' });
    expect(r.statusCode).toBe(503);
    expect(r.json().checks.storage).toBe('unreachable');
    await app.close();
  });
});
