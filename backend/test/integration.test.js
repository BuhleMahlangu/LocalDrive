// HTTP integration tests. Boots the real Express app (no socket.io, stub notify)
// against an in-memory SQLite DB and drives the full customer <-> driver journey
// over HTTP with `fetch`, the same way the running server sees it.
//
// Each test file runs in its own process (node --test), so the env swap below
// safely happens before anything loads.

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const config = require('../src/config');
const repo = require('../src/db/repository');
const { createApp } = require('../src/app');
const { signToken } = require('../src/middleware');

// Keep test output clean: never actually send an SMS.
const sms = require('../src/services/sms');
sms.send = async () => ({ dev: true });

// The API routes call `notify.*` for realtime pushes; a no-op stub is enough.
const notify = {
  tripUpdated() {}, newTripToDriver() {}, scheduledTripAdded() {},
  tripAccepted() {}, tripArrived() {}, paymentUpdated() {},
  driverStatus() {}, onlineDriversChanged() {},
};

let server;
let BASE;

before(async () => {
  const app = createApp({ notify });
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  BASE = `http://127.0.0.1:${port}`;
});

after(() => new Promise((resolve) => {
  server.close(resolve);
  // fetch() keeps keep-alive sockets open, which would otherwise block close().
  if (server.closeAllConnections) server.closeAllConnections();
}));

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// Request an OTP, read the stored code straight from the DB (dev/test helper),
// verify it, and return the issued token.
async function login(phone, role, name, email) {
  const req = await api('POST', '/api/auth/otp/request', { phone, role });
  assert.equal(req.status, 200, `otp request ok for ${phone} (${role})`);
  const normalized = phone.replace(/[^+\d]/g, '');
  const row = repo.getOtp(normalized);
  assert.ok(row, `otp row stored for ${phone}`);
  const res = await api('POST', '/api/auth/otp/verify', {
    phone, code: row.code, role, name, email,
  });
  assert.equal(res.status, 200, `otp verify ok for ${phone} (${role})`);
  assert.equal(res.json.success, true);
  return { token: res.json.token, user: res.json.user };
}

const DRIVER_PHONE = config.driverPhone || '+27000000000';
const PICKUP = { lat: -26.2041, lng: 28.0473, address: 'Joburg CBD' };
const DEST = { lat: -26.1076, lng: 28.0567, address: 'Sandton' };

// The OTP rate limiter (3 / 60s per phone) makes repeated OTP logins with the
// shared driver number flaky, so lifecycle tests sign a token for the driver
// directly. The OTP + driver-gate flow itself is covered by the auth tests.
function ensureDriver() {
  let driver = repo.getUserByPhone(DRIVER_PHONE, 'driver');
  if (!driver) {
    driver = repo.createUser({ phone: DRIVER_PHONE, name: 'Thabo', email: 'd@x.za', role: 'driver' });
  }
  return { token: signToken({ id: driver.id, role: 'driver' }), user: driver };
}

// A separate admin account for testing the owner-only endpoints.
function ensureAdmin() {
  let admin = repo.getUserByPhone('+27828880000', 'admin');
  if (!admin) {
    admin = repo.createUser({ phone: '+27828880000', name: 'Owner', email: 'o@x.za', role: 'admin' });
  }
  return { token: signToken({ id: admin.id, role: 'admin' }), user: admin };
}

test('GET /health reports ok with service info', async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.service, 'drivelocal-backend');
  assert.equal(body.currency, 'zar');
});

test('unknown API routes return 404 JSON', async () => {
  const res = await fetch(`${BASE}/api/nope`);
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok('error' in body);
});

test('public pickup spots are listed', async () => {
  const res = await api('GET', '/api/pickup-spots');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.spots) && res.json.spots.length > 0);
  assert.equal(res.json.spots[0].id, 'spot_kriel_town');
});

test('auth: unauthenticated customer routes are rejected', async () => {
  const res = await api('GET', '/api/customer/places');
  assert.equal(res.status, 401);
});

test('auth: /auth/me returns the signed-in user', async () => {
  const { token, user } = await login('+27730001111', 'customer', 'Mina', 'm@x.za');
  const me = await api('GET', '/api/auth/me', null, token);
  assert.equal(me.status, 200);
  assert.equal(me.json.id, user.id);
  assert.equal(me.json.phone, user.phone);
});

