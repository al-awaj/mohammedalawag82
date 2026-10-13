import { restore, RestoreError } from '../ops/backup.js';

/**
 * npm run restore -- <backupDir> <targetDatabaseUrl> <targetStorageDir>
 * Restores into a NEW, EMPTY database and storage directory, then verifies the copy. Point the
 * application at the restored database only after this reports success.
 */
const [backupDir, databaseUrl, storageDir] = process.argv.slice(2);
if (!backupDir || !databaseUrl || !storageDir) {
  console.error('usage: npm run restore -- <backupDir> <targetDatabaseUrl> <targetStorageDir>');
  process.exit(2);
}
try {
  const r = await restore({ backupDir, databaseUrl, storageDir });
  const rows = Object.values(r.fingerprint.tables).reduce((a, b) => a + b, 0);
  console.log(`Restored and verified: ${rows} rows, ${r.fingerprint.storageFiles} files, schema ${r.fingerprint.schemaVersion}, ledger balanced, consistency checks passed`);
} catch (e) {
  console.error(e instanceof RestoreError ? `Restore failed: ${e.message}` : e);
  process.exit(1);
}
