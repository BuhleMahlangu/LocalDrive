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
  const customer = await login('+27730003333', 'customer', 'Mandla', 's@x.za');

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

test('multi-driver dispatch: every online driver gets the request, first claim wins, decline is a dismissal', async () => {
  const driverA = ensureDriver();
  let driverB = repo.getUserByPhone('+27826661111', 'driver');
  if (!driverB) {
    driverB = repo.createUser({ phone: '+27826661111', name: 'Sipho', email: 'sip@x.za', role: 'driver' });
  }
  const tokenB = signToken({ id: driverB.id, role: 'driver' });
  const customer = await login('+27730005555', 'customer', 'Zamo', 'zamo@x.za');

  await api('POST', '/api/driver/online', { isOnline: true }, driverA.token);
  await api('POST', '/api/driver/online', { isOnline: true }, tokenB);

  const book = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
  }, customer.token);
  assert.equal(book.status, 201);
  assert.equal(book.json.trip.status, 'requested');
  const tripId = book.json.trip.id;

  // Both online drivers can see the same open request.
  const pendingA = await api('GET', '/api/driver/pending-trip', null, driverA.token);
  assert.equal(pendingA.json.trip.id, tripId);
  const pendingB = await api('GET', '/api/driver/pending-trip', null, tokenB);
  assert.equal(pendingB.json.trip.id, tripId);

  // Declining is per-driver: the request stays live for everyone else.
  const decline = await api('POST', `/api/driver/trips/${tripId}/decline`, { reason: 'Too far' }, driverA.token);
  assert.equal(decline.status, 200);
  assert.equal(decline.json.declined, true);
  const stillPendingB = await api('GET', '/api/driver/pending-trip', null, tokenB);
  assert.equal(stillPendingB.json.trip.id, tripId);

  // Driver B claims it first.
  const acceptB = await api('POST', `/api/driver/trips/${tripId}/accept`, {}, tokenB);
  assert.equal(acceptB.status, 200);
  assert.equal(acceptB.json.trip.status, 'accepted');
  assert.equal(acceptB.json.trip.driverId, driverB.id);

  // The same request is now gone for Driver A (409 on a second accept).
  const acceptA2 = await api('POST', `/api/driver/trips/${tripId}/accept`, {}, driverA.token);
  assert.equal(acceptA2.status, 409);
  const lost = await api('GET', '/api/driver/pending-trip', null, driverA.token);
  assert.equal(lost.json.trip, null);

  // The customer's active trip shows whichever driver won the race.
  const active = await api('GET', '/api/customer/trips/active', null, customer.token);
  assert.equal(active.json.trip.id, tripId);
  assert.equal(active.json.trip.driverId, driverB.id);

  // Take the trip through to completion for a deterministic DB state.
  await api('POST', `/api/driver/trips/${tripId}/start`, {}, tokenB);
  const done = await api('POST', `/api/driver/trips/${tripId}/complete`, {}, tokenB);
  assert.equal(done.json.trip.status, 'completed');
});

test('SOS alerts are recorded, keep a trip link, and surface in the admin audit', async () => {
  const driver = ensureDriver();
  const admin = ensureAdmin();
  const customer = await login('+27730006666', 'customer', 'Khethiwe', 'k@x.za');

  await api('POST', '/api/driver/online', { isOnline: true }, driver.token);
  await api('POST', '/api/driver/location', { lat: -26.2041, lng: 28.0473, accuracy: 12 }, driver.token);

  const book = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
  }, customer.token);
  const tripId = book.json.trip.id;
  await api('POST', `/api/driver/trips/${tripId}/accept`, {}, driver.token);

  // The customer on the trip presses SOS with their live coordinates.
  const sos = await api('POST', '/api/sos', {
    tripId, note: 'Feel unsafe — please check in', lat: -26.2041, lng: 28.0473,
  }, customer.token);
  assert.equal(sos.status, 201);
  assert.equal(sos.json.alert.tripId, tripId);
  assert.ok(sos.json.alert.id);

  // A stranger can't attach an SOS to a trip they aren't part of.
  const stranger = await login('+27730007777', 'customer', 'Bongani', 'b@x.za');
  const notYours = await api('POST', '/api/sos', { tripId }, stranger.token);
  assert.equal(notYours.status, 403);

  // The driver can also raise one on their own trip.
  const driverSos = await api('POST', '/api/sos', { tripId, note: 'Flat tyre' }, driver.token);
  assert.equal(driverSos.status, 201);

  // The owner sees both alerts (with who pressed them) + the driver's last fix.
  const audit = await api('GET', `/api/admin/trips/${tripId}`, null, admin.token);
  assert.equal(audit.status, 200);
  assert.equal(audit.json.trip.sosAlerts.length, 2);
  assert.ok(audit.json.trip.sosAlerts.some((a) => a.userRole === 'customer' && a.userName === 'Khethiwe'));
  assert.ok(audit.json.trip.sosAlerts.some((a) => a.userRole === 'driver' && a.note === 'Flat tyre'));
  assert.ok(audit.json.trip.driverLastLocation && audit.json.trip.driverLastLocation.lat === -26.2041);
});