test('auth: a stranger can apply as a driver (pending)', async () => {
  const req = await api('POST', '/api/auth/otp/request', { phone: '+27829999999', role: 'driver' });
  assert.equal(req.status, 200);
  const normalized = '+27829999999';
  const row = repo.getOtp(normalized);
  const res = await api('POST', '/api/auth/otp/verify', {
    phone: normalized, code: row.code, role: 'driver',
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.user.role, 'driver');
  assert.equal(res.json.user.driverStatus, 'pending');
});

test('customer saved places CRUD', async () => {
  const { token } = await login('+27730002222', 'customer', 'Naledi', 'n@x.za');

  const home = await api('POST', '/api/customer/places', {
    label: 'Home', kind: 'home', address: 'Thubelihle, Kriel', lat: -26.2155, lng: 29.2916,
  }, token);
  assert.equal(home.status, 201);
  assert.equal(home.json.kind, 'home');

  const work = await api('POST', '/api/customer/places', {
    label: 'Work', kind: 'work', address: 'Kriel Power Station', lat: -26.2, lng: 29.3,
  }, token);
  assert.equal(work.status, 201);

  const list = await api('GET', '/api/customer/places', null, token);
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 2);
  assert.equal(list.json[0].kind, 'home', 'homes sort first');

  const updated = await api('PUT', `/api/customer/places/${work.json.id}`, { label: 'Power Station' }, token);
  assert.equal(updated.status, 200);
  assert.equal(updated.json.label, 'Power Station');

  const del = await api('DELETE', `/api/customer/places/${work.json.id}`, null, token);
  assert.equal(del.json.ok, true);
  const after = await api('GET', '/api/customer/places', null, token);
  assert.equal(after.json.length, 1);
});

test('estimate endpoint returns a fare breakdown + route', async () => {
  // Estimates read the driver's configured rates, so ensure the driver exists.
  ensureDriver();

  const res = await api('POST', '/api/customer/estimate', { pickup: PICKUP, destination: DEST });
  assert.equal(res.status, 200);
  assert.ok(res.json.estimate.total > 0);
  assert.ok(res.json.estimate.baseFare >= 0);
  assert.ok(res.json.estimate.distanceCharge >= 0);
  assert.ok(res.json.route.distanceKm > 0);
});

test('full trip lifecycle over HTTP', async () => {
  const driver = ensureDriver();
  const customer = await login('+27730003333', 'customer', 'Sipho', 's@x.za');

  const online = await api('POST', '/api/driver/online', { isOnline: true }, driver.token);
  assert.equal(online.json.isOnline, true);

  const location = await api('POST', '/api/driver/location', { lat: -26.2041, lng: 28.0473, heading: 90, accuracy: 12 }, driver.token);
  assert.equal(location.status, 200);
  assert.equal(location.json.lat, -26.2041);

  const avail = await api('GET', '/api/customer/driver/availability');
  assert.equal(avail.json.isOnline, true);

  const estimate = await api('POST', '/api/customer/estimate', {
    pickup: PICKUP, destination: DEST, promoCode: 'DOESNOTEXIST',
  });
  assert.equal(estimate.status, 200, 'estimate still works with a bogus promo');

  const book = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
  }, customer.token);
  assert.equal(book.status, 201);
  assert.equal(book.json.trip.status, 'requested');
  assert.ok(book.json.trip.fareEstimate > 0);
  const tripId = book.json.trip.id;

  const pending = await api('GET', '/api/driver/pending-trip', null, driver.token);
  assert.equal(pending.json.trip.id, tripId);

  const accept = await api('POST', `/api/driver/trips/${tripId}/accept`, {}, driver.token);
  assert.equal(accept.status, 200);
  assert.equal(accept.json.trip.status, 'accepted');
  assert.equal(accept.json.trip.driverId, driver.user.id);

  const active = await api('GET', '/api/customer/trips/active', null, customer.token);
  assert.equal(active.json.trip.id, tripId);

  const arrive = await api('POST', `/api/driver/trips/${tripId}/arrive`, {}, driver.token);
  assert.equal(arrive.status, 200);
  assert.ok(arrive.json.trip.arrivedAt);

  const start = await api('POST', `/api/driver/trips/${tripId}/start`, {}, driver.token);
  assert.equal(start.json.trip.status, 'ongoing');

  const complete = await api('POST', `/api/driver/trips/${tripId}/complete`, {
    actualDistanceKm: 14.5, actualDurationMin: 28, tipAmount: 0,
  }, driver.token);
  assert.equal(complete.json.trip.status, 'completed');
  assert.ok(complete.json.trip.finalFare > 0);
  assert.equal(complete.json.payment.status, 'succeeded', 'cash settled on completion');
  assert.equal(complete.json.payment.provider, 'cash');
  assert.equal(
    complete.json.payment.amountCents,
    Math.round(complete.json.trip.finalFare * 100),
    'payment amount matches the final fare',
  );

  const fareConfirm = await api('POST', `/api/customer/trips/${tripId}/fare-confirm`, {}, customer.token);
  assert.equal(fareConfirm.status, 200);
  assert.ok(fareConfirm.json.trip.fareConfirmedAt);

  const rate = await api('POST', `/api/customer/trips/${tripId}/rate`, { stars: 5, tipAmount: 10 }, customer.token);
  assert.equal(rate.status, 200);
  assert.equal(rate.json.trip.rating, 5);
  assert.equal(rate.json.trip.tipAmount, 10);

  const earnings = await api('GET', '/api/driver/earnings', null, driver.token);
  assert.equal(earnings.status, 200);
  assert.equal(earnings.json.completedTrips, 1);
  assert.ok(earnings.json.total > 0);
  assert.equal(earnings.json.tipsTotal, 10);

  const history = await api('GET', '/api/customer/trips', null, customer.token);
  assert.ok(history.json.some((t) => t.id === tripId));

  const tracker = await api('GET', `/api/public/trips/${tripId}/live`);
  assert.equal(tracker.status, 200);
  assert.equal(tracker.json.status, 'completed');
  // Rating a cash trip re-settles the fare to include the tip.
  assert.equal(tracker.json.finalFare, rate.json.trip.finalFare);

  await api('POST', '/api/driver/online', { isOnline: false }, driver.token);
  const offlineBook = await api('POST', '/api/customer/trips', {
    pickup: { lat: -25.7461, lng: 28.1881, address: 'Pretoria' },
    destination: { lat: -25.7461, lng: 28.25, address: 'Centurion' },
    paymentMethod: 'cash',
  }, customer.token);
  assert.equal(offlineBook.status, 409);
  assert.equal(offlineBook.json.code, 'DRIVER_OFFLINE');
});

