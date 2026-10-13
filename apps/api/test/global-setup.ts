import pg from 'pg';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { seedReference } from '../src/scripts/seed.js';

/** Fresh schema for every test run: drop everything, migrate, seed reference data. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://app:app@localhost:5432/events_test';
  if (!/test/.test(url)) throw new Error(`Refusing to reset a non-test database: ${url}`);
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  const db = createPool(url);
  await migrate(db);
  await seedReference(db);
  await db.end();
}
