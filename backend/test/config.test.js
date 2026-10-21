// Production startup guardrails. Login is phone + PIN now, so there is no OTP
// delivery requirement; production still refuses to start without a strong JWT
// secret, the owner phone, and a service-area centre.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Keys that satisfy the production requirements.
const BASE = {
  NODE_ENV: 'production',
  JWT_SECRET: 'x'.repeat(48),
  DRIVER_PHONE: '+27830000000',
  SERVICE_AREA_LAT: '-26.2155',
  SERVICE_AREA_LNG: '29.2916',
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

test('production starts without any OTP/SMS/SMTP configuration (PIN login)', () => {
  const { config, error } = loadConfig();
  assert.equal(error, undefined, 'no delivery path is required for PIN login');
  assert.ok(config);
});

test('production refuses to start with a weak or missing JWT secret', () => {
  const { error } = loadConfig({ JWT_SECRET: 'too-short' });
  assert.ok(error, 'config should throw');
  assert.match(error.message, /JWT_SECRET must be a strong random secret/);
});

test('production refuses to start without the owner phone', () => {
  const { error } = loadConfig({ DRIVER_PHONE: '' });
  assert.ok(error, 'config should throw');
  assert.match(error.message, /DRIVER_PHONE must be set/);
});

test('production refuses to start with no service-area centre', () => {
  const { error } = loadConfig({ SERVICE_AREA_LAT: '0', SERVICE_AREA_LNG: '0' });
  assert.ok(error, 'config should throw');
  assert.match(error.message, /SERVICE_AREA_LAT and SERVICE_AREA_LNG/);
});

// Behind a proxy (Railway/Render/Caddy) req.ip would otherwise be the proxy's
// address, so every user would share one PIN rate-limit bucket.
test('TRUST_PROXY defaults to one hop in production and none in development', () => {
  const { config } = loadConfig({ TRUST_PROXY: '' });
  assert.equal(config.trustProxy, 1, 'production trusts the first proxy hop');

  const prev = { ...process.env };
  process.env.NODE_ENV = 'development';
  delete require.cache[require.resolve('../src/config')];
  const dev = require('../src/config');
  assert.equal(dev.trustProxy, false, 'development trusts nothing');
  process.env = prev;
  delete require.cache[require.resolve('../src/config')];
});

test('TRUST_PROXY accepts a hop count and can be switched off', () => {
  assert.equal(loadConfig({ TRUST_PROXY: '2' }).config.trustProxy, 2);
  assert.equal(loadConfig({ TRUST_PROXY: 'true' }).config.trustProxy, true);
  assert.equal(loadConfig({ TRUST_PROXY: 'false' }).config.trustProxy, false);
  // "0" must mean "trust no hops", not "trust everything".
  assert.equal(loadConfig({ TRUST_PROXY: '0' }).config.trustProxy, false);
});
