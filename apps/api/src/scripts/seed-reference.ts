import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { seedReference } from './seed.js';

const db = createPool(loadConfig().DATABASE_URL);
try {
  await seedReference(db);
  console.log('Reference data synced (languages, currencies, permissions, system roles)');
} finally {
  await db.end();
}
