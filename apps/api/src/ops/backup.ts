import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { createPool } from '../db/pool.js';
import { type FileStore, LocalStorage } from '../lib/storage.js';
import { consistencyChecks } from '../modules/reconciliation/service.js';

const run = promisify(execFile);

/**
 * Backup and restore (clause 80). A backup is a directory holding:
 *   db.dump        pg_dump custom-format archive (schema + data, no owners/privileges)
 *   storage.tar.gz the uploaded files (media, documents, proofs), from local disk or an S3 bucket
 *   manifest.json  checksums of both, the schema version and a fingerprint of the data
 * Restore checks the checksums, loads into an empty database, unpacks the files and then proves the
 * restored copy matches the fingerprint and that the books still balance.
 */
export interface Fingerprint {
  schemaVersion: string;
  tables: Record<string, number>;
  ledger: { currency: string; entries: number; debit: string; credit: string }[];
  storageFiles: number;
  /** sha256 of the sorted list of stored keys: the same files, not just the same number. */
  storageKeys: string;
  /** Issues found by the ledger consistency checks at backup time (a faithful copy has exactly these). */
  consistency: Record<string, number>;
}

export interface Manifest {
  format: 1;
  createdAt: string;
  files: Record<string, { sha256: string; bytes: number }>;
  fingerprint: Fingerprint;
}

async function sha256(file: string) {
  const h = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { h.update(chunk as Buffer); bytes += (chunk as Buffer).length; }
  return { sha256: h.digest('hex'), bytes };
}

async function storageIndex(storage: FileStore) {
  const keys: string[] = [];
  for await (const k of storage.keys()) keys.push(k);
  keys.sort();
  return { keys, digest: createHash('sha256').update(keys.join('\n')).digest('hex') };
}

async function consistencyCounts(databaseUrl: string) {
  const pool = createPool(databaseUrl);
  try {
    const r = await consistencyChecks(pool, null, null);
    return Object.fromEntries(Object.entries(r.checks).map(([k, v]) => [k, v.length]));
  } finally {
    await pool.end();
  }
}

/** What must be identical between the source and a restored copy. */
export async function fingerprint(databaseUrl: string, storage: FileStore): Promise<Fingerprint> {
  const c = new pg.Client({ connectionString: databaseUrl });
  await c.connect();
  try {
    const schemaVersion = (await c.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1')).rows[0]?.name ?? 'none';
    const names = (await c.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)).rows.map((r) => r.tablename);
    const tables: Record<string, number> = {};
    for (const t of names) tables[t] = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t}"`)).rows[0]!.n;
    const ledger = (await c.query<{ currency: string; entries: number; debit: string; credit: string }>(
      `SELECT l.currency_code AS currency, count(DISTINCT l.entry_id)::int AS entries, sum(l.debit)::text AS debit, sum(l.credit)::text AS credit
         FROM journal_lines l GROUP BY l.currency_code ORDER BY l.currency_code`)).rows;
    const idx = await storageIndex(storage);
    return { schemaVersion, tables, ledger, storageFiles: idx.keys.length, storageKeys: idx.digest, consistency: await consistencyCounts(databaseUrl) };
  } finally {
    await c.end();
  }
}