test('scheduled rides: book while offline, driver activates, customer cancels the other', async () => {
  const driver = ensureDriver();
  const customer = await login('+27730004444', 'customer', 'Zinhle', 'z@x.za');

  await api('POST', '/api/driver/online', { isOnline: false }, driver.token);

  const sched = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
    scheduledAt: '2099-01-01T08:00:00Z',
  }, customer.token);
  assert.equal(sched.status, 201);
  assert.equal(sched.json.trip.status, 'scheduled');
  const schedId = sched.json.trip.id;

  const upcoming = await api('GET', '/api/customer/trips/upcoming', null, customer.token);
  assert.ok(upcoming.json.trips.some((t) => t.id === schedId));

  await api('POST', '/api/driver/online', { isOnline: true }, driver.token);
  const driverList = await api('GET', '/api/driver/scheduled-trips', null, driver.token);
  assert.ok(driverList.json.trips.some((t) => t.id === schedId));

  const act = await api('POST', `/api/driver/trips/${schedId}/activate`, {}, driver.token);
  assert.equal(act.status, 200);
  assert.equal(act.json.trip.status, 'requested');

  const sched2 = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
    scheduledAt: '2099-03-01T08:00:00Z',
  }, customer.token);
  const cancelled = await api('POST', `/api/customer/trips/${sched2.json.trip.id}/cancel`, { reason: 'Changed my mind' }, customer.token);
  assert.equal(cancelled.json.trip.status, 'cancelled');
});

test('driver admin settings round-trip', async () => {
  const driver = ensureDriver();

  const get = await api('GET', '/api/driver/settings', null, driver.token);
  assert.equal(get.status, 200);
  assert.ok('platform_fee_percent' in get.json.settings);
  assert.ok('auto_offline_grace_ms' in get.json.settings);

  const put = await api('PUT', '/api/driver/settings', {
    platform_fee_percent: 12.5, auto_offline_grace_ms: 120000,
  }, driver.token);
  assert.equal(put.status, 200);
  const saved = Object.fromEntries(put.json.saved.map((r) => [r.key, r.value]));
  assert.equal(Number(saved.platform_fee_percent), 12.5);
  assert.equal(Number(saved.auto_offline_grace_ms), 120000);

  const bad = await api('PUT', '/api/driver/settings', { platform_fee_percent: 150 }, driver.token);
  assert.equal(bad.status, 400);
});

test('driver-only routes reject a customer token', async () => {
  const customer = await login('+27730005555', 'customer', 'Lerato', 'l@x.za');
  const res = await api('GET', '/api/driver/pending-trip', null, customer.token);
  assert.equal(res.status, 403);
});

