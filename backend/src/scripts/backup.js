// One-shot SQLite backup using better-sqlite3's online backup API (consistent
// even while the server is running with WAL). Prunes to BACKUP_KEEP latest files.
// Optionally uploads the copy to an S3-compatible bucket (BACKUP_S3_* env vars)
// so a failed machine never means lost users/trips.
//
//   npm run backup             -> copies ./data/drivelocal.sqlite to ./backups/
//   BACKUP_KEEP=30 npm run backup
// Also schedule from cron/systemd-Timer or Windows Task Scheduler, or run the
// bundled backup-loop (docker-compose `backup` service does this).
//
// The local SQLite file is the ONLY copy of all users/trips, so back it up.

const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
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

function hmac(key, str) {
  return crypto.createHmac('sha256', key).update(str).digest();
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// Minimal AWS SigV4 signed PUT against any S3-compatible endpoint (no SDK, no
// extra deps). Bucket + object path style: <endpoint>/<bucket>/<prefix>/<file>.
function uploadToS3(filePath) {
  const endpoint = process.env.BACKUP_S3_ENDPOINT;
  const bucket = process.env.BACKUP_S3_BUCKET;
  const accessKey = process.env.BACKUP_S3_KEY;
  const secretKey = process.env.BACKUP_S3_SECRET;
  if (!endpoint || !bucket || !accessKey || !secretKey) {
    console.log('[backup] BACKUP_S3_* not configured — skipping off-site upload');
    return Promise.resolve(false);
  }

  const region = process.env.BACKUP_S3_REGION || 'us-east-1';
  const prefix = process.env.BACKUP_S3_PREFIX || 'drivelocal';
  const objectKey = `${prefix}/${path.basename(filePath)}`;
  const body = fs.readFileSync(filePath);

  const host = new URL(endpoint).host;
  const nowDate = new Date();
  const amzDate = nowDate.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const canonicalUri = `/${bucket}/${objectKey}`;
  const payloadHash = sha256(body);
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;

  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return new Promise((resolve, reject) => {
    const req = https.request(new URL(`${endpoint}${canonicalUri}`), {
      method: 'PUT',
      headers: {
        Authorization: authorization,
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'Content-Length': body.length,
        'Content-Type': 'application/octet-stream',
      },
    }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[backup] off-site copy uploaded: s3://${bucket}/${objectKey}`);
          resolve(true);
        } else {
          reject(new Error(`S3 upload failed: HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const src = new Database(dbFile, { readonly: true });

src.backup(destFile)
  .then(async () => {
    src.close();

    const backups = fs.readdirSync(backupsDir).filter((f) => f.endsWith('.sqlite')).sort();
    while (backups.length > KEEP) {
      fs.unlinkSync(path.join(backupsDir, backups.shift()));
    }
    console.log(`Backup written: ${destFile}`);
    console.log(`Retaining ${KEEP} backups in ${backupsDir}`);

    try {
      await uploadToS3(destFile);
    } catch (err) {
      console.error(err.message);
      process.exitCode = 1;
    }
  })
  .catch((err) => {
    console.error('Backup failed:', err.message);
    src.close();
    process.exit(1);
  });