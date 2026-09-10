// Small in-memory rate limiter for OTP requests and verify attempts.
// - Per phone: max MAX_PER_WINDOW requests in WINDOW_MS (prevents SMS-bombing).
// - Per phone per day: max MAX_PER_DAY (caps the real cost of Twilio messages).
// - Verify: max MAX_VERIFY_PER_WINDOW attempts per phone per WINDOW_MS.

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 3;
const MAX_PER_DAY = 10;
const MAX_VERIFY_PER_WINDOW = 5;

const buckets = new Map();
const verifyBuckets = new Map();

function prune() {
  if (buckets.size <= 5000) return;
  const today = new Date().toISOString().slice(0, 10);
  for (const [key, rec] of buckets) {
    if (rec.day !== today) buckets.delete(key);
  }
}

function checkOtpLimit(phone) {
  const nowMs = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  let rec = buckets.get(phone);
  if (!rec || rec.day !== today) {
    rec = { day: today, timestamps: [] };
    buckets.set(phone, rec);
  }

  if (rec.timestamps.length >= MAX_PER_DAY) {
    return { ok: false, code: 'DAILY_LIMIT', retryAfterSec: 60 };
  }

  rec.timestamps = rec.timestamps.filter((t) => nowMs - t < WINDOW_MS);
  if (rec.timestamps.length >= MAX_PER_WINDOW) {
    const oldest = rec.timestamps[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - nowMs) / 1000));
    return { ok: false, code: 'TOO_FREQUENT', retryAfterSec };
  }

  rec.timestamps.push(nowMs);
  prune();
  return { ok: true };
}

function checkVerifyLimit(phone) {
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

module.exports = { checkOtpLimit, checkVerifyLimit };