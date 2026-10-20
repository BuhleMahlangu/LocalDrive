// Fare dispute lifecycle: customer raises it on a completed trip, the owner
// reviews + resolves it, and both sides always see camelCase mapped records
// (never raw snake_case rows). In-memory DB in its own process.

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../src/db/repository');

const driver = repo.createUser({ phone: '+27831110001', name: 'Driver Kabelo', role: 'driver' });
const customer = repo.createUser({ phone: '+27831110002', name: 'Customer Zanele', role: 'customer' });

function completedTrip(fare) {
  const trip = repo.createTrip({
    customerId: customer.id,
    driverId: driver.id,
    pickup: { address: 'Thubelihle, Kriel', lat: -26.2155, lng: 29.2916 },
    destination: { address: 'Kriel Power Station', lat: -26.2, lng: 29.3 },
    status: 'completed',
    fareEstimate: fare,
  });
  repo.updateTrip(trip.id, { status: 'completed', final_fare: fare, completed_at: new Date().toISOString() });
  return repo.getTripById(trip.id);
}

test('a dispute carries trip + customer context in camelCase', () => {
  const trip = completedTrip(85);
  const dispute = repo.createDispute({ tripId: trip.id, userId: customer.id, reason: 'Fare higher than estimate' });

  assert.ok(dispute.id.startsWith('disp_') || dispute.id.startsWith('disp'));
  assert.equal(dispute.tripId, trip.id);
  assert.equal(dispute.userId, customer.id);
  assert.equal(dispute.status, 'open');
  assert.equal(dispute.reason, 'Fare higher than estimate');
  assert.ok(dispute.createdAt);
  // Context the admin UI renders without a second lookup.
  assert.equal(dispute.customer.phone, '+27831110002');
  assert.equal(dispute.trip.finalFare, 85);
  assert.equal(dispute.trip.pickupAddress, 'Thubelihle, Kriel');
  assert.equal(dispute.trip.destAddress, 'Kriel Power Station');
});

test('one dispute per open slot: getDisputeByTrip + open list + resolve', () => {
  const trip = completedTrip(120);
  const created = repo.createDispute({ tripId: trip.id, userId: customer.id, reason: 'Wrong route charged' });

  // Trip audit record embeds the dispute.
  const audit = repo.getTripAuditRecord(trip.id);
  assert.equal(audit.dispute.id, created.id);

  // Appears in the open queue with full context.
  const open = repo.listOpenDisputes();
  const found = open.find((d) => d.id === created.id);
  assert.ok(found, 'open dispute is listed');
  assert.equal(found.trip.finalFare, 120);
  assert.equal(found.customer.name, 'Customer Zanele');

  // Resolving stamps status + resolution + timestamp and drops it from the queue.
  const resolved = repo.resolveDispute(created.id, 'Fare adjusted to R100, refund issued');
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolution, 'Fare adjusted to R100, refund issued');
  assert.ok(resolved.resolvedAt);
  assert.equal(repo.listOpenDisputes().some((d) => d.id === created.id), false);

  // Resolving twice is a no-op on status (still resolved, no error).
  const again = repo.resolveDispute(created.id, 'Different note');
  assert.equal(again.status, 'resolved');
  assert.equal(again.resolution, 'Fare adjusted to R100, refund issued');

  // The trip audit now shows the resolved dispute.
  assert.equal(repo.getTripAuditRecord(trip.id).dispute.status, 'resolved');
});
