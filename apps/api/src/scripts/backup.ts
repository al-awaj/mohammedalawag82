import { loadConfig } from '../config.js';
import { createStorage } from '../lib/storage.js';
import { backup } from '../ops/backup.js';

/** npm run backup -- [outDir] [keep]   (defaults: BACKUP_DIR or ./backups, keep 14) */
const config = loadConfig();
const outDir = process.argv[2] ?? process.env.BACKUP_DIR ?? './backups';
const keep = Number(process.argv[3] ?? process.env.BACKUP_KEEP ?? 14);
const r = await backup({ databaseUrl: config.DATABASE_URL, storage: createStorage(config), outDir, keep });
const rows = Object.values(r.manifest.fingerprint.tables).reduce((a, b) => a + b, 0);
console.log(`Backup written to ${r.dir} (${rows} rows, ${r.manifest.fingerprint.storageFiles} files, schema ${r.manifest.fingerprint.schemaVersion})`);
const issues = Object.entries(r.manifest.fingerprint.consistency).filter(([, n]) => n > 0);
for (const [k, n] of issues) console.warn(`Warning: ${n} ledger consistency issue(s) of type ${k} in the source; see Finance → Reconciliation`);
