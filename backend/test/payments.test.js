// Yoco payment flow tests with a mocked Yoco API. Boots the real Express app
// against an in-memory SQLite DB, stubs global.fetch for anything hitting the
// fake Yoco host, and drives signup → booking → completion → checkout → confirm
// → refund over HTTP, exactly like the running server + e2e smoke test.

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'test';
process.env.YOCO_SECRET_KEY = 'sk_test_fake';
process.env.YOCO_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.YOCO_API_BASE = 'http://yoco.test/api';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const crypto = require('crypto');

const repo = require('../src/db/repository');
const { createApp } = require('../src/app');
const { signToken } = require('../src/middleware');

// Keep test output clean: never actually send an SMS.
const sms = require('../src/services/sms');
sms.send = async () => ({ dev: true });

const notify = {
  tripUpdated() {}, newTripToDriver() {}, scheduledTripAdded() {},
  tripAccepted() {}, tripArrived() {}, paymentUpdated() {},
  driverStatus() {}, onlineDriversChanged() {}, chatMessage() {},
  chatRead() {}, tripClaimed() {}, sosAlert() {}, kickDriver() {},
  forceOffline() {},
};

// ---- Fake Yoco API ----
const yocoStore = new Map();   // checkoutId -> checkout object
const refundStore = new Map(); // checkoutId -> refundId
let coSeq = 0;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function yocoHandler(url, opts = {}) {
  const method = opts.method || 'GET';
  const path = new URL(url).pathname;

  if (method === 'POST' && path === '/api/checkouts') {
    const body = opts.body ? JSON.parse(opts.body) : {};
    const id = `co_${++coSeq}`;
    const checkout = {
      id,
      status: 'pending',
      redirectUrl: `https://pay.yoco.test/hosted/${id}`,
      amount: body.amount,
      currency: body.currency,
    };
    yocoStore.set(id, checkout);
    return jsonResponse(checkout);
  }
  if (method === 'GET' && /^\/api\/checkouts\/[^/]+$/.test(path)) {
    const id = path.split('/').pop();
    const checkout = yocoStore.get(id);
    if (!checkout) return jsonResponse({ message: 'Not found' }, 404);
    return jsonResponse(checkout);
  }
  if (method === 'POST' && /^\/api\/checkouts\/[^/]+\/refund$/.test(path)) {
    const id = path.split('/')[3];
    if (yocoStore.get(id)?.status !== 'completed') {
      return jsonResponse({ message: 'Checkout not completed' }, 422);
    }
    const refundId = `rf_${id}`;
    refundStore.set(id, refundId);
    return jsonResponse({ refundId, id, status: 'succeeded' });
  }
  return jsonResponse({ message: `Unhandled fake Yoco route ${method} ${path}` }, 404);
}

const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('http://yoco.test')) return yocoHandler(String(url), opts);
  return realFetch(url, opts);
};
// Tests that need to pre-mark a checkout as completed (simulating the customer
// finishing the hosted page) do it through this helper.
function completeCheckout(id) {
  const checkout = yocoStore.get(id);
  if (checkout) checkout.status = 'completed';
}

// ---- HTTP helpers ----
let server;
let BASE;
let customerToken;

before(async () => {
  const app = createApp({ notify });
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  BASE = `http://127.0.0.1:${port}`;
  // Log the customer in once and reuse the token: the OTP request limiter
  // allows only 3 requests / 60s per phone, and every test books a trip.
  const customer = await login('+27739998888', 'customer', 'Lerato', 'l@x.za');
  customerToken = customer.token;
});

after(() => new Promise((resolve) => {
  server.close(resolve);
  if (server.closeAllConnections) server.closeAllConnections();
  global.fetch = realFetch;
}));

