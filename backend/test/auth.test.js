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
  assert.match(String(row.code), /^\d{6}$/);

  const result = authService.verifyOtp({ phone, code: row.code, role: 'customer' });
  assert.equal(result.success, true);
  assert.equal(result.user.role, 'customer');
  assert.equal(result.user.phone, phone);
});

test('verifyOtp rejects a wrong code and counts an attempt', async () => {
  const phone = '+27820000004';
  await authService.requestOtp({ phone, role: 'customer' });

  const bad = authService.verifyOtp({ phone, code: '000000', role: 'customer' });
  assert.equal(bad.success, false);
  assert.match(bad.error, /Incorrect code/);

  const row = repo.getOtp(phone);
  assert.equal(row.attempts, 1);
});

test('verifyOtp rejects an expired code', async () => {
  const phone = '+27820000005';
  const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  repo.saveOtp(phone, '123456', past);

  const result = authService.verifyOtp({ phone, code: '123456', role: 'customer' });
  assert.equal(result.success, false);
  assert.match(result.error, /expired/i);
});

test('verifyOtp rejects a second use of the same code', async () => {
  const phone = '+27820000006';
  await authService.requestOtp({ phone, role: 'customer' });
  const { code } = repo.getOtp(phone);

  assert.equal(authService.verifyOtp({ phone, code, role: 'customer' }).success, true);
  const again = authService.verifyOtp({ phone, code, role: 'customer' });
  assert.equal(again.success, false);
  assert.match(again.error, /No code requested/);
});

test('strangers cannot register as the driver', async () => {
  const stranger = '+27820000002';
  await authService.requestOtp({ phone: stranger, role: 'driver' });

  const result = authService.verifyOtp({ phone: stranger, code: repo.getOtp(stranger).code, role: 'driver' });
  assert.equal(result.success, false);
  assert.match(result.error, /not the registered driver/i);

  // No user account should have been created for them.
  assert.equal(repo.getUserByPhone(stranger, undefined), null);
});

test('the owner phone may create a driver account on first login', async () => {
  assert.ok(config.driverPhone.length >= 10);
  const owner = config.driverPhone;
  await authService.requestOtp({ phone: owner, role: 'driver' });

  const result = authService.verifyOtp({ phone: owner, code: repo.getOtp(owner).code, role: 'driver' });
  assert.equal(result.success, true);
  assert.equal(result.user.role, 'driver');
  assert.equal(result.user.phone, owner);
});

test('an existing customer is not promoted to driver by choosing driver', async () => {
  const phone = '+27820000003';
  await authService.requestOtp({ phone, role: 'customer' });
  authService.verifyOtp({ phone, code: repo.getOtp(phone).code, role: 'customer' });

  await authService.requestOtp({ phone, role: 'driver' });
  const result = authService.verifyOtp({ phone, code: repo.getOtp(phone).code, role: 'driver' });
  assert.equal(result.success, true);
  assert.equal(result.user.role, 'customer', 'role must stay customer');
});

test('verifyOtp rejects an invalid phone format at request time', async () => {
  await assert.rejects(
    () => authService.requestOtp({ phone: 'not-a-phone', role: 'customer' }),
    (e) => e.status === 400,
  );
});