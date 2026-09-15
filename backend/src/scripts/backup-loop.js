// Scheduled backup loop for the docker `backup` service (and any long-running
// container that has the app image). Runs a first backup on boot, then every
// BACKUP_INTERVAL_HOURS (default 6). Skips overlapping runs.
//
// Off-site copy: set BACKUP_S3_ENDPOINT/BUCKET/KEY/SECRET (see backup.js).

const { spawnSync } = require('child_process');
const path = require('path');

const backupScript = path.join(__dirname, 'backup.js');
const hours = parseFloat(process.env.BACKUP_INTERVAL_HOURS || '6');
const intervalMs = Math.max(1, hours) * 3600 * 1000;

let running = false;

function run() {
  if (running) return;
  running = true;
  console.log(`[backup] starting (${new Date().toISOString()})`);
  const res = spawnSync(process.execPath, [backupScript], { stdio: 'inherit' });
  running = false;
  if (res.status !== 0) {
    console.error(`[backup] run failed (exit ${res.status}) — will retry next interval`);
  }
}

run();
setInterval(run, intervalMs);

// Prevent the container exiting early; graceful stop will end the interval.
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
console.log(`[backup] loop active — every ${hours}h (BACKUP_INTERVAL_HOURS=${hours}, intervalMs=${intervalMs})`);