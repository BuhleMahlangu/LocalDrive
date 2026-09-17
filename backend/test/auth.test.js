// Auth flow tests. Each test file runs in its own process (node --test), so we
// can safely swap the DB for an in-memory sqlite before anything loads.

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const repo = require('../src/db/repository');
const authService = require('../src/services/auth');

// Keep test output clean: never actually send an SMS.
const sms = require('../src/services/sms');
sms.send = async () => ({ dev: true });

test('normalizePhone converts local SA formats to E.164', () => {
  assert.equal(authService.normalizePhone('0000000000'), '+27000000000');
  assert.equal(authService.normalizePhone('+27 00 000 0000'), '+27000000000');
  assert.equal(authService.normalizePhone('000 000 0000'), '+27000000000');
});

test('requestOtp stores a code that verifyOtp accepts (customer)', async () => {
  const phone = '+27820000001';
  await authService.requestOtp({ phone, role: 'customer' });

  const row = repo.getOtp(phone);
  assert.ok(row, 'OTP row should exist');
  assert.match(String(row.code), /^[0-9a-f]{64}$/, 'stored OTP is a SHA-256 hash, not plaintext');

  const result = await authService.verifyOtp({ phone, code: '123456', role: 'customer' });
  assert.equal(result.success, true);
  assert.equal(result.user.role, 'customer');
  assert.equal(result.user.phone, phone);
});

test('verifyOtp rejects a wrong code and counts an attempt', async () => {
  const phone = '+27820000004';
  await authService.requestOtp({ phone, role: 'customer' });

  const bad = await authService.verifyOtp({ phone, code: '000000', role: 'customer' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /Incorrect code/);

  const row = repo.getOtp(phone);
  assert.equal(row.attempts, 1);
});

test('verifyOtp rejects an expired code', async () => {
  const phone = '+27820000005';
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  repo.saveOtp(phone, authService.hashOtp(phone, '123456'), past);

  const result = await authService.verifyOtp({ phone, code: '123456', role: 'customer' });
  assert.equal(result.success, false);
  assert.match(result.error, /expired/i);
});

test('verifyOtp rejects a second use of the same code', async () => {
  const phone = '+27820000006';
  await authService.requestOtp({ phone, role: 'customer' });

  assert.equal((await authService.verifyOtp({ phone, code: '123456', role: 'customer' })).success, true);
  const again = await authService.verifyOtp({ phone, code: '123456', role: 'customer' });
  assert.equal(again.success, false);
  assert.match(again.error, /No code requested/);
});

test('strangers may register as a driver but stay pending until approved', async () => {
  const stranger = '+27820000002';
  await authService.requestOtp({ phone: stranger, role: 'driver' });

  const result = await authService.verifyOtp({ phone: stranger, code: '123456', role: 'driver' });
  assert.equal(result.success, true);
  assert.equal(result.user.role, 'driver');
  assert.equal(result.user.driverStatus, 'pending', 'new driver applications start pending');

  // A pending driver cannot use operational driver routes.
  assert.equal(repo.listDriversForAdmin().length >= 1, true);
});

test('the owner phone creates the admin (owner) account on first login', async () => {
  assert.ok(config.driverPhone.length >= 10);
  const owner = config.driverPhone;
  await authService.requestOtp({ phone: owner, role: 'driver' });

  const result = await authService.verifyOtp({ phone: owner, code: '123456', role: 'driver' });
  assert.equal(result.success, true);
  assert.equal(result.user.role, 'admin');
  assert.equal(result.user.driverStatus, 'approved');
  assert.equal(result.user.phone, owner);
});

test('an existing customer becomes a pending driver applicant by choosing driver', async () => {
  const phone = '+27820000003';
  await authService.requestOtp({ phone, role: 'customer' });
  await authService.verifyOtp({ phone, code: '123456', role: 'customer' });

  await authService.requestOtp({ phone, role: 'driver' });
  const result = await authService.verifyOtp({ phone, code: '123456', role: 'driver' });
  assert.equal(result.success, true);
  assert.equal(result.user.role, 'driver', 'customer converts to a driver applicant');
  assert.equal(result.user.driverStatus, 'pending');
});

test('verifyOtp rejects an invalid phone format at request time', async () => {
  await assert.rejects(
    () => authService.requestOtp({ phone: 'not-a-phone', role: 'customer' }),
    (e) => e.status === 400,
  );
});