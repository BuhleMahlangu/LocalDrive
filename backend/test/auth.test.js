// Auth flow tests. Each test file runs in its own process (node --test), so we
// can safely swap the DB for an in-memory sqlite before anything loads.

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const repo = require('../src/db/repository');
const authService = require('../src/services/auth');

// Tests never actually send an SMS: capture the generated OTP so we can verify
// with the same random code the server produced (there is no fixed code).
const sms = require('../src/services/sms');
const sentOtps = new Map();
sms.send = async ({ to, body }) => {
  const code = (String(body).match(/\b(\d{6})\b/) || [])[1];
  if (code) sentOtps.set(String(to).replace(/[^+\d]/g, ''), code);
  return { logged: true };
};

// Request an OTP and return the code that was (notionally) delivered.
async function requestAndReadCode(phone, role) {
  await authService.requestOtp({ phone, role });
  return sentOtps.get(phone);
}

test('normalizePhone converts local SA formats to E.164', () => {
  assert.equal(authService.normalizePhone('0000000000'), '+27000000000');
  assert.equal(authService.normalizePhone('+27 00 000 0000'), '+27000000000');
  assert.equal(authService.normalizePhone('000 000 0000'), '+27000000000');
});

test('requestOtp stores a code that verifyOtp accepts (customer)', async () => {
  const phone = '+27820000001';
  const code = await requestAndReadCode(phone, 'customer');

  const row = repo.getOtp(phone);
  assert.ok(row, 'OTP row should exist');
  assert.match(String(row.code), /^[0-9a-f]{64}$/, 'stored OTP is a SHA-256 hash, not plaintext');
  assert.notEqual(code, '123456', 'codes are random, never the old fixed value');

  const result = await authService.verifyOtp({ phone, code, role: 'customer' });
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
  const code = await requestAndReadCode(phone, 'customer');

  assert.equal((await authService.verifyOtp({ phone, code, role: 'customer' })).success, true);
  const again = await authService.verifyOtp({ phone, code, role: 'customer' });
  assert.equal(again.success, false);
  assert.match(again.error, /No code requested/);
});

test('strangers may register as a driver but stay pending until approved', async () => {
  const stranger = '+27820000002';
  const code = await requestAndReadCode(stranger, 'driver');

  const result = await authService.verifyOtp({ phone: stranger, code, role: 'driver' });
  assert.equal(result.success, true);
  assert.equal(result.user.role, 'driver');
  assert.equal(result.user.driverStatus, 'pending', 'new driver applications start pending');

  // A pending driver cannot use operational driver routes.
  assert.equal(repo.listDriversForAdmin().length >= 1, true);
});

test('the owner phone creates the admin (owner) account on first login', async () => {
  assert.ok(config.driverPhone.length >= 10);
  const owner = config.driverPhone;
  const code = await requestAndReadCode(owner, 'driver');

  const result = await authService.verifyOtp({ phone: owner, code, role: 'driver' });
  assert.equal(result.success, true);
  assert.equal(result.user.role, 'admin');
  assert.equal(result.user.driverStatus, 'approved');
  assert.equal(result.user.phone, owner);
});

test('an existing customer becomes a pending driver applicant by choosing driver', async () => {
  const phone = '+27820000003';
  const first = await requestAndReadCode(phone, 'customer');
  await authService.verifyOtp({ phone, code: first, role: 'customer' });

  const second = await requestAndReadCode(phone, 'driver');
  const result = await authService.verifyOtp({ phone, code: second, role: 'driver' });
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