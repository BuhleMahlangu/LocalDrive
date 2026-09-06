// One-shot SQLite backup using better-sqlite3's online backup API (consistent
// even while the server is running with WAL). Prunes to BACKUP_KEEP latest files.
//
//   npm run backup             -> copies ./data/drivelocal.sqlite to ./backups/
//   BACKUP_KEEP=30 npm run backup
// Also schedule from cron/systemd-Timer or Windows Task Scheduler.
//
// The local SQLite file is the ONLY copy of all users/trips, so back it up.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', '..', 'data');
const backupsDir = path.join(__dirname, '..', '..', 'backups');
const dbFile = process.env.DB_FILE || path.join(dataDir, 'drivelocal.sqlite');
const KEEP = parseInt(process.env.BACKUP_KEEP || '14', 10);

if (!fs.existsSync(dbFile)) {
  console.error(`Database file not found: ${dbFile}`);
  process.exit(1);
}
fs.mkdirSync(backupsDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destFile = path.join(backupsDir, `drivelocal-${stamp}.sqlite`);

const src = new Database(dbFile, { readonly: true });

src.backup(destFile)
  .then(() => {
    src.close();

    const backups = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.sqlite')).sort();
    while (backups.length > KEEP) {
      fs.unlinkSync(path.join(backupsDir, backups.shift()));
    }
    console.log(`Backup written: ${destFile}`);
    console.log(`Retaining ${KEEP} backups in ${backupsDir}`);
  })
  .catch((err) => {
    console.error('Backup failed:', err.message);
    src.close();
    process.exit(1);
  });