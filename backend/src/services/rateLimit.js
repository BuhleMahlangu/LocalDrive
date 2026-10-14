// Small in-memory rate limiter for OTP requests and verify attempts.
// - Per phone: max MAX_PER_WINDOW requests in WINDOW_MS (prevents SMS-bombing).
// - Per phone per day: max MAX_PER_DAY (caps the real cost of OTP SMS messages).
// - Verify: max MAX_VERIFY_PER_WINDOW attempts per phone per WINDOW_MS.

const config = require('../config');

const persist = process.env.RATE_LIMIT_PERSIST === 'true';
let repo = null;
if (persist) repo = require('../db/repository');

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 3;
const MAX_PER_DAY = 10;
const MAX_VERIFY_PER_WINDOW = 5;

// The *request* caps exist for real SMS delivery (cost + bombing; see the
// TODO in services/sms.js) and they are the ones that break legitimate
// local/CI activity: the e2e suite signs the same owner phone in from several
// specs inside one window. Relax them in dev/test only. The verify cap is
// deliberately left alone so login brute-force protection is identical in
// every environment.
const isProd = config.nodeEnv === 'production';
const OTP_MAX_PER_WINDOW = isProd ? MAX_PER_WINDOW : 1000;
const OTP_MAX_PER_DAY = isProd ? MAX_PER_DAY : 10000;

const buckets = new Map();
const verifyBuckets = new Map();
const ipBuckets = new Map();

function prune() {
  if (buckets.size <= 5000) return;
  const today = new Date().toISOString().slice(0, 10);
  for (const [key, rec] of buckets) {
    if (rec.day !== today) buckets.delete(key);
  }
}

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

function dbCheckOtp(phone) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const midnight = new Date(now);
  midnight.setUTCDate(midnight.getUTCDate() + 1);
  midnight.setUTCHours(0, 0, 0, 0);
  const dailyTtlMs = Math.max(1, midnight.getTime() - now.getTime());
  const dayRes = dbCheck(`otp:daily:${phone}:${today}`, OTP_MAX_PER_DAY, dailyTtlMs);
  if (!dayRes.ok) return { ok: false, code: 'DAILY_LIMIT', retryAfterSec: 60 };
  const winRes = dbCheck(`otp:win:${phone}`, OTP_MAX_PER_WINDOW, WINDOW_MS);
  if (!winRes.ok) return { ok: false, code: 'TOO_FREQUENT', retryAfterSec: winRes.retryAfterSec };
  return { ok: true };
}

// IPv6 / behind a proxy "IP" strings are fine as opaque keys.
function checkOtpIpLimit(ip) {
  if (!ip || isProd === false) return { ok: true };
  if (persist) {
    const res = dbCheck(`ip:win:${ip}`, 12, WINDOW_MS);
    if (!res.ok) return { ok: false, code: 'IP_TOO_FREQUENT', retryAfterSec: res.retryAfterSec };
    return { ok: true };
  }
  const nowMs = Date.now();
  let rec = ipBuckets.get(ip);
  if (!rec || !rec.timestamps || rec.timestamps.length === 0 || nowMs - rec.timestamps[rec.timestamps.length - 1] > 60 * 60 * 1000) {
    rec = { timestamps: [] };
    ipBuckets.set(ip, rec);
  }
  rec.timestamps = rec.timestamps.filter((t) => nowMs - t < WINDOW_MS);
  if (rec.timestamps.length >= 12) {
    const oldest = rec.timestamps[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - nowMs) / 1000));
    return { ok: false, code: 'IP_TOO_FREQUENT', retryAfterSec };
  }
  rec.timestamps.push(nowMs);
  return { ok: true };
}

function checkOtpLimit(phone) {
  if (persist) return dbCheckOtp(phone);
  const nowMs = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  let rec = buckets.get(phone);
  if (!rec || rec.day !== today) {
    rec = { day: today, timestamps: [] };
    buckets.set(phone, rec);
  }

  if (rec.timestamps.length >= OTP_MAX_PER_DAY) {
    return { ok: false, code: 'DAILY_LIMIT', retryAfterSec: 60 };
  }

  rec.timestamps = rec.timestamps.filter((t) => nowMs - t < WINDOW_MS);
  if (rec.timestamps.length >= OTP_MAX_PER_WINDOW) {
    const oldest = rec.timestamps[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - nowMs) / 1000));
    return { ok: false, code: 'TOO_FREQUENT', retryAfterSec };
  }

  rec.timestamps.push(nowMs);
  prune();
  return { ok: true };
}

function checkVerifyLimit(phone) {
  if (persist) {
    const res = dbCheck(`verify:win:${phone}`, MAX_VERIFY_PER_WINDOW, WINDOW_MS);
    if (!res.ok) return { ok: false, retryAfterSec: res.retryAfterSec };
    return { ok: true };
  }
  const nowMs = Date.now();
  let rec = verifyBuckets.get(phone);
  if (!rec) {
    rec = { timestamps: [] };
    verifyBuckets.set(phone, rec);
  }
  rec.timestamps = rec.timestamps.filter((t) => nowMs - t < WINDOW_MS);
  if (rec.timestamps.length >= MAX_VERIFY_PER_WINDOW) {
    const oldest = rec.timestamps[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - nowMs) / 1000));
    return { ok: false, retryAfterSec };
  }
  rec.timestamps.push(nowMs);
  return { ok: true };
}

module.exports = { checkOtpLimit, checkVerifyLimit, checkOtpIpLimit, limits: { otpPerWindow: OTP_MAX_PER_WINDOW, otpPerDay: OTP_MAX_PER_DAY, verifyPerWindow: MAX_VERIFY_PER_WINDOW } };