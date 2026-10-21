// Small in-memory rate limiter for PIN login/sign-up.
//
// A 6-digit PIN has only 10^6 combinations, so throttling is a security control,
// not just an abuse control: checkPinLimit() caps attempts per phone per window
// and is deliberately NOT relaxed in dev/test (login brute-force protection must
// behave the same everywhere). checkPinIpLimit() caps attempts per client IP so
// one device can't spray many phone numbers.

const persist = process.env.RATE_LIMIT_PERSIST === 'true';
let repo = null;
if (persist) repo = require('../db/repository');

const WINDOW_MS = 60 * 1000;
// Attempts per phone per window before a 429. Five wrong PINs costs 10^6 / 5
// guesses per minute at worst across many IPs — impractical, and the per-IP cap
// below closes the distributed case.
const MAX_PIN_PER_WINDOW = 5;
const MAX_PIN_PER_IP = 20;

const pinBuckets = new Map();
const ipBuckets = new Map();

// ---------- Optional DB-backed persistence (shared across processes/restarts) ----------
function dbCheck(key, max, ttlMs) {
  if (!repo) return { ok: true };
  const now = Date.now();
  const row = repo.db.prepare('SELECT count, reset_at FROM rate_limit_counters WHERE key = ?').get(key);
  if (!row || row.reset_at <= now) {
    repo.db.prepare(
      'INSERT INTO rate_limit_counters (key, count, reset_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET count = 1, reset_at = excluded.reset_at',
    ).run(key, 1, now + ttlMs);
    return { ok: true, retryAfterSec: 0 };
  }
  if (row.count >= max) {
    const retryAfterSec = Math.max(1, Math.ceil((row.reset_at - now) / 1000));
    return { ok: false, retryAfterSec };
  }
  repo.db.prepare('UPDATE rate_limit_counters SET count = count + 1 WHERE key = ?').run(key);
  return { ok: true, retryAfterSec: 0 };
}

function checkPinLimit(phone) {
  if (persist) {
    const res = dbCheck(`pin:win:${phone}`, MAX_PIN_PER_WINDOW, WINDOW_MS);
    return res.ok ? { ok: true } : { ok: false, retryAfterSec: res.retryAfterSec };
  }
  const nowMs = Date.now();
  let rec = pinBuckets.get(phone);
  if (!rec) {
    rec = { timestamps: [] };
    pinBuckets.set(phone, rec);
  }
  rec.timestamps = rec.timestamps.filter((t) => nowMs - t < WINDOW_MS);
  if (rec.timestamps.length >= MAX_PIN_PER_WINDOW) {
    const oldest = rec.timestamps[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - nowMs) / 1000));
    return { ok: false, retryAfterSec };
  }
  return { ok: true };
}

// Record a failed PIN attempt (only failures count against the limit, so a user
// whose PIN is correct is never throttled by their own successful logins).
function recordPinFailure(phone) {
  if (persist) {
    dbCheck(`pin:win:${phone}`, MAX_PIN_PER_WINDOW, WINDOW_MS);
    return;
  }
  const nowMs = Date.now();
  let rec = pinBuckets.get(phone);
  if (!rec) {
    rec = { timestamps: [] };
    pinBuckets.set(phone, rec);
  }
  rec.timestamps = rec.timestamps.filter((t) => nowMs - t < WINDOW_MS);
  rec.timestamps.push(nowMs);
}

// IPv6 / behind a proxy "IP" strings are fine as opaque keys.
function checkPinIpLimit(ip) {
  if (!ip) return { ok: true };
  if (persist) {
    const res = dbCheck(`pin:ip:${ip}`, MAX_PIN_PER_IP, WINDOW_MS);
    return res.ok ? { ok: true } : { ok: false, retryAfterSec: res.retryAfterSec };
  }
  const nowMs = Date.now();
  let rec = ipBuckets.get(ip);
  if (!rec) {
    rec = { timestamps: [] };
    ipBuckets.set(ip, rec);
  }
  rec.timestamps = rec.timestamps.filter((t) => nowMs - t < WINDOW_MS);
  if (rec.timestamps.length >= MAX_PIN_PER_IP) {
    const oldest = rec.timestamps[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - nowMs) / 1000));
    return { ok: false, retryAfterSec };
  }
  return { ok: true };
}

// Record a failed attempt against a client IP (same rationale as the phone cap:
// only failures count, so a busy but legitimate user is never locked out).
function recordPinIpFailure(ip) {
  if (!ip) return;
  if (persist) {
    dbCheck(`pin:ip:${ip}`, MAX_PIN_PER_IP, WINDOW_MS);
    return;
  }
  const nowMs = Date.now();
  let rec = ipBuckets.get(ip);
  if (!rec) {
    rec = { timestamps: [] };
    ipBuckets.set(ip, rec);
  }
  rec.timestamps = rec.timestamps.filter((t) => nowMs - t < WINDOW_MS);
  rec.timestamps.push(nowMs);
}

module.exports = {
  checkPinLimit,
  recordPinFailure,
  checkPinIpLimit,
  recordPinIpFailure,
  limits: { pinPerWindow: MAX_PIN_PER_WINDOW, pinPerIp: MAX_PIN_PER_IP },
};
