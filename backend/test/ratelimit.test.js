const { test } = require('node:test');
const assert = require('node:assert/strict');

// PIN login must be throttled identically in every environment — brute-force
// protection is a security control, not an abuse control, so unlike the old OTP
// caps it is never relaxed for dev/test. Reloading with a purged cache keeps
// each environment's buckets and limits isolated.
function loadRateLimit(nodeEnv) {
  const prev = process.env.NODE_ENV;
  const prevLat = process.env.SERVICE_AREA_LAT;
  const prevLng = process.env.SERVICE_AREA_LNG;
  process.env.NODE_ENV = nodeEnv;
  if (nodeEnv === 'production') {
    // Satisfy the remaining production gates (JWT/DRIVER_PHONE/area) so config
    // loads; rate limiting is what these tests exercise.
    process.env.SERVICE_AREA_LAT = '-26.2155';
    process.env.SERVICE_AREA_LNG = '29.2916';
  }
  const path = require.resolve('../src/services/rateLimit');
  delete require.cache[path];
  delete require.cache[require.resolve('../src/config')];
  const mod = require('../src/services/rateLimit');
  process.env.NODE_ENV = prev;
  if (prevLat === undefined) delete process.env.SERVICE_AREA_LAT; else process.env.SERVICE_AREA_LAT = prevLat;
  if (prevLng === undefined) delete process.env.SERVICE_AREA_LNG; else process.env.SERVICE_AREA_LNG = prevLng;
  return mod;
}

test('PIN failures are capped per phone per window in every environment', () => {
  for (const env of ['production', 'test']) {
    const { checkPinLimit, recordPinFailure, limits } = loadRateLimit(env);
    assert.equal(limits.pinPerWindow, 5, `${env} pin cap`);
    const phone = `+2782000${env === 'production' ? '1' : '2'}`;
    for (let i = 0; i < 5; i += 1) {
      assert.equal(checkPinLimit(phone).ok, true, `${env} attempt ${i + 1}`);
      recordPinFailure(phone);
    }
    const blocked = checkPinLimit(phone);
    assert.equal(blocked.ok, false, `${env} attempt 6 must be blocked`);
    assert.ok(blocked.retryAfterSec > 0);
  }
});

test('successful logins are not throttled (only failures count)', () => {
  const { checkPinLimit, recordPinFailure } = loadRateLimit('production');
  const phone = '+27820000009';
  for (let i = 0; i < 20; i += 1) {
    assert.equal(checkPinLimit(phone).ok, true, `attempt ${i + 1}`);
    // A correct PIN never calls recordPinFailure, so the limit never trips.
  }
  assert.equal(checkPinLimit(phone).ok, true);
  // One failure is still well under the cap.
  recordPinFailure(phone);
  assert.equal(checkPinLimit(phone).ok, true);
});

test('the phone cap does not throttle different phones', () => {
  const { checkPinLimit } = loadRateLimit('production');
  assert.equal(checkPinLimit('+27820000002').ok, true);
  assert.equal(checkPinLimit('+27820000003').ok, true);
});

test('PIN failures are capped per IP, with a Retry-After hint', () => {
  const { checkPinIpLimit, recordPinIpFailure, limits } = loadRateLimit('production');
  const ip = '41.203.10.7';
  for (let i = 0; i < limits.pinPerIp; i += 1) {
    assert.equal(checkPinIpLimit(ip).ok, true, `attempt ${i + 1} from the IP`);
    recordPinIpFailure(ip);
  }
  const blocked = checkPinIpLimit(ip);
  assert.equal(blocked.ok, false, 'the next attempt in the window is blocked');
  assert.ok(blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 60,
    `retryAfterSec must be a sane seconds value, got ${blocked.retryAfterSec}`);
});

test('the per-IP cap does not leak across IPs, and empty IPs are never throttled', () => {
  const { checkPinIpLimit, recordPinIpFailure, limits } = loadRateLimit('production');
  const ip = '105.184.0.9';
  for (let i = 0; i < limits.pinPerIp; i += 1) recordPinIpFailure(ip);
  assert.equal(checkPinIpLimit(ip).ok, false, 'the noisy IP is blocked');
  assert.equal(checkPinIpLimit('105.184.0.10').ok, true, 'a different IP is unaffected');
  assert.equal(checkPinIpLimit('').ok, true, 'no IP (e.g. a broken peer address) never blocks login');
  assert.equal(checkPinIpLimit(null).ok, true);
});
