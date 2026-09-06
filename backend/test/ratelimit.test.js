const { test } = require('node:test');
const assert = require('node:assert/strict');

const { checkOtpLimit } = require('../src/services/rateLimit');

test('allows up to 3 requests per phone per 60s window', () => {
  for (let i = 0; i < 3; i += 1) {
    assert.equal(checkOtpLimit('+27820000001').ok, true, `request ${i + 1} should pass`);
  }
  const blocked = checkOtpLimit('+27820000001');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'TOO_FREQUENT');
  assert.ok(blocked.retryAfterSec > 0);
});

test('does not throttle different phones', () => {
  assert.equal(checkOtpLimit('+27820000002').ok, true);
  assert.equal(checkOtpLimit('+27820000003').ok, true);
});