test('admin can suspend a driver (blocks driver routes) and unsuspend them', async () => {
  const admin = ensureAdmin();
  let driver = repo.getUserByPhone('+27824442222', 'driver');
  if (!driver) {
    driver = repo.createUser({ phone: '+27824442222', name: 'Lerato', email: 'ler@x.za', role: 'driver' });
  }
  const token = signToken({ id: driver.id, role: 'driver' });

  // Approved driver reaches operational endpoints.
  const online = await api('POST', '/api/driver/online', { isOnline: true }, token);
  assert.equal(online.json.isOnline, true);

  const suspend = await api('POST', `/api/admin/drivers/${driver.id}/suspend`, {}, admin.token);
  assert.equal(suspend.status, 200);
  assert.equal(suspend.json.driver.driverStatus, 'suspended');
  assert.equal(suspend.json.driver.isOnline, false);

  // Suspended => hard-blocked from every driver route.
  const blocked = await api('GET', '/api/driver/wallet', null, token);
  assert.equal(blocked.status, 403);

  // Unsuspend restores them and the gate opens again.
  const unsuspend = await api('POST', `/api/admin/drivers/${driver.id}/unsuspend`, {}, admin.token);
  assert.equal(unsuspend.status, 200);
  assert.equal(unsuspend.json.driver.driverStatus, 'approved');
  const wallet = await api('GET', '/api/driver/wallet', null, token);
  assert.equal(wallet.status, 200);
});

test('scheduled rides: book while offline, driver activates, customer cancels the other', async () => {
  const driver = ensureDriver();
  const customer = await login('+27730004444', 'customer', 'Busi', 'z@x.za');

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
  // Activating a scheduled trip claims it for the activating driver in the
  // multi-driver platform (it becomes an accepted, assigned ride — not a bare
  // 'requested' queue entry).
  assert.equal(act.json.trip.status, 'accepted');
  assert.equal(act.json.trip.driverId, driver.user.id);

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

test('in-trip chat: participants can send/read messages, strangers cannot', async () => {
  const driver = ensureDriver();
  await api('POST', '/api/driver/online', { isOnline: true }, driver.token);
  const customer = await login('+27730006666', 'customer', 'Karabo', 'k@x.za');

  const book = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
  }, customer.token);
  assert.equal(book.status, 201);
  const tripId = book.json.trip.id;
  await api('POST', `/api/driver/trips/${tripId}/accept`, {}, driver.token);

  // Customer sends, driver reads.
  const send = await api('POST', `/api/chat/trips/${tripId}/messages`, {
    body: 'Hi, I am outside in a blue shirt.',
  }, customer.token);
  assert.equal(send.status, 201);
  assert.equal(send.json.message.senderId, customer.user.id);
  assert.equal(send.json.message.body, 'Hi, I am outside in a blue shirt.');

  const driverView = await api('GET', `/api/chat/trips/${tripId}/messages`, null, driver.token);
  assert.equal(driverView.status, 200);
  assert.equal(driverView.json.messages.length, 1);
  assert.ok(driverView.json.messages[0].readAt, 'driver reading the thread marks it read');

  // Driver replies, customer reads both.
  const reply = await api('POST', `/api/chat/trips/${tripId}/messages`, {
    body: 'On my way, see you soon.',
  }, driver.token);
  assert.equal(reply.status, 201);

  const customerView = await api('GET', `/api/chat/trips/${tripId}/messages`, null, customer.token);
  assert.equal(customerView.json.messages.length, 2);
  assert.equal(customerView.json.messages[0].body, 'Hi, I am outside in a blue shirt.');
  assert.equal(customerView.json.messages[1].body, 'On my way, see you soon.');

  // Empty messages are rejected.
  const empty = await api('POST', `/api/chat/trips/${tripId}/messages`, { body: '   ' }, customer.token);
  assert.equal(empty.status, 400);

  // A stranger (not a participant) gets 403 on read and write.
  const outsider = await login('+27730007777', 'customer', 'Palesa', 'p@x.za');
  const forbidWrite = await api('POST', `/api/chat/trips/${tripId}/messages`, { body: 'hey' }, outsider.token);
  assert.equal(forbidWrite.status, 403);
  const forbidRead = await api('GET', `/api/chat/trips/${tripId}/messages`, null, outsider.token);
  assert.equal(forbidRead.status, 403);
});

test('admin trip-record audit: search by customer/driver name, status, date, and full detail', async () => {
  const admin = ensureAdmin();

  const c = await login('+27730009999', 'customer', 'Busi', 'z@x.za');
  const d = await login('+27829994444', 'driver', 'Mandla', 's@x.za');

// Two trips involving exactly the customer, only one involving the driver —
  // enough to prove the search joins by name and resolves who was with whom.
  const shared = repo.createTrip({
    customerId: c.user.id,
    driverId: d.user.id,
    status: 'completed',
    pickup: { address: '1 Voortrekker Rd, Pretoria', lat: -26.2044, lng: 28.0416 },
    destination: { address: '2 Marshall St, Johannesburg', lat: -26.2045, lng: 28.0417 },
    distanceKm: 5, durationMin: 15, fareEstimate: 90,
    paymentMethod: 'cash', routePolyline: 'ab_5rXq',
  });
  const solo = repo.createTrip({
    customerId: c.user.id,
    status: 'requested',
    pickup: { address: '3 Kerk St', lat: -26.1, lng: 28.0 },
    destination: { address: '4 Church St', lat: -26.2, lng: 28.1 },
  });
  repo.createTripMessage({ tripId: shared.id, senderId: c.user.id, body: 'Please wait by the gate' });

// The audit trail is owner-only.
  const forbidden = await api('GET', '/api/admin/trips/search?q=Mandla', null, c.token);
  assert.equal(forbidden.status, 403);

  // Search by driver name: the trip Mandla was on, with both identities resolved.
  const byDriver = await api('GET', '/api/admin/trips/search?q=Mandla', null, admin.token);
  assert.equal(byDriver.status, 200);
  assert.ok(byDriver.json.trips.some((t) => t.id === shared.id));
  const row = byDriver.json.trips.find((t) => t.id === shared.id);
  assert.equal(row.customer.name, 'Busi');
  assert.equal(row.customer.phone, '+27730009999');
  assert.equal(row.driver.name, 'Mandla');
  assert.equal(row.driver.phone, '+27829994444');

  // Search by customer name: both her trips come back (with and without a driver).
  const byCustomer = await api('GET', '/api/admin/trips/search?q=Busi', null, admin.token);
  assert.equal(byCustomer.status, 200);
  assert.ok(byCustomer.json.trips.some((t) => t.id === shared.id));
  assert.ok(byCustomer.json.trips.some((t) => t.id === solo.id));

// Exact status filter narrows to completed rides only.
  const completed = await api('GET', '/api/admin/trips/search?q=Busi&status=completed', null, admin.token);
  assert.equal(completed.status, 200);
  assert.deepEqual(completed.json.trips.map((t) => t.id), [shared.id]);

  // Day-range filter (timestamps are stored/served in UTC).
  const today = new Date().toISOString().slice(0, 10);
  const dated = await api('GET', `/api/admin/trips/search?q=Busi&from=${today}&to=${today}`, null, admin.token);
  assert.equal(dated.status, 200);
  assert.ok(dated.json.trips.some((t) => t.id === shared.id));

  // The full record: identities, addresses, coords, and the message thread.
  const detail = await api('GET', `/api/admin/trips/${shared.id}`, null, admin.token);
  assert.equal(detail.status, 200);
  const trip = detail.json.trip;
  assert.equal(trip.customer.name, 'Busi');
  assert.equal(trip.driver.name, 'Mandla');
  assert.equal(trip.pickup.address, '1 Voortrekker Rd, Pretoria');
  assert.equal(trip.destination.address, '2 Marshall St, Johannesburg');
  assert.equal(trip.routePolyline, 'ab_5rXq');
  assert.equal(trip.messages.length, 1);
  assert.equal(trip.messages[0].body, 'Please wait by the gate');
  assert.equal(trip.messages[0].sender.name, 'Busi');
  assert.equal(trip.messages[0].sender.role, 'customer');

  const missing = await api('GET', '/api/admin/trips/does-not-exist', null, admin.token);
  assert.equal(missing.status, 404);
});
