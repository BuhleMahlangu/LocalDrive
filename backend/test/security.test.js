// Regression tests for the hardening pass:
//  1. IDOR: a customer cannot cancel another customer's trip.
//  2. Admin-only: an approved (non-owner) driver cannot write settings/promos
//     or open/resolve disputes.
//  3. Tipping adjusts the agreed final fare — it never re-prices from today's
//     rate card, and a repeat tip is idempotent.
//  4. Completion "actual" distance/duration are clamped to the booked route so
//     a bad GPS frame or scripted client can't inflate the fare.
//  5. Scheduled-at values are normalised to UTC so rides release on time.
//  6. Payment records cannot regress: failed-after-succeeded and
//     succeeded-after-refunded are no-ops.
//  7. /estimate must 404 cleanly when no driver row exists (fresh DB), not 500.
//
// Same harness as routing.test.js: real Express app, in-memory SQLite, HTTP.

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const config = require('../src/config');
const repo = require('../src/db/repository');
const pricing = require('../src/services/pricing');
const { createApp } = require('../src/app');
const { signToken } = require('../src/middleware');

const notify = {
  tripUpdated() {}, newTripToDriver() {}, scheduledTripAdded() {},
  tripAccepted() {}, tripArrived() {}, paymentUpdated() {},
  driverStatus() {}, onlineDriversChanged() {}, chatMessage() {},
  chatRead() {}, tripClaimed() {}, sosAlert() {}, kickDriver() {},
  forceOffline() {},
};

let server;
let BASE;

before(async () => {
  const app = createApp({ notify });
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', resolve);
  });
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => {
  server.close(resolve);
  if (server.closeAllConnections) server.closeAllConnections();
}));

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body && method !== 'GET' && method !== 'HEAD' ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// Ride gates: customers must upload an ID copy + selfie before booking. Fixture
// customers get both seeded here (the no-docs path is tested explicitly below).
const TEST_SA_ID = '9001015800088';
function seedCustomerIdentity(userId) {
  repo.saveCustomerIdentity(userId, {
    idNumber: TEST_SA_ID,
    idCopyPath: `${userId}_idcopy.jpg`,
    selfiePath: `${userId}_selfie.jpg`,
  });
}

function pinFor(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return digits.slice(-6).padStart(6, '0');
}
async function login(phone, role, name, email) {
  const pin = pinFor(phone);
  const setup = await api('POST', '/api/auth/pin/setup', { phone, pin, role, name, email });
  const res = setup.status === 200 ? setup : await api('POST', '/api/auth/pin/login', { phone, pin, role });
  assert.equal(res.status, 200, `pin login ok for ${phone} (${role})`);
  if (role === 'customer') seedCustomerIdentity(res.json.user.id);
  return { token: res.json.token, user: res.json.user };
}

const DRIVER_PHONE = config.driverPhone || '+27000000000';
const PICKUP = { lat: -26.2041, lng: 28.0473, address: 'Joburg CBD' };
const DEST = { lat: -26.1076, lng: 28.0567, address: 'Sandton' };

let driver;
function ensureDriver() {
  if (driver) return driver;
  // The owner phone is an admin in production (can still drive — the driver
  // middleware allows admins), so mirror that here: one row, role 'admin'.
  let d = repo.getUserByPhone(DRIVER_PHONE, 'admin');
  if (!d) d = repo.createUser({ phone: DRIVER_PHONE, name: 'Thabo', email: 'd@x.za', role: 'admin' });
  driver = { token: signToken({ id: d.id, role: 'admin' }), user: d };
  return driver;
}

async function goOnline() {
  await api('POST', '/api/driver/online', { isOnline: true }, ensureDriver().token);
}

test('a customer cannot cancel another customer\'s trip (IDOR)', async () => {
  await goOnline();
  const alice = await login('+27722000001', 'customer', 'Alice', 'alice@x.za');
  const mallory = await login('+27722000002', 'customer', 'Mallory', 'mallory@x.za');

  const booked = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
  }, alice.token);
  assert.equal(booked.status, 201);

  const res = await api('POST', `/api/customer/trips/${booked.json.trip.id}/cancel`,
    { reason: 'I hijacked this' }, mallory.token);
  assert.equal(res.status, 404, "anon trip lookup for Mallory is a 404, not a cancel");
  assert.equal(repo.getTripById(booked.json.trip.id).status, 'requested',
    'the trip is untouched');
});

