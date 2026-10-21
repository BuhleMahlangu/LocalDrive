// Driver subscriptions (freemium monetisation): no per-ride commission; the
// owner drives free, every other driver needs an active paid period to go
// online / accept rides. Covers the gate, payment recording (period extension),
// suspension, and the owner-exemption. Real Express app, in-memory SQLite, HTTP
// — same harness as security.test.js.

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const config = require('../src/config');
const repo = require('../src/db/repository');
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
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const TEST_SA_ID = '9001015800088';
function seedDriverDocs(userId) {
  repo.saveDriverApplication(userId, {
    idNumber: TEST_SA_ID,
    idCopyPath: `${userId}_idcopy.jpg`,
    selfiePath: `${userId}_selfie.jpg`,
    proofOfResidencePath: `${userId}_proof.jpg`,
  });
}
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
async function loginCustomer(phone, name) {
  const pin = pinFor(phone);
  const setup = await api('POST', '/api/auth/pin/setup', { phone, pin, role: 'customer', name });
  if (setup.status === 200) {
    seedCustomerIdentity(setup.json.user.id);
    return { token: setup.json.token, user: setup.json.user };
  }
  const res = await api('POST', '/api/auth/pin/login', { phone, pin, role: 'customer' });
  assert.equal(res.status, 200);
  seedCustomerIdentity(res.json.user.id);
  return { token: res.json.token, user: res.json.user };
}

const PICKUP = { lat: -26.2041, lng: 28.0473, address: 'Joburg CBD' };
const DEST = { lat: -26.1076, lng: 28.0567, address: 'Sandton' };

// A plain (non-owner) driver with identity docs but no subscription yet.
function newDriver(phone, name) {
  const user = repo.createUser({ phone, name, role: 'driver' });
  seedDriverDocs(user.id);
  return { token: signToken({ id: user.id, role: 'driver' }), user };
}

// The owner: role 'admin' (mirrors config.driverPhone in production).
function owner() {
  let user = repo.getUserByPhone(config.driverPhone || '+27000000000', 'admin');
  if (!user) user = repo.createUser({ phone: config.driverPhone || '+27000000000', name: 'Owner', role: 'admin' });
  seedDriverDocs(user.id);
  return { token: signToken({ id: user.id, role: 'admin' }), user };
}

test('the owner (role admin) drives free — no subscription required', async () => {
  const me = owner();
  const sub = repo.getSubscription(me.user.id);
  assert.equal(sub.plan, 'free');
  assert.equal(sub.status, 'active');
  assert.equal(sub.active, true);

  const online = await api('POST', '/api/driver/online', { isOnline: true }, me.token);
  assert.equal(online.status, 200);
  assert.equal(online.json.isOnline, true);
});

test('a driver without an active subscription cannot go online (402)', async () => {
  const d = newDriver('+27740000001', 'Unpaid Driver');
  const online = await api('POST', '/api/driver/online', { isOnline: true }, d.token);
  assert.equal(online.status, 402);
  assert.equal(online.json.code, 'SUBSCRIPTION_INACTIVE');
  assert.equal(online.json.subscription.active, false);
  // Offline is always allowed so nobody gets stuck.
  const off = await api('POST', '/api/driver/online', { isOnline: false }, d.token);
  assert.equal(off.status, 200);
  // The driver can still read their own subscription + reason.
  const sub = await api('GET', '/api/driver/subscription', null, d.token);
  assert.equal(sub.status, 200);
  assert.equal(sub.json.subscription.active, false);
});

