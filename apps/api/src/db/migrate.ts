import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Db } from './pool.js';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

/**
 * Applies pending NNNN_name.sql files in order, each in its own transaction.
 * A changed checksum of an already-applied file aborts: applied migrations are immutable.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied = new Map(
    (await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
      (r) => [r.name, r.checksum],
    ),
  );
  const ran: string[] = [];
  for (const file of files) {
    const sql = await readFile(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const existing = applied.get(file);
    if (existing) {
      if (existing !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
      continue;
    }
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return ran;
}

/** Migration files not yet applied (readiness: the app must not serve an outdated schema). */
export async function pendingMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations').catch(() => ({ rows: [] }))).rows.map((r) => r.name));
  return files.filter((f) => !applied.has(f));
}
