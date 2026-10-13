import { loadConfig } from '../config.js';
import { createStorage, LocalStorage } from '../lib/storage.js';
import { restore, RestoreError } from '../ops/backup.js';

/**
 * npm run restore -- <backupDir> <targetDatabaseUrl> <targetStorageDir | s3>
 * Restores into a NEW, EMPTY database and EMPTY file storage, then verifies the copy. With `s3` the
 * files go to the bucket configured by the S3_* variables (it must be a new, empty bucket or prefix).
 * Point the application at the restored copy only after this reports success.
 */
const [backupDir, databaseUrl, target] = process.argv.slice(2);
if (!backupDir || !databaseUrl || !target) {
  console.error('usage: npm run restore -- <backupDir> <targetDatabaseUrl> <targetStorageDir | s3>');
  process.exit(2);
}
try {
  const storage = target === 's3' ? createStorage({ ...loadConfig(), STORAGE_DRIVER: 's3' }) : new LocalStorage(target, Number.MAX_SAFE_INTEGER);
  const r = await restore({ backupDir, databaseUrl, storage });
  const rows = Object.values(r.fingerprint.tables).reduce((a, b) => a + b, 0);
  console.log(`Restored and verified: ${rows} rows, ${r.fingerprint.storageFiles} files, schema ${r.fingerprint.schemaVersion}, ledger balanced, consistency identical to the source`);
  for (const w of r.warnings) console.warn(`Warning: consistency issue carried over from the source — ${w}`);
} catch (e) {
  console.error(e instanceof RestoreError ? `Restore failed: ${e.message}` : e);
  process.exit(1);
}