test('recording a payment activates the plan and extends the period', async () => {
  const d = newDriver('+27740000002', 'Paying Driver');

  const pay = await api('POST', `/api/admin/drivers/${d.user.id}/subscription/payment`, {
    amountCents: 29900, months: 1, method: 'eft', reference: 'EFT-123',
  }, owner().token);
  assert.equal(pay.status, 201);
  assert.equal(pay.json.subscription.active, true);
  assert.equal(pay.json.subscription.plan, 'active');
  assert.ok(new Date(pay.json.subscription.periodEnd).getTime() > Date.now());
  assert.equal(pay.json.payments.length, 1);
  assert.equal(pay.json.payments[0].amountCents, 29900);
  assert.equal(pay.json.payments[0].method, 'eft');

  // Now they may go online.
  const online = await api('POST', '/api/driver/online', { isOnline: true }, d.token);
  assert.equal(online.status, 200);

  // A second payment stacks onto the unexpired period rather than resetting it.
  const firstEnd = new Date(pay.json.subscription.periodEnd).getTime();
  const pay2 = await api('POST', `/api/admin/drivers/${d.user.id}/subscription/payment`, {
    amountCents: 29900, months: 1, method: 'cash',
  }, owner().token);
  assert.equal(pay2.json.payments.length, 2);
  assert.ok(new Date(pay2.json.subscription.periodEnd).getTime() > firstEnd, 'period extended from the old end');
});

test('suspending a subscription blocks the driver and reactivating restores it', async () => {
  const d = newDriver('+27740000003', 'Suspendable Driver');
  const admin = owner();

  await api('POST', `/api/admin/drivers/${d.user.id}/subscription/payment`, {
    amountCents: 29900, months: 1,
  }, admin.token);
  const on = await api('POST', '/api/driver/online', { isOnline: true }, d.token);
  assert.equal(on.status, 200);

  const suspended = await api('POST', `/api/admin/drivers/${d.user.id}/subscription/status`, {
    status: 'suspended',
  }, admin.token);
  assert.equal(suspended.status, 200);
  assert.equal(suspended.json.subscription.active, false);

  // Even with a live period_end, suspended blocks going online.
  const blocked = await api('POST', '/api/driver/online', { isOnline: true }, d.token);
  assert.equal(blocked.status, 402);

  await api('POST', `/api/admin/drivers/${d.user.id}/subscription/status`, {
    status: 'active',
  }, admin.token);
  const back = await api('POST', '/api/driver/online', { isOnline: true }, d.token);
  assert.equal(back.status, 200);
});

test('the accept path is gated too: an unpaid driver cannot claim a booked trip', async () => {
  const d = newDriver('+27740000004', 'Cant Accept');
  const customer = await loginCustomer('+27740000005', 'Buyer');

  const booked = await api('POST', '/api/customer/trips', {
    pickup: PICKUP, destination: DEST, paymentMethod: 'cash',
  }, customer.token);
  assert.equal(booked.status, 201);

  const accept = await api('POST', `/api/driver/trips/${booked.json.trip.id}/accept`, {}, d.token);
  assert.equal(accept.status, 402);
  assert.equal(accept.json.code, 'SUBSCRIPTION_INACTIVE');
  assert.equal(repo.getTripById(booked.json.trip.id).driverId, null, 'the trip is untouched');

  // With a subscription the same driver can claim it.
  await api('POST', `/api/admin/drivers/${d.user.id}/subscription/payment`, {
    amountCents: 29900, months: 1,
  }, owner().token);
  const accept2 = await api('POST', `/api/driver/trips/${booked.json.trip.id}/accept`, {}, d.token);
  assert.equal(accept2.status, 200);
  assert.equal(accept2.json.trip.driverId, d.user.id);
});

test('admin can list subscriptions and set a plan/price', async () => {
  const d = newDriver('+27740000006', 'Planned Driver');
  const admin = owner();

  const list = await api('GET', '/api/admin/subscriptions', null, admin.token);
  assert.equal(list.status, 200);
  assert.ok(list.json.subscriptions.some((s) => s.driverId === d.user.id));

  const set = await api('POST', `/api/admin/drivers/${d.user.id}/subscription/plan`, {
    plan: 'active', priceCents: 49900,
  }, admin.token);
  assert.equal(set.status, 200);
  assert.equal(set.json.subscription.priceCents, 49900);
  assert.equal(set.json.subscription.plan, 'active');

  // The driver list exposes subscription state for the admin console.
  const drivers = await api('GET', '/api/admin/drivers', null, admin.token);
  const entry = drivers.json.drivers.find((x) => x.user.id === d.user.id);
  assert.ok(entry.subscription, 'subscription attached to the driver record');
});