/** Writes a consistent backup of the database and the file storage into `outDir/<timestamp>`. */
export async function backup(opts: { databaseUrl: string; storage: FileStore; outDir: string; keep?: number }) {
  const dir = path.join(opts.outDir, new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(dir, { recursive: true });
  // The fingerprint is taken first; pg_dump runs in one snapshot and the platform only appends to the
  // financial tables, so a quiet system (maintenance window) is required for an exact match.
  const fp = await fingerprint(opts.databaseUrl, opts.storage);
  await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', path.join(dir, 'db.dump'), opts.databaseUrl], { maxBuffer: 1 << 26 });
  const archive = path.join(dir, 'storage.tar.gz');
  if (opts.storage instanceof LocalStorage) {
    if (existsSync(opts.storage.root)) await run('tar', ['-czf', archive, '-C', path.resolve(opts.storage.root), '.']);
    else await run('tar', ['-czf', archive, '--files-from', '/dev/null']);
  } else {
    // Object storage: copy every object into a staging folder, archive it, then remove the copy.
    const stage = await mkdtemp(path.join(opts.outDir, '.staging-'));
    try {
      for await (const key of opts.storage.keys()) {
        const target = path.join(stage, key);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, await opts.storage.get(key));
      }
      await run('tar', ['-czf', archive, '-C', stage, '.']);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  const manifest: Manifest = {
    format: 1, createdAt: new Date().toISOString(),
    files: { 'db.dump': await sha256(path.join(dir, 'db.dump')), 'storage.tar.gz': await sha256(path.join(dir, 'storage.tar.gz')) },
    fingerprint: fp,
  };
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (opts.keep) await prune(opts.outDir, opts.keep);
  return { dir, manifest };
}

/** Keeps the newest `keep` backups. */
async function prune(outDir: string, keep: number) {
  const dirs = (await readdir(outDir, { withFileTypes: true })).filter((d) => d.isDirectory() && existsSync(path.join(outDir, d.name, 'manifest.json'))).map((d) => d.name).sort();
  for (const d of dirs.slice(0, Math.max(0, dirs.length - keep))) await rm(path.join(outDir, d), { recursive: true, force: true });
}

export class RestoreError extends Error {}

/**
 * Restores a backup into an EMPTY database and EMPTY file storage, then verifies it. Throws
 * RestoreError on a checksum mismatch, a non-empty target or any verification difference.
 */
export async function restore(opts: { backupDir: string; databaseUrl: string; storage: FileStore }) {
  const manifest = JSON.parse(await readFile(path.join(opts.backupDir, 'manifest.json'), 'utf8')) as Manifest;
  if (manifest.format !== 1) throw new RestoreError(`unsupported backup format ${manifest.format}`);
  for (const [name, want] of Object.entries(manifest.files)) {
    const got = await sha256(path.join(opts.backupDir, name));
    if (got.sha256 !== want.sha256 || got.bytes !== want.bytes) throw new RestoreError(`checksum mismatch for ${name}: the backup is damaged or was altered`);
  }

  const c = new pg.Client({ connectionString: opts.databaseUrl });
  await c.connect();
  try {
    const existing = (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`)).rows[0]!.n;
    if (existing > 0) throw new RestoreError('the target database is not empty; restore only into a new, empty database');
  } finally {
    await c.end();
  }
  for await (const _ of opts.storage.keys()) throw new RestoreError('the target file storage is not empty');

  await run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', '--dbname', opts.databaseUrl, path.join(opts.backupDir, 'db.dump')], { maxBuffer: 1 << 26 });
  const archive = path.join(opts.backupDir, 'storage.tar.gz');
  if (opts.storage instanceof LocalStorage) {
    await mkdir(opts.storage.root, { recursive: true });
    await run('tar', ['-xzf', archive, '-C', path.resolve(opts.storage.root)]);
  } else {
    const stage = await mkdtemp(path.join(opts.backupDir, '.restore-'));
    try {
      await run('tar', ['-xzf', archive, '-C', stage]);
      for (const e of await readdir(stage, { withFileTypes: true, recursive: true })) {
        if (!e.isFile()) continue;
        const full = path.join(e.parentPath, e.name);
        await opts.storage.put(path.relative(stage, full).split(path.sep).join('/'), await readFile(full));
      }
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
  return verify(manifest, opts.databaseUrl, opts.storage);
}

/** Compares a restored copy with the manifest and re-runs the ledger consistency checks. */
export async function verify(manifest: Manifest, databaseUrl: string, storage: FileStore) {
  const fp = await fingerprint(databaseUrl, storage);
  const differences: string[] = [];
  if (fp.schemaVersion !== manifest.fingerprint.schemaVersion) differences.push(`schema ${fp.schemaVersion} != ${manifest.fingerprint.schemaVersion}`);
  for (const [t, n] of Object.entries(manifest.fingerprint.tables)) if (fp.tables[t] !== n) differences.push(`${t}: ${fp.tables[t] ?? 'missing'} rows != ${n}`);
  if (JSON.stringify(fp.ledger) !== JSON.stringify(manifest.fingerprint.ledger)) differences.push('ledger totals differ');
  if (fp.storageFiles !== manifest.fingerprint.storageFiles) differences.push(`storage files ${fp.storageFiles} != ${manifest.fingerprint.storageFiles}`);
  else if (fp.storageKeys !== manifest.fingerprint.storageKeys) differences.push('stored file names differ');
  const unbalanced = fp.ledger.filter((l) => l.debit !== l.credit).map((l) => l.currency);
  if (unbalanced.length) differences.push(`ledger does not balance in ${unbalanced.join(', ')}`);

  if (JSON.stringify(fp.consistency) !== JSON.stringify(manifest.fingerprint.consistency)) differences.push('ledger consistency checks differ from the source');
  if (differences.length) throw new RestoreError(`restored copy does not match the backup:\n- ${differences.join('\n- ')}`);
  // Issues already present in the source are carried over faithfully and reported, not hidden.
  const warnings = Object.entries(fp.consistency).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n} (already in the source)`);
  return { ok: true as const, fingerprint: fp, warnings };
}
