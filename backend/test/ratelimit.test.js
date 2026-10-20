const { test } = require('node:test');
const assert = require('node:assert/strict');

// The OTP *request* caps are relaxed outside production (no real SMS is sent
// there), so the 3-per-minute production limit must be asserted against an
// explicitly production-configured module. Reloading with a purged cache keeps
// each environment's buckets and limits isolated. ALLOW_FIXED_OTP is set
// because these tests exercise rate limiting, not OTP delivery — production
// config otherwise refuses to start without an SMS/SMTP delivery path.
function loadRateLimit(nodeEnv) {
  const prev = process.env.NODE_ENV;
  const prevFixed = process.env.ALLOW_FIXED_OTP;
  process.env.NODE_ENV = nodeEnv;
  if (nodeEnv === 'production') process.env.ALLOW_FIXED_OTP = 'true';
  const path = require.resolve('../src/services/rateLimit');
  delete require.cache[path];
  delete require.cache[require.resolve('../src/config')];
  const mod = require('../src/services/rateLimit');
  process.env.NODE_ENV = prev;
  if (prevFixed === undefined) delete process.env.ALLOW_FIXED_OTP;
  else process.env.ALLOW_FIXED_OTP = prevFixed;
  return mod;
}

test('production allows up to 3 requests per phone per 60s window', () => {
  const { checkOtpLimit } = loadRateLimit('production');
  for (let i = 0; i < 3; i += 1) {
    assert.equal(checkOtpLimit('+27820000001').ok, true, `request ${i + 1} should pass`);
  }
  const blocked = checkOtpLimit('+27820000001');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'TOO_FREQUENT');
  assert.ok(blocked.retryAfterSec > 0);
});

test('production enforces the daily cap', () => {
  const { limits } = loadRateLimit('production');
  assert.equal(limits.otpPerDay, 10);
  assert.equal(limits.otpPerWindow, 3);
});

test('does not throttle different phones', () => {
  const { checkOtpLimit } = loadRateLimit('production');
  assert.equal(checkOtpLimit('+27820000002').ok, true);
  assert.equal(checkOtpLimit('+27820000003').ok, true);
});

test('verify attempts stay capped in every environment', () => {
  for (const env of ['production', 'test']) {
    const { checkVerifyLimit, limits } = loadRateLimit(env);
    assert.equal(limits.verifyPerWindow, 5, `${env} verify cap`);
    const phone = `+2783000${env === 'production' ? '1' : '2'}`;
    for (let i = 0; i < 5; i += 1) {
      assert.equal(checkVerifyLimit(phone).ok, true, `${env} attempt ${i + 1}`);
    }
    assert.equal(checkVerifyLimit(phone).ok, false, `${env} attempt 6 must be blocked`);
  }
});

test('outside production the request cap is relaxed so e2e logins do not throttle', () => {
  const { checkOtpLimit, limits } = loadRateLimit('test');
  assert.ok(limits.otpPerWindow > 3);
  for (let i = 0; i < 10; i += 1) {
    assert.equal(checkOtpLimit('+27840000001').ok, true, `dev request ${i + 1}`);
  }
});

test('production caps OTP requests per IP, with a Retry-After hint', () => {
  const { checkOtpIpLimit } = loadRateLimit('production');
  const ip = '41.203.10.7';
  for (let i = 0; i < 12; i += 1) {
    assert.equal(checkOtpIpLimit(ip).ok, true, `request ${i + 1} from the IP`);
  }
  const blocked = checkOtpIpLimit(ip);
  assert.equal(blocked.ok, false, 'the 13th request in the window is blocked');
  assert.equal(blocked.code, 'IP_TOO_FREQUENT');
  assert.ok(blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 60,
    `retryAfterSec must be a sane seconds value, got ${blocked.retryAfterSec}`);
});

test('the per-IP cap does not leak across IPs, and empty IPs are never throttled', () => {
  const { checkOtpIpLimit } = loadRateLimit('production');
  const ip = '105.184.0.9';
  for (let i = 0; i < 13; i += 1) checkOtpIpLimit(ip);
  assert.equal(checkOtpIpLimit(ip).ok, false, 'the noisy IP is blocked');
  assert.equal(checkOtpIpLimit('105.184.0.10').ok, true, 'a different IP is unaffected');
  assert.equal(checkOtpIpLimit('').ok, true, 'no IP (e.g. a broken peer address) never blocks OTP delivery');
  assert.equal(checkOtpIpLimit(null).ok, true);
});

test('outside production the per-IP cap is off so dev/e2e logins never throttle', () => {
  const { checkOtpIpLimit } = loadRateLimit('test');
  for (let i = 0; i < 50; i += 1) {
    assert.equal(checkOtpIpLimit('127.0.0.1').ok, true, `dev request ${i + 1}`);
  }
});