test('driver onboarding + admin approval/rejection over HTTP', async () => {
  const admin = ensureAdmin();

  // A stranger signs up as a driver and submits vetting documents.
  const applicant = await login('+27829998888', 'driver', 'Nomsa', 'n@x.za');
  assert.equal(applicant.user.driverStatus, 'pending');

  const fd = new FormData();
  fd.append('idNumber', '9001015800088');
  fd.append('idCopy', new Blob(['fake-id-jpeg'], { type: 'image/jpeg' }), 'id.jpg');
  fd.append('selfie', new Blob(['fake-selfie-png'], { type: 'image/png' }), 'selfie.png');
  fd.append('proofOfResidence', new Blob(['fake-po-pdf'], { type: 'application/pdf' }), 'po.pdf');

  const reg = await fetch(`${BASE}/api/driver/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${applicant.token}` },
    body: fd,
  });
  const regJson = await reg.json();
  assert.equal(reg.status, 201, JSON.stringify(regJson));
  assert.equal(regJson.application.idNumber, '9001015800088');
  assert.ok(regJson.application.idCopyUrl, 'id copy stored');
  assert.equal(regJson.driverStatus, 'pending');

  // A pending driver cannot go online or use operational driver routes.
  const online = await api('POST', '/api/driver/online', { isOnline: true }, applicant.token);
  assert.equal(online.status, 403);

  // The pending applicant sees their own status.
  const app = await api('GET', '/api/driver/application', null, applicant.token);
  assert.equal(app.status, 200);
  assert.equal(app.json.driverStatus, 'pending');

  // Only an admin can see applications and approve them.
  const forbidden = await api('GET', '/api/admin/drivers', null, applicant.token);
  assert.equal(forbidden.status, 403);

  const list = await api('GET', '/api/admin/drivers', null, admin.token);
  assert.equal(list.status, 200);
  const entry = list.json.drivers.find((d) => d.user.id === applicant.user.id);
  assert.ok(entry, 'applicant visible to admin');
  assert.equal(entry.user.driverStatus, 'pending');
  assert.ok(entry.application.idNumber);

  const approve = await api('POST', `/api/admin/drivers/${applicant.user.id}/approve`, null, admin.token);
  assert.equal(approve.status, 200);
  assert.equal(approve.json.driver.status === 'approved' || approve.json.driver.driverStatus === 'approved', true);
  assert.ok(approve.json.wallet, 'wallet created on approval');

  // Approved driver can now go online.
  const onlineOk = await api('POST', '/api/driver/online', { isOnline: true }, applicant.token);
  assert.equal(onlineOk.status, 200);
  assert.equal(onlineOk.json.isOnline, true);
  const wallet = await api('GET', '/api/driver/wallet', null, applicant.token);
  assert.equal(wallet.status, 200);
  assert.equal(wallet.json.wallet.availableCents, 0);

  // Rejection flow for a second applicant.
  const rejected = await login('+27829997777', 'driver', 'Bheki', 'b@x.za');
  const fd2 = new FormData();
  fd2.append('idNumber', '9110105800088');
  fd2.append('selfie', new Blob(['fake-png'], { type: 'image/png' }), 'selfie.png');
  await fetch(`${BASE}/api/driver/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rejected.token}` },
    body: fd2,
  });
  const rej = await api('POST', `/api/admin/drivers/${rejected.user.id}/reject`, { reason: 'Documents unreadable' }, admin.token);
  assert.equal(rej.status, 200);
  assert.equal(rej.json.driver.driverStatus, 'rejected');
  assert.equal(rej.json.driver.rejectionReason, 'Documents unreadable');
  const myApp = await api('GET', '/api/driver/application', null, rejected.token);
  assert.equal(myApp.json.driverStatus, 'rejected');
  assert.equal(myApp.json.rejectionReason, 'Documents unreadable');

  // A pending driver who has not submitted documents cannot be approved.
  const noDocs = await login('+27829996666', 'driver', 'Mpho', 'm@x.za');
  assert.equal(noDocs.user.driverStatus, 'pending');
  const noApprove = await api('POST', `/api/admin/drivers/${noDocs.user.id}/approve`, null, admin.token);
  assert.equal(noApprove.status, 409);
  assert.ok(String(noApprove.json.error).toLowerCase().includes('documents'), 'explains why');

  // A bad SA ID is rejected at submission time.
  const badId = await login('+27829995555', 'driver', 'Zanele', 'z@x.za');
  const fdBad = new FormData();
  fdBad.append('idNumber', '9001015800082'); // wrong check digit
  fdBad.append('selfie', new Blob(['fake-png'], { type: 'image/png' }), 'selfie.png');
  const badReg = await fetch(`${BASE}/api/driver/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${badId.token}` },
    body: fdBad,
  });
  assert.equal(badReg.status, 400, 'invalid SA ID rejected');
});