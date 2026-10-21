// PIN hashing for phone + PIN login. PINs are 6 digits and have a small
// keyspace, so the hash must be slow to resist offline brute force if the
// database leaks: we use scrypt with a per-user random salt. Online guessing is
// additionally throttled in services/rateLimit.js (a PIN alone is not enough).
const crypto = require('crypto');

const KEYLEN = 32;
// scrypt cost parameters. N=16384 keeps hashing ~tens of ms on a small VM —
// slow enough to make an offline 10^6 candidate sweep expensive, fast enough
// for a login round-trip.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(pin), salt, KEYLEN, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPin(pin, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  const derived = crypto.scryptSync(String(pin), salt, expected.length, SCRYPT);
  // Constant-time compare so a timing side-channel can't reveal how much of the
  // PIN matched.
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

module.exports = { hashPin, verifyPin };