test('admin-only driver surfaces reject an approved non-owner driver', async () => {
  const owner = ensureDriver(); // the owner admin — same row drives and owns the platform
  const admin = signToken({ id: owner.user.id, role: 'admin' });
  // An approved (non-owner) driver account in the DB.
  const otherDriver = repo.createUser({ phone: '+27722000003', name: 'Other', email: 'o@x.za', role: 'driver', driverStatus: 'approved' });
  const other = signToken({ id: otherDriver.id, role: 'driver' });

  for (const [method, path] of [
    ['GET', '/api/driver/settings'],
    ['PUT', '/api/driver/settings'],
    ['GET', '/api/driver/promos'],
    ['POST', '/api/driver/promos'],
    ['GET', '/api/driver/disputes'],
    ['POST', '/api/driver/disputes/whatever/resolve'],
  ]) {
    const blocked = await api(method, path, { auto_offline_grace_ms: 120000 }, other);
    assert.equal(blocked.status, 403, `${method} ${path} must require admin`);
  }

  assert.equal((await api('GET', '/api/driver/settings', null, admin)).status, 200,
    'the owner still reaches settings');
});

test('tipping adds to the agreed fare and never re-prices it', async () => {
  await goOnline();
  const customer = await login('+27722000004', 'customer', 'Thuli', 'thuli@x.za');

  const booked = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
  }, customer.token);
  const id = booked.json.trip.id;
  await api('POST', `/api/driver/trips/${id}/accept`, {}, ensureDriver().token);
  await api('POST', `/api/driver/trips/${id}/start`, {}, ensureDriver().token);
  const before = await api('POST', `/api/driver/trips/${id}/complete`, {}, ensureDriver().token);
  const agreed = before.json.trip.finalFare;
  const agreedDist = before.json.trip.distanceKm;
  assert.ok(agreed > 0);

  // The owner bumps their rates — this must NOT retroactively change old trips.
  await api('PUT', '/api/driver/profile', { baseFare: 999, perKmRate: 999, perMinRate: 999 }, ensureDriver().token);

  const rated = await api('POST', `/api/customer/trips/${id}/rate`, { stars: 5, tipAmount: 10 }, customer.token);
  assert.equal(rated.status, 200);
  assert.equal(rated.json.trip.tipAmount, 10);
  assert.equal(rated.json.trip.finalFare, Math.round((agreed + 10) * 100) / 100,
    'final fare = agreed fare + tip, not a re-estimate at today rates');

  // A repeat tip call is idempotent (final = agreed + current tip, not +10 twice).
  const again = await api('POST', `/api/customer/trips/${id}/rate`, { stars: 5, tipAmount: 10 }, customer.token);
  assert.equal(again.json.trip.finalFare, rated.json.trip.finalFare);

  // The cash payment amount followed the tip.
  assert.equal(repo.getPaymentByTrip(id).amountCents, Math.round((agreed + 10) * 100));
  assert.ok(repo.getPaymentByTrip(id).driverPayoutCents > 0);

  // Legacy sanity: the stored route distance used for the clamp is meaningful.
  assert.ok(agreedDist > 0);
});

test('completion clamps inflated actual distance/time to the booked route', async () => {
  await goOnline();
  // Set known rates so the fare below is asserted against the clamped actuals,
  // independent of what another test may have left in the profile.
  await api('PUT', '/api/driver/profile', { baseFare: 50, perKmRate: 10, perMinRate: 2 }, ensureDriver().token);

  const customer = await login('+27722000005', 'customer', 'Bongani', 'bongani@x.za');

  const booked = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
  }, customer.token);
  const id = booked.json.trip.id;
  const bookedDist = booked.json.trip.distanceKm;
  const bookedDur = booked.json.trip.durationMin;
  assert.ok(bookedDist > 0, 'booking priced with a distance');

  await api('POST', `/api/driver/trips/${id}/accept`, {}, ensureDriver().token);
  await api('POST', `/api/driver/trips/${id}/start`, {}, ensureDriver().token);
  const done = await api('POST', `/api/driver/trips/${id}/complete`, {
    actualDistanceKm: 99999, actualDurationMin: 99999,
  }, ensureDriver().token);
  const trip = done.json.trip;
  const distCap = pricing.round(bookedDist * 3 + 3);
  const durCap = pricing.round(bookedDur * 5 + 20);
  assert.ok(trip.distanceKm <= distCap, `distance clamped: ${trip.distanceKm} <= ${distCap}`);
  assert.ok(trip.durationMin <= durCap, `duration clamped: ${trip.durationMin} <= ${durCap}`);
  // Fare is the clamped distance/duration at today's known rates — nothing
  // based on the absurd 99999 input.
  const expected = pricing.round(50 + 10 * trip.distanceKm + 2 * trip.durationMin);
  assert.equal(trip.finalFare, expected, 'fare computed from the clamped actuals');
});

test('scheduled-at is normalised to a UTC instant on booking', async () => {
  await goOnline();
  const customer = await login('+27722000006', 'customer', 'Zanele', 'zanele@x.za');

  const booked = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
    scheduledAt: '2026-10-07T14:00:00+02:00',
  }, customer.token);
  assert.equal(booked.status, 201);
  assert.equal(booked.json.trip.status, 'scheduled');
  assert.equal(booked.json.trip.scheduledAt, '2026-10-07T12:00:00.000Z',
    'an explicit +02:00 wall time becomes the exact UTC instant');

  // A naive (no-zone) value still comes back as valid UTC ISO, never the raw
  // wall-clock string the scheduler used to mis-compare.
  const naive = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
    scheduledAt: '2027-01-05T08:00',
  }, customer.token);
  assert.equal(naive.status, 201);
  assert.ok(/Z$/.test(naive.json.trip.scheduledAt), 'stored value is UTC ISO');
  assert.equal(new Date(naive.json.trip.scheduledAt).getTime(), new Date('2027-01-05T08:00').getTime(),
    'the naive local string is parsed as the intended wall time, in UTC');
});

test('payment status can never regress from succeeded or refunded', async () => {
  const userId = repo.createUser({ phone: '+27722000007', name: 'P', role: 'customer' });
  const trip = repo.createTrip({
    id: 'trip_regress_test', customerId: userId.id, status: 'completed',
    pickup: { address: 'A', lat: -26, lng: 28 }, destination: { address: 'B', lat: -26, lng: 28 },
  });
  repo.createPayment({ tripId: trip.id, amountCents: 1000, provider: 'cash', currency: 'zar' });

  repo.markPaymentSucceeded(trip.id, { driverPayoutCents: 900, platformFeeCents: 100 });
  repo.markPaymentFailed(trip.id); // duplicate/late failure webhook
  assert.equal(repo.getPaymentByTrip(trip.id).status, 'succeeded',
    'a late failure must not undo a successful charge');

  // Refund is terminal: a delayed success event must not resurrect the charge.
  const trip2 = repo.createTrip({
    id: 'trip_regress_test2', customerId: userId.id, status: 'completed',
    pickup: { address: 'A', lat: -26, lng: 28 }, destination: { address: 'B', lat: -26, lng: 28 },
  });
  repo.createPayment({ tripId: trip2.id, amountCents: 1000, provider: 'yoco', currency: 'zar' });
  repo.markPaymentSucceeded(trip2.id, { paymentIntentId: 'chk_1', driverPayoutCents: 900, platformFeeCents: 100 });
  repo.markPaymentRefunded(trip2.id, { refundId: 'rf_1' });
  repo.markPaymentSucceeded(trip2.id, { paymentIntentId: 'chk_1', driverPayoutCents: 900, platformFeeCents: 100 });
  assert.equal(repo.getPaymentByTrip(trip2.id).status, 'refunded',
    'a refunded payment stays refunded');
});

test('/estimate answers 404 when no driver rate card exists instead of 500', async () => {
  // Simulates a fresh database (owner never logged in): routes that dereference
  // the single driver row must fail cleanly. getRoute is skipped by the guard,
  // so this stays fast and offline.
  const original = repo.getDriver;
  repo.getDriver = () => null;
  try {
    const res = await api('POST', '/api/customer/estimate', {
      pickup: PICKUP, destination: DEST,
    });
    assert.equal(res.status, 404, 'clean 404, not a TypeError-driven 500');
    assert.match(res.json.error, /driver/i);
  } finally {
    repo.getDriver = original;
  }
});

// ---- Identity document gates (safety feature) ----

async function postMultipart(path, fields, files, token) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  for (const [key, file] of Object.entries(files)) {
    form.append(key, new Blob([file.bytes], { type: 'image/jpeg' }), file.name);
  }
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

