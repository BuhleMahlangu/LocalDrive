// Regression tests for the routing + driver-assignment fixes:
//
//  1. The scheduler releases a due scheduled trip into the request queue instead
//     of trying to claim it for a driver that does not exist.
//  2. /api/customer/driver returns the driver actually assigned to a signed-in
//     customer with a live trip, not the platform's representative rate card.
//  3. The estimate/route path yields a road-following polyline when a routing
//     provider is reachable.
//
// Same harness as integration.test.js: the real Express app against an
// in-memory SQLite DB, driven over HTTP with `fetch`.

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const config = require('../src/config');
const repo = require('../src/db/repository');
const { createApp } = require('../src/app');
const { signToken } = require('../src/middleware');
const tripService = require('../src/services/trips');

const sms = require('../src/services/sms');
sms.send = async () => ({ dev: true });

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
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function login(phone, role, name, email) {
  await api('POST', '/api/auth/otp/request', { phone, role });
  const res = await api('POST', '/api/auth/otp/verify', {
    phone, code: '123456', role, name, email,
  });
  assert.equal(res.status, 200, `otp verify ok for ${phone} (${role})`);
  return { token: res.json.token, user: res.json.user };
}

const DRIVER_PHONE = config.driverPhone || '+27000000000';
const PICKUP = { lat: -26.2041, lng: 28.0473, address: 'Joburg CBD' };
const DEST = { lat: -26.1076, lng: 28.0567, address: 'Sandton' };

function ensureDriver() {
  let driver = repo.getUserByPhone(DRIVER_PHONE, 'driver');
  if (!driver) {
    driver = repo.createUser({ phone: DRIVER_PHONE, name: 'Thabo', email: 'd@x.za', role: 'driver' });
  }
  return { token: signToken({ id: driver.id, role: 'driver' }), user: driver };
}

test('scheduled trip release moves it to the request queue without naming a driver', async () => {
  const driver = ensureDriver();
  const customer = await login('+27731110001', 'customer', 'Nomsa', 'nomsa@x.za');

  await api('POST', '/api/driver/online', { isOnline: true }, driver.token);

  const scheduledAt = new Date(Date.now() - 60_000).toISOString();
  const booked = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash', scheduledAt,
  }, customer.token);
  assert.equal(booked.status, 201);
  assert.equal(booked.json.trip.status, 'scheduled');

  const released = tripService.releaseScheduledTrip(booked.json.trip.id);
  assert.ok(released, 'the due scheduled trip is released');
  assert.equal(released.status, 'requested', 'it lands in the live request queue');
  assert.equal(released.driverId, null, 'no driver is named by the scheduler');

  // Guarded: a second release must not resurrect or re-dispatch the trip.
  const again = tripService.releaseScheduledTrip(booked.json.trip.id);
  assert.equal(again, null, 'releasing twice is a no-op');

  // And it is claimable by a driver afterwards, which is the point of releasing.
  const accepted = await api('POST', `/api/driver/trips/${released.id}/accept`, {}, driver.token);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.trip.driverId, driver.user.id);
});

test('customer/driver returns the assigned driver once a trip is accepted', async () => {
  const driver = ensureDriver();
  const customer = await login('+27731110002', 'customer', 'Sipho', 'sipho@x.za');

  // Before booking: the representative rate-card driver.
  const anon = await api('GET', '/api/customer/driver');
  assert.equal(anon.status, 200);
  assert.equal(anon.json.id, repo.getDriver().id, 'anonymous callers get the rate card driver');

  const before = await api('GET', '/api/customer/driver', null, customer.token);
  assert.equal(before.json.id, repo.getDriver().id, 'no live trip yet, so still the rate card');

  await api('POST', '/api/driver/online', { isOnline: true }, driver.token);
  await api('POST', '/api/driver/location', { lat: -26.2041, lng: 28.0473, accuracy: 12 }, driver.token);

  const booked = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
  }, customer.token);
  assert.equal(booked.status, 201);

  await api('POST', `/api/driver/trips/${booked.json.trip.id}/accept`, {}, driver.token);

  const during = await api('GET', '/api/customer/driver', null, customer.token);
  assert.equal(during.status, 200);
  assert.equal(during.json.id, driver.user.id, 'the customer sees the driver who took the ride');
  assert.equal(during.json.phone, driver.user.phone, 'and their real contact number');
});

test('estimate returns a road polyline when a routing provider is reachable', async () => {
  ensureDriver();
  const res = await api('POST', '/api/customer/estimate', { pickup: PICKUP, destination: DEST });
  assert.equal(res.status, 200);
  assert.ok(res.json.route.distanceKm > 0);
  assert.ok(res.json.route.durationMin > 0);

  // The public OSRM/Grokipedia servers are network-dependent, so only assert the
  // polyline when the provider actually answered. The straight-line fallback
  // (polyline: null) is a legitimate outcome offline.
  if (res.json.route.polyline == null) {
    console.log('[routing] provider unreachable — validated the estimate fallback path only');
    return;
  }
  assert.equal(typeof res.json.route.polyline, 'string');
  assert.ok(res.json.route.polyline.length > 0, 'a road polyline was returned, not a straight line');

  // Precision-5 encoded polyline, which is what app/src/lib/polyline.js decodes.
  const points = decodePrecision5(res.json.route.polyline);
  assert.ok(points.length >= 2, 'polyline decodes to at least two points');
  const first = points[0];
  const last = points[points.length - 1];
  // Road snapping puts the endpoints within a few hundred metres of the pins.
  assert.ok(Math.abs(first[0] - PICKUP.lat) < 0.02, 'polyline starts at the pickup');
  assert.ok(Math.abs(last[1] - DEST.lng) < 0.02, 'polyline ends at the destination');
});

// Minimal port of app/src/lib/polyline.js so the test asserts against the same
// encoding contract the frontend relies on.
function decodePrecision5(encoded) {
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}