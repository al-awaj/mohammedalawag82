import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { createPool } from '../db/pool.js';
import { consistencyChecks } from '../modules/reconciliation/service.js';

const run = promisify(execFile);

/**
 * Backup and restore (clause 80). A backup is a directory holding:
 *   db.dump        pg_dump custom-format archive (schema + data, no owners/privileges)
 *   storage.tar.gz the uploaded files (media, documents, proofs)
 *   manifest.json  checksums of both, the schema version and a fingerprint of the data
 * Restore checks the checksums, loads into an empty database, unpacks the files and then proves the
 * restored copy matches the fingerprint and that the books still balance.
 */
export interface Fingerprint {
  schemaVersion: string;
  tables: Record<string, number>;
  ledger: { currency: string; entries: number; debit: string; credit: string }[];
  storageFiles: number;
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

async function countFiles(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) n++;
  return n;
}

/** What must be identical between the source and a restored copy. */
export async function fingerprint(databaseUrl: string, storageDir: string): Promise<Fingerprint> {
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
    return { schemaVersion, tables, ledger, storageFiles: await countFiles(storageDir) };
  } finally {
    await c.end();
  }
}

/** Writes a consistent backup of the database and the storage directory into `outDir/<timestamp>`. */
export async function backup(opts: { databaseUrl: string; storageDir: string; outDir: string; keep?: number }) {
  const dir = path.join(opts.outDir, new Date().toISOString().replace(/[:.]/g, '-'));
  await mkdir(dir, { recursive: true });
  // The fingerprint is taken first; pg_dump runs in one snapshot and the platform only appends to the
  // financial tables, so a quiet system (maintenance window) is required for an exact match.
  const fp = await fingerprint(opts.databaseUrl, opts.storageDir);
  await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', path.join(dir, 'db.dump'), opts.databaseUrl], { maxBuffer: 1 << 26 });
  if (existsSync(opts.storageDir)) {
    await run('tar', ['-czf', path.join(dir, 'storage.tar.gz'), '-C', path.resolve(opts.storageDir), '.']);
  } else {
    await run('tar', ['-czf', path.join(dir, 'storage.tar.gz'), '--files-from', '/dev/null']);
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
 * Restores a backup into an EMPTY database and storage directory, then verifies it. Throws
 * RestoreError on a checksum mismatch, a non-empty target or any verification difference.
 */
export async function restore(opts: { backupDir: string; databaseUrl: string; storageDir: string }) {
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
  if (existsSync(opts.storageDir) && (await readdir(opts.storageDir)).length > 0) throw new RestoreError('the target storage directory is not empty');

  await run('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', '--dbname', opts.databaseUrl, path.join(opts.backupDir, 'db.dump')], { maxBuffer: 1 << 26 });
  await mkdir(opts.storageDir, { recursive: true });
  await run('tar', ['-xzf', path.join(opts.backupDir, 'storage.tar.gz'), '-C', path.resolve(opts.storageDir)]);
  return verify(manifest, opts.databaseUrl, opts.storageDir);
}

/** Compares a restored copy with the manifest and re-runs the ledger consistency checks. */
export async function verify(manifest: Manifest, databaseUrl: string, storageDir: string) {
  const fp = await fingerprint(databaseUrl, storageDir);
  const differences: string[] = [];
  if (fp.schemaVersion !== manifest.fingerprint.schemaVersion) differences.push(`schema ${fp.schemaVersion} != ${manifest.fingerprint.schemaVersion}`);
  for (const [t, n] of Object.entries(manifest.fingerprint.tables)) if (fp.tables[t] !== n) differences.push(`${t}: ${fp.tables[t] ?? 'missing'} rows != ${n}`);
  if (JSON.stringify(fp.ledger) !== JSON.stringify(manifest.fingerprint.ledger)) differences.push('ledger totals differ');
  if (fp.storageFiles !== manifest.fingerprint.storageFiles) differences.push(`storage files ${fp.storageFiles} != ${manifest.fingerprint.storageFiles}`);
  const unbalanced = fp.ledger.filter((l) => l.debit !== l.credit).map((l) => l.currency);
  if (unbalanced.length) differences.push(`ledger does not balance in ${unbalanced.join(', ')}`);

  const pool = createPool(databaseUrl);
  let checks;
  try {
    checks = await consistencyChecks(pool, null, null);
  } finally {
    await pool.end();
  }
  if (!checks.ok) differences.push(`${checks.issues} consistency issue(s): ${Object.entries(checks.checks).filter(([, v]) => v.length).map(([k]) => k).join(', ')}`);
  if (differences.length) throw new RestoreError(`restored copy does not match the backup:\n- ${differences.join('\n- ')}`);
  return { ok: true as const, fingerprint: fp, consistency: checks };
}
