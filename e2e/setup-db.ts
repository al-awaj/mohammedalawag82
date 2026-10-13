import pg from 'pg';
import { E2E } from './env';
import { createPool, withTx } from '../apps/api/src/db/pool';
import { migrate } from '../apps/api/src/db/migrate';
import { seedReference } from '../apps/api/src/scripts/seed';
import { hashPassword } from '../apps/api/src/lib/password';

/** Recreates the browser-test database: schema, reference data and the first administrator. */
const url = E2E.databaseUrl;
if (!/e2e/.test(url)) throw new Error(`Refusing to reset a non-e2e database: ${url}`);
const name = new URL(url).pathname.slice(1);
const server = new pg.Client({ connectionString: url.replace(/\/[^/]+$/, '/postgres') });
await server.connect();
if (!(await server.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount) await server.query(`CREATE DATABASE ${name}`);
await server.end();
const c = new pg.Client({ connectionString: url });
await c.connect();
await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await c.end();
const db = createPool(url);
await migrate(db);
await seedReference(db);
await withTx(db, async (t) => {
  const id = (await t.query<{ id: string }>(
    `INSERT INTO users (kind, full_name, email, preferred_language, email_verified_at) VALUES ('staff', $1, $2, 'ar', now()) RETURNING id`,
    [E2E.admin.name, E2E.admin.email])).rows[0]!.id;
  await t.query('INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)', [id, await hashPassword(E2E.admin.password)]);
  await t.query('INSERT INTO staff_profiles (user_id, job_title) VALUES ($1, $2)', [id, 'System administrator']);
  await t.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'system_admin'`, [id]);
});
await db.end();
console.log(`E2E database ready: ${name}`);
