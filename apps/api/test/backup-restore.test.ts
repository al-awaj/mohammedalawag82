import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db/pool.js';
import { backup, restore, RestoreError } from '../src/ops/backup.js';
import { PASSWORD, useApp } from './helpers.js';
import { marketplace } from './fixtures.js';

/** Backup and restore (test 40, clause 80): a restored copy is complete, verified and usable. */
const ctx = useApp();
const config = loadConfig();
const restoreUrl = config.DATABASE_URL.replace(/\/[^/?]+(\?|$)/, '/events_restore_test$1');
let work = '';
let owner: { email: string; token: string };
let ids: { documentId: string; mediaId: string; bookingId: string };

async function freshDatabase() {
  const admin = new pg.Client({ connectionString: config.DATABASE_URL });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS events_restore_test WITH (FORCE)');
  await admin.query('CREATE DATABASE events_restore_test');
  await admin.end();
}

beforeAll(async () => {
  work = await mkdtemp(path.join(tmpdir(), 'events-backup-'));
  // Some real activity with money, documents and files.
  const m = await marketplace(ctx, 'PAY_SANDBOX_BACKUP_SECRET');
  const h = await m.hall();
  const c = await m.customer();
  const o = await m.order(c.token, h.serviceId);
  await m.payCard(c.token, o.id, 'upfront');
  owner = c;
  ids = {
    bookingId: o.bookings[0]!.id,
    documentId: (await ctx.db.query('SELECT id FROM documents WHERE booking_id = $1 LIMIT 1', [o.bookings[0]!.id])).rows[0].id,
    mediaId: (await ctx.db.query('SELECT id FROM service_media WHERE service_id = $1 LIMIT 1', [h.serviceId])).rows[0].id,
  };
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
  const admin = new pg.Client({ connectionString: config.DATABASE_URL });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS events_restore_test WITH (FORCE)');
  await admin.end();
});

describe('backup and restore', () => {
  let backupDir = '';

  it('restores into an empty database and proves the copy matches, balances and is usable', async () => {
    const b = await backup({ databaseUrl: config.DATABASE_URL, storageDir: config.STORAGE_DIR, outDir: path.join(work, 'backups') });
    backupDir = b.dir;
    expect(b.manifest.fingerprint.tables.journal_lines).toBeGreaterThan(0);
    expect(b.manifest.fingerprint.storageFiles).toBeGreaterThan(0);

    await freshDatabase();
    const storage = path.join(work, 'restored-storage');
    const r = await restore({ backupDir, databaseUrl: restoreUrl, storageDir: storage });
    expect(r.ok).toBe(true);
    expect(r.fingerprint.tables).toEqual(b.manifest.fingerprint.tables);
    expect(r.consistency.ok).toBe(true);

    // The application runs on the restored copy: sign-in, records, documents and files all work.
    const db = createPool(restoreUrl);
    const app = (await buildApp({ ...config, DATABASE_URL: restoreUrl, STORAGE_DIR: storage }, db)) as unknown as FastifyInstance;
    try {
      const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { identifier: owner.email, password: PASSWORD } });
      expect(login.statusCode).toBe(200);
      const token = login.json().accessToken as string;
      const auth = { authorization: `Bearer ${token}` };
      expect((await app.inject({ method: 'GET', url: `/v1/bookings/${ids.bookingId}`, headers: auth })).json().status).toBe('confirmed');
      const original = await ctx.app.inject({ method: 'GET', url: `/v1/documents/${ids.documentId}`, headers: { authorization: `Bearer ${owner.token}` } });
      const restored = await app.inject({ method: 'GET', url: `/v1/documents/${ids.documentId}`, headers: auth });
      expect(restored.statusCode).toBe(200);
      expect(restored.json().number).toBe(original.json().number);
      const media = await app.inject({ method: 'GET', url: `/v1/media/${ids.mediaId}` });
      expect(media.statusCode).toBe(200);
      expect(media.rawPayload.equals((await ctx.app.inject({ method: 'GET', url: `/v1/media/${ids.mediaId}` })).rawPayload)).toBe(true);
    } finally {
      await app.close();
      await db.end();
    }
  });

  it('refuses to restore over a database that is not empty', async () => {
    await expect(restore({ backupDir, databaseUrl: restoreUrl, storageDir: path.join(work, 'other-storage') })).rejects.toThrow(/not empty/);
  });

  it('detects a damaged or altered backup before touching the target', async () => {
    const copy = path.join(work, 'tampered');
    await cp(backupDir, copy, { recursive: true });
    const dump = path.join(copy, 'db.dump');
    const bytes = await readFile(dump);
    bytes[bytes.length - 10] = bytes[bytes.length - 10]! ^ 0xff;
    await writeFile(dump, bytes);
    await freshDatabase();
    const err = await restore({ backupDir: copy, databaseUrl: restoreUrl, storageDir: path.join(work, 'tampered-storage') }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RestoreError);
    expect((err as Error).message).toMatch(/checksum mismatch for db\.dump/);
    const c = new pg.Client({ connectionString: restoreUrl });
    await c.connect();
    expect((await c.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0].n).toBe(0);
    await c.end();
  });

  it('keeps only the configured number of backups', async () => {
    const out = path.join(work, 'rotating');
    for (let i = 0; i < 3; i++) await backup({ databaseUrl: config.DATABASE_URL, storageDir: config.STORAGE_DIR, outDir: out, keep: 2 });
    expect(await readdir(out)).toHaveLength(2);
  });
});
