// Auth flow tests. Each test file runs in its own process (node --test), so we
// can safely swap the DB for an in-memory sqlite before anything loads.

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const repo = require('../src/db/repository');
const authService = require('../src/services/auth');
const { hashPin, verifyPin } = require('../src/services/pin');

test('normalizePhone converts local SA formats to E.164', () => {
  assert.equal(authService.normalizePhone('0000000000'), '+27000000000');
  assert.equal(authService.normalizePhone('+27 00 000 0000'), '+27000000000');
  assert.equal(authService.normalizePhone('000 000 0000'), '+27000000000');
});

test('hashPin produces a salted scrypt hash that verifies, and rejects wrong PINs', () => {
  const h = hashPin('123456');
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/, 'salt + derived key, never plaintext');
  assert.equal(verifyPin('123456', h), true);
  assert.equal(verifyPin('654321', h), false);
  // A different salt means the same PIN hashes differently (no rainbow table).
  assert.notEqual(hashPin('123456'), h);
});

test('a new phone sets a PIN on first login and signs in as a customer', () => {
  const phone = '+27820000001';
  const status = authService.getAccountStatus({ phone });
  assert.deepEqual(status, { phone, exists: false, hasPin: false });

  const result = authService.setupPin({ phone, pin: '111111', role: 'customer' });
  assert.equal(result.success, true);
  assert.equal(result.user.role, 'customer');
  assert.equal(result.user.phone, phone);
  // The PIN is stored as a hash, never in plaintext, and never in the API shape.
  assert.ok(repo.getPinHash(phone));
  assert.ok(!JSON.stringify(result.user).includes('111111'));
  assert.equal(result.user.pinHash, undefined);
});

test('loginWithPin accepts the right PIN and rejects a wrong one', () => {
  const phone = '+27820000004';
  authService.setupPin({ phone, pin: '246810', role: 'customer' });

  const ok = authService.loginWithPin({ phone, pin: '246810', role: 'customer' });
  assert.equal(ok.success, true);
  assert.ok(ok.token);

  const bad = authService.loginWithPin({ phone, pin: '000000', role: 'customer' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /Incorrect phone number or PIN/);
});

test('login never reveals whether a phone exists (same error either way)', () => {
  const unknown = authService.loginWithPin({ phone: '+27825559999', pin: '123456', role: 'customer' });
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /Incorrect phone number or PIN/);
});

test('setupPin refuses to overwrite an existing PIN', () => {
  const phone = '+27820000007';
  authService.setupPin({ phone, pin: '112233', role: 'customer' });

  const second = authService.setupPin({ phone, pin: '999999', role: 'customer' });
  assert.equal(second.success, false);
  assert.match(second.error, /already has a PIN/);
  // The original PIN still works; the overwrite attempt changed nothing.
  assert.equal(authService.loginWithPin({ phone, pin: '112233', role: 'customer' }).success, true);
});

test('PIN must be exactly 6 digits', () => {
  assert.throws(() => authService.setupPin({ phone: '+27820000008', pin: '123', role: 'customer' }), (e) => e.status === 400);
  assert.throws(() => authService.setupPin({ phone: '+27820000008', pin: 'abcd12', role: 'customer' }), (e) => e.status === 400);
});

test('strangers may register as a driver but stay pending until approved', () => {
  const stranger = '+27820000002';
  const result = authService.setupPin({ phone: stranger, pin: '313131', role: 'driver' });
  assert.equal(result.success, true);
  assert.equal(result.user.role, 'driver');
  assert.equal(result.user.driverStatus, 'pending', 'new driver applications start pending');
  assert.equal(repo.listDriversForAdmin().length >= 1, true);
});

test('the owner phone creates the admin (owner) account on first login', () => {
  assert.ok(config.driverPhone.length >= 10);
  const owner = config.driverPhone;
  const result = authService.setupPin({ phone: owner, pin: '424242', role: 'driver' });
  assert.equal(result.success, true);
  assert.equal(result.user.role, 'admin');
  assert.equal(result.user.driverStatus, 'approved');
  assert.equal(result.user.phone, owner);
});

test('an existing customer becomes a pending driver applicant by choosing driver', () => {
  const phone = '+27820000003';
  authService.setupPin({ phone, pin: '515151', role: 'customer' });

  const result = authService.loginWithPin({ phone, pin: '515151', role: 'driver' });
  assert.equal(result.success, true);
  assert.equal(result.user.role, 'driver', 'customer converts to a driver applicant');
  assert.equal(result.user.driverStatus, 'pending');
});

test('changePin requires the current PIN and then accepts the new one', () => {
  const user = authService.setupPin({ phone: '+27820000009', pin: '616161', role: 'customer' }).user;

  const wrong = authService.changePin({ userId: user.id, currentPin: '000000', newPin: '717171' });
  assert.equal(wrong.success, false);
  assert.match(wrong.error, /Current PIN is incorrect/);
  assert.equal(authService.loginWithPin({ phone: '+27820000009', pin: '616161', role: 'customer' }).success, true);

  const ok = authService.changePin({ userId: user.id, currentPin: '616161', newPin: '717171' });
  assert.equal(ok.success, true);
  assert.equal(authService.loginWithPin({ phone: '+27820000009', pin: '717171', role: 'customer' }).success, true);
  assert.equal(authService.loginWithPin({ phone: '+27820000009', pin: '616161', role: 'customer' }).success, false);
});

test('PIN attempts are throttled per phone (429-style lockout)', () => {
  const phone = '+27820000011';
  authService.setupPin({ phone, pin: '818181', role: 'customer' });

  // Six wrong attempts in a row: the 6th trips the per-window cap (5).
  let locked = null;
  for (let i = 0; i < 6; i++) {
    const r = authService.loginWithPin({ phone, pin: '000000', role: 'customer' });
    if (r.retryAfterSec) locked = r;
  }
  assert.ok(locked, 'attempts are rate limited');
  assert.match(locked.error, /Too many attempts/);
});

test('setupPin rejects an invalid phone format', () => {
  assert.throws(() => authService.setupPin({ phone: 'not-a-phone', pin: '123456', role: 'customer' }), (e) => e.status === 400);
});