test('a customer cannot book until they upload ID documents, and their documents stay private', async () => {
  await goOnline();
  const user = repo.createUser({ phone: '+27729000001', name: 'NoDocs Naledi', role: 'customer' });
  const token = signToken({ id: user.id, role: 'customer' });

  // The policy flag the booking screen keys its verify panel on.
  const before = await api('GET', '/api/customer/identity', null, token);
  assert.equal(before.status, 200);
  assert.equal(before.json.uploaded, false);
  assert.equal(before.json.required, true);

  // Booking is refused with the machine-readable code.
  const denied = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
  }, token);
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, 'DOCUMENTS_REQUIRED');

  // A non-SA ID number is rejected outright.
  const badId = await postMultipart('/api/customer/identity', { idNumber: '123456' }, {
    idCopy: { name: 'id.jpg', bytes: [1, 2, 3] },
    selfie: { name: 'me.jpg', bytes: [4, 5, 6] },
  }, token);
  assert.equal(badId.status, 400);

  // Both files at once, exactly like the booking screen sends them.
  const uploaded = await postMultipart('/api/customer/identity', { idNumber: TEST_SA_ID }, {
    idCopy: { name: 'id.jpg', bytes: [1, 2, 3] },
    selfie: { name: 'me.jpg', bytes: [4, 5, 6] },
  }, token);
  assert.equal(uploaded.status, 201, 'both documents accepted');
  assert.equal(uploaded.json.uploaded, true);
  assert.equal(uploaded.json.required, false);

  // Re-uploading (e.g. a clearer selfie) must not collide on the stored
  // deterministic filename.
  const again = await postMultipart('/api/customer/identity', { idNumber: TEST_SA_ID }, {
    selfie: { name: 'me2.jpg', bytes: [7, 8, 9, 10] },
  }, token);
  assert.equal(again.status, 201, 're-upload with the same filenames works');
  assert.equal(again.json.uploaded, true);

  // With documents on file the booking goes through.
  const booked = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
  }, token);
  assert.equal(booked.status, 201, 'verified customer can book');

  // The admin owner previewing the customer app is exempt from the gate.
  const owner = ensureDriver();
  const adminBooked = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
  }, owner.token);
  assert.equal(adminBooked.status, 201, 'admin books without uploading anything');

  // Stored documents are private: another signed-in customer gets a 403...
  const filename = uploaded.json.idCopyUrl.split('/').pop();
  const other = await login('+27729000002', 'customer', 'Mallory', 'm2@x.za');
  const stranger = await api('GET', `/api/uploads/${filename}`, null, other.token);
  assert.equal(stranger.status, 403, 'a stranger cannot read the ID copy');
  // ...while the owner of the document can.
  const mine = await api('GET', `/api/uploads/${filename}`, null, token);
  assert.equal(mine.status, 200, 'the uploader can read their own document');
});

test('a driver without identity documents cannot go online or accept rides', async () => {
  const fresh = repo.createUser({ phone: '+27729000003', name: 'NoDocs Sipho', role: 'driver' });
  const token = signToken({ id: fresh.id, role: 'driver' });

  // Going offline is always allowed so nobody gets stuck.
  const off = await api('POST', '/api/driver/online', { isOnline: false }, token);
  assert.equal(off.status, 200);

  // Going online without an ID copy + selfie is refused...
  const on = await api('POST', '/api/driver/online', { isOnline: true }, token);
  assert.equal(on.status, 403);
  assert.equal(on.json.code, 'DOCUMENTS_REQUIRED');
  // ...and nothing was half-applied.
  assert.equal(repo.getUserById(fresh.id).isOnline, false, 'the driver stays offline');

  // The accept path is gated too, even for a driver already in the pool
  // (e.g. online before this feature shipped).
  await goOnline();
  repo.setDriverOnline(fresh.id, true);
  const customer = await login('+27729000004', 'customer', 'Thandi', 'thandi@x.za');
  const booked = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
  }, customer.token);
  assert.equal(booked.status, 201);

  const accept = await api('POST', `/api/driver/trips/${booked.json.trip.id}/accept`, {}, token);
  assert.equal(accept.status, 403);
  assert.equal(accept.json.code, 'DOCUMENTS_REQUIRED');
  assert.equal(repo.getTripById(booked.json.trip.id).driverId, null, 'the trip is untouched');
});