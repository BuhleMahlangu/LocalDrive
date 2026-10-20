// Production startup guardrails around OTP delivery: with no SMS provider and
// no SMTP configured, production must refuse to start unless the deployment
// explicitly opts into the fixed 123456 code (closed beta).

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Keys that satisfy the *other* production requirements so any throw we see is
// about the OTP guardrail specifically.
const BASE = {
  NODE_ENV: 'production',
  JWT_SECRET: 'x'.repeat(48),
  DRIVER_PHONE: '+27830000000',
  SMS_PROVIDER: '',
  WHATSAPP_ACCESS_TOKEN: '',
  WHATSAPP_PHONE_NUMBER_ID: '',
  AT_API_KEY: '',
  AT_USERNAME: '',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  TWILIO_FROM: '',
  CLICKSEND_USERNAME: '',
  CLICKSEND_API_KEY: '',
  SMTP_HOST: '',
  SMTP_USER: '',
  SMTP_PASS: '',
  ALLOW_FIXED_OTP: '',
};

function loadConfig(overrides = {}) {
  const prev = {};
  for (const [k, v] of Object.entries({ ...BASE, ...overrides })) {
    prev[k] = process.env[k];
    // Empty string (not deletion) so dotenv can't refill from backend/.env —
    // dotenv never overwrites existing keys, and '' is falsy for all checks.
    process.env[k] = v;
  }
  try {
    delete require.cache[require.resolve('../src/config')];
    return { config: require('../src/config') };
  } catch (e) {
    return { error: e };
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[require.resolve('../src/config')];
  }
}

test('production refuses to start with no OTP delivery path', () => {
  const { error } = loadConfig();
  assert.ok(error, 'config should throw');
  assert.match(error.message, /No OTP delivery path configured/);
});

test('production refuses to start with SMS_PROVIDER set but no credentials', () => {
  const { error } = loadConfig({ SMS_PROVIDER: 'twilio' });
  assert.ok(error, 'config should throw');
  assert.match(error.message, /No OTP delivery path configured/);
});

test('ALLOW_FIXED_OTP=true lets a closed beta run the fixed code', () => {
  const { config, error } = loadConfig({ ALLOW_FIXED_OTP: 'true' });
  assert.equal(error, undefined);
  assert.equal(config.nodeEnv, 'production');
});

test('production starts once a provider is fully configured', () => {
  const cases = [
    { SMS_PROVIDER: 'whatsapp', WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: '1' },
    { SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+27000000001' },
    { SMS_PROVIDER: 'africastalking', AT_API_KEY: 'k', AT_USERNAME: 'app' },
    { SMS_PROVIDER: 'clicksend', CLICKSEND_USERNAME: 'u', CLICKSEND_API_KEY: 'k' },
    { SMTP_HOST: 'smtp.example.com', SMTP_USER: 'u', SMTP_PASS: 'p' },
  ];
  for (const overrides of cases) {
    const { error } = loadConfig(overrides);
    assert.equal(error, undefined, `should start with ${JSON.stringify(overrides)}`);
  }
});