async function api(method, path, body, token, raw = false) {
  const headers = {};
  if (raw) headers['Content-Type'] = 'application/json';
  else headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function login(phone, role, name, email) {
  await api('POST', '/api/auth/otp/request', { phone, role });
  const res = await api('POST', '/api/auth/otp/verify', {
    phone, code: '123456', role, name, email,
  });
  assert.equal(res.status, 200, `otp verify ok for ${phone} (${role})`);
  return res.json;
}

const PICKUP = { lat: -26.2041, lng: 28.0473, address: 'Joburg CBD' };
const DEST = { lat: -26.1076, lng: 28.0567, address: 'Sandton' };

function ensureDriver() {
  let driver = repo.getUserByPhone('+27000000000', 'driver');
  if (!driver) {
    driver = repo.createUser({ phone: '+27000000000', name: 'Thabo', email: 'd@x.za', role: 'driver' });
  }
  repo.setDriverOnline(driver.id, true);
  return { token: signToken({ id: driver.id, role: 'driver' }), user: driver };
}

async function bookAndCompleteCardTrip({ promoCode } = {}) {
  const customer = { token: customerToken };
  const driver = ensureDriver();

  const book = await api('POST', '/api/customer/trips', {
    pickup: PICKUP,
    destination: DEST,
    paymentMethod: 'card',
    promoCode,
  }, customer.token);
  assert.equal(book.status, 201, 'card trip booked');
  const tripId = book.json.trip.id;

  await api('POST', `/api/driver/trips/${tripId}/accept`, {}, driver.token);
  await api('POST', `/api/driver/trips/${tripId}/start`, {}, driver.token);
  const complete = await api('POST', `/api/driver/trips/${tripId}/complete`, {
    actualDistanceKm: book.json.trip.distanceKm,
    actualDurationMin: book.json.trip.durationMin,
    tipAmount: 0,
  }, driver.token);
  assert.equal(complete.json.trip.status, 'completed', 'card trip completed');
  return { tripId, customer: customer.token, estimate: book.json.estimate };
}

function successWebhookHeaders(rawBody) {
  const secret = 'whsec_test_secret';
  const id = 'evt_test_1';
  const timestamp = Math.floor(Date.now() / 1000);
  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const signature = crypto.createHmac('sha256', secret).update(signedContent).digest('base64');
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${signature}`,
    'Content-Type': 'application/json',
  };
}

test('GET /api/payments/config reports yoco enabled when a secret key is set', async () => {
  const res = await api('GET', '/api/payments/config');
  assert.equal(res.status, 200);
  assert.equal(res.json.provider, 'yoco');
  assert.equal(res.json.enabled, true);
});

test('card trip: hosted checkout, confirm, and refund flow', async () => {
  const { tripId, customer } = await bookAndCompleteCardTrip();

  // Payment is pending on completion until the customer checks out.
  const before = repo.getPaymentByTrip(tripId);
  assert.equal(before.provider, 'yoco');
  assert.equal(before.status, 'pending');

  const checkout = await api('POST', '/api/payments/checkout', { tripId }, customer);
  assert.equal(checkout.status, 200);
  assert.ok(checkout.json.redirectUrl.startsWith('https://pay.yoco.test/hosted/'), 'hosted redirect URL returned');
  const checkoutId = checkout.json.checkoutId;
  assert.equal(checkout.json.paid, false);

  // Platform fee must be read from the runtime setting at finalisation time,
  // not the env default, so flip it before the payment is marked succeeded.
  repo.setSetting('platform_fee_percent', '25');

  // Simulate the customer finishing the hosted page, then confirm.
  completeCheckout(checkoutId);
  const confirm = await api('POST', '/api/payments/confirm', { tripId }, customer);
  assert.equal(confirm.status, 200);
  assert.equal(confirm.json.paid, true);
  const paid = repo.getPaymentByTrip(tripId);
  assert.equal(paid.status, 'succeeded');
  assert.equal(paid.amountCents, Math.round(confirm.json.trip.finalFare * 100));

  const fee = Math.round(paid.amountCents * 0.25);
  assert.equal(paid.platformFeeCents, fee);
  assert.equal(paid.driverPayoutCents, paid.amountCents - fee);

  // A second confirm must be idempotent (no new checkout / re-charge).
  const again = await api('POST', '/api/payments/confirm', { tripId }, customer);
  assert.equal(again.json.paid, true);

  // Refund the successful charge via the customer route.
  const refund = await api('POST', '/api/payments/refund', { tripId }, customer);
  assert.equal(refund.status, 200);
  assert.equal(refund.json.refunded, true);
  assert.ok(refund.json.refund.refundId.startsWith('rf_'), 'Yoco refund id returned');
  assert.equal(repo.getPaymentByTrip(tripId).status, 'refunded');

  repo.setSetting('platform_fee_percent', null);
});

test('signed webhook marks a payment succeeded (double-check with Yoco)', async () => {
  const { tripId, customer } = await bookAndCompleteCardTrip();

  const checkout = await api('POST', '/api/payments/checkout', { tripId }, customer);
  completeCheckout(checkout.json.checkoutId);

  const rawBody = JSON.stringify({
    type: 'payment.succeeded',
    payload: { metadata: { tripId }, id: checkout.json.checkoutId },
  });
  const res = await fetch(`${BASE}/api/payments/webhook`, {
    method: 'POST',
    headers: successWebhookHeaders(rawBody),
    body: rawBody,
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.tripId, tripId);
  assert.equal(repo.getPaymentByTrip(tripId).status, 'succeeded');
});

test('webhook rejects missing or invalid signatures', async () => {
  const { tripId } = await bookAndCompleteCardTrip();

  const rawBody = JSON.stringify({ type: 'payment.succeeded', payload: { metadata: { tripId } } });
  const bad = await fetch(`${BASE}/api/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
  assert.equal(bad.status, 400);

  const goodHeaders = successWebhookHeaders(rawBody);
  const forged = await fetch(`${BASE}/api/payments/webhook`, {
    method: 'POST',
    headers: { ...goodHeaders, 'webhook-signature': 'v1,c2lnbmF0dXJl' },
    body: rawBody,
  });
  assert.equal(forged.status, 400);
});

test('a failed webhook records payment.failed', async () => {
  const { tripId, customer } = await bookAndCompleteCardTrip();
  await api('POST', '/api/payments/checkout', { tripId }, customer);

  const rawBody = JSON.stringify({
    type: 'payment.failed',
    payload: { metadata: { tripId } },
  });
  const res = await fetch(`${BASE}/api/payments/webhook`, {
    method: 'POST',
    headers: successWebhookHeaders(rawBody),
    body: rawBody,
  });
  assert.equal(res.status, 200);
  assert.equal(repo.getPaymentByTrip(tripId).status, 'failed');
});

test('card trips cannot be refunded before they succeed', async () => {
  const { tripId, customer } = await bookAndCompleteCardTrip();
  const res = await api('POST', '/api/payments/refund', { tripId }, customer);
  assert.equal(res.status, 409);
  assert.match(res.json.error, /not refundable/i);
});