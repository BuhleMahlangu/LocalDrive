// SMS provider dispatch + OTP code generation. Each node --test file runs in
// its own process, so we can set provider env vars before config loads and
// stub global.fetch to assert the exact HTTP request per provider.

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'test';
process.env.SMS_PROVIDER = 'twilio';
process.env.TWILIO_ACCOUNT_SID = 'AC123';
process.env.TWILIO_AUTH_TOKEN = 'secret-token';
process.env.TWILIO_FROM = '+27000000001';
// Tests that exercise real dispatch must opt in: test env otherwise logs only.
process.env.SMS_FORCE = 'true';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const sms = require('../src/services/sms');
const auth = require('../src/services/auth');
const repo = require('../src/db/repository');

const realFetch = global.fetch;
let calls = [];

function mockFetch(handler) {
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

before(() => { calls = []; });
after(() => { global.fetch = realFetch; });
beforeEach(() => { calls = []; });

test('sms reports configured when provider + credentials are present', () => {
  assert.equal(sms.isConfigured(), true);
  assert.equal(sms.providerName(), 'twilio');
});

test('send() posts a correctly authenticated Twilio message and normalises the number', async () => {
  mockFetch(() => jsonResponse(201, { sid: 'SM_xxx', status: 'queued' }));
  const result = await sms.send({ to: '+27 83 123 4567', body: 'DriveLocal: 456789' });
  assert.equal(result.queued, true);
  assert.equal(result.messageId, 'SM_xxx');

  const { url, opts } = calls[0];
  assert.equal(url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
  assert.equal(opts.headers.Authorization, `Basic ${Buffer.from('AC123:secret-token').toString('base64')}`);
  const params = new URLSearchParams(opts.body);
  assert.equal(params.get('To'), '+27831234567');
  assert.equal(params.get('From'), '+27000000001');
  assert.equal(params.get('Body'), 'DriveLocal: 456789');
});

test('send() throws with the provider message on a failed send', async () => {
  mockFetch(() => jsonResponse(400, { message: 'The \'From\' number is not a valid phone number' }));
  await assert.rejects(
    () => sms.send({ to: '+27831234567', body: 'x' }),
    /Twilio error 400: The 'From' number is not a valid phone number/,
  );
});

test('in development, a configured provider still logs instead of sending (no credit burn)', async () => {
  // Reload config + sms as if NODE_ENV=development without the opt-in flag.
  const prevEnv = process.env.NODE_ENV;
  const prevForce = process.env.SMS_FORCE;
  process.env.NODE_ENV = 'development';
  process.env.SMS_FORCE = '';
  for (const m of ['../src/config', '../src/services/sms']) {
    delete require.cache[require.resolve(m)];
  }
  try {
    const devSms = require('../src/services/sms');
    mockFetch(() => jsonResponse(201, { sid: 'SM_zzz', status: 'queued' }));
    const result = await devSms.send({ to: '+27831234567', body: 'DriveLocal: 111222' });
    assert.equal(result.logged, true);
    assert.equal(calls.length, 0, 'no HTTP request leaves the machine in dev');
    assert.equal(devSms.deliversReal(), false);
  } finally {
    process.env.NODE_ENV = prevEnv;
    if (prevForce === undefined) delete process.env.SMS_FORCE;
    else process.env.SMS_FORCE = prevForce;
    for (const m of ['../src/config', '../src/services/sms']) {
      delete require.cache[require.resolve(m)];
    }
  }
});

test('requestOtp issues a random code and delivers it by SMS', async () => {
  let sentBody = null;
  mockFetch((_url, opts) => {
    sentBody = new URLSearchParams(opts.body).get('Body');
    return jsonResponse(201, { sid: 'SM_yyy', status: 'queued' });
  });

  const res = await auth.requestOtp({ phone: '+27839998888' });
  assert.equal(res.delivery, 'sms');
  assert.equal(res.dev, false);

  // A real 6-digit code went out over SMS — never the fixed 123456.
  const code = sentBody.match(/code is (\d{6})/)[1];
  assert.ok(code !== '123456');
  assert.equal(auth.hashOtp('+27839998888', code), repo.getOtp('+27839998888').code);

  // And it verifies.
  const verified = auth.verifyOtp({ phone: '+27839998888', code, role: 'customer', name: 'Test User' });
  assert.equal(verified.success, true);
  assert.ok(verified.token);
});
