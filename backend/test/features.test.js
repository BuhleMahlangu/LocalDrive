// Feature tests: saved places + scheduled trips. Runs with an in-memory DB in
// its own process (node --test), so we can exercise repository + service fns.

process.env.DB_FILE = ':memory:';
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../src/db/repository');
const tripService = require('../src/services/trips');

// Ensure a driver + customer exist for trip tests.
const driver = repo.createUser({ phone: '+27830000001', name: 'Driver Thabo', role: 'driver' });
repo.updateUserProfile(driver.id, { service_radius_km: 50, base_fare: 25, per_km_rate: 12, per_min_rate: 2.5 });
repo.setDriverOnline(driver.id, true);
repo.upsertDriverLocation(driver.id, { lat: -26.2155, lng: 29.2916, heading: 0, accuracy: 15 });
const customer = repo.createUser({ phone: '+27830000002', name: 'Customer Naledi', role: 'customer' });

test('save + list + delete a saved place', () => {
  const place = repo.createSavedPlace(customer.id, {
    label: 'Home',
    kind: 'home',
    address: 'Thubelihle, Kriel',
    lat: -26.2155,
    lng: 29.2916,
    note: 'House with white gate',
  });
  assert.ok(place.id);
  assert.equal(place.kind, 'home');
  assert.equal(place.lat, -26.2155);

  const list = repo.listSavedPlaces(customer.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'Home');

  // Home sorts first.
  repo.createSavedPlace(customer.id, { label: 'Work', kind: 'work', address: 'Kriel Power Station', lat: -26.2, lng: 29.3 });
  const ordered = repo.listSavedPlaces(customer.id);
  assert.equal(ordered[0].kind, 'home');
  assert.equal(ordered[1].kind, 'work');

  // Update + delete (scoped to the user).
  repo.updateSavedPlace(place.id, customer.id, { label: 'My new home' });
  assert.equal(repo.getSavedPlaceById(place.id).label, 'My new home');
  repo.deleteSavedPlace(place.id, customer.id);
  assert.equal(repo.getSavedPlaceById(place.id), null);
});

test('scheduled trip is created with status scheduled and stays out of the request queue', async () => {
  const { trip } = await tripService.createTrip({
    customerId: customer.id,
    pickup: { address: 'Home', lat: -26.2155, lng: 29.2916 },
    destination: { address: 'Shop', lat: -26.22, lng: 29.31 },
    scheduledAt: '2099-01-01T08:00:00Z',
  });
  assert.equal(trip.status, 'scheduled');
  assert.equal(trip.scheduledAt, '2099-01-01T08:00:00Z');

  // A scheduled trip should not appear as the latest requested trip.
  const pending = repo.getLatestRequestedTrip();
  assert.equal(pending, null);

  // It should show up in the driver's upcoming list.
  const upcoming = repo.getScheduledTripsForDriver();
  assert.ok(upcoming.some((t) => t.id === trip.id));

  // Activating claims the scheduled ride for the activating driver.
  const activated = tripService.activateScheduledTrip(trip.id, driver.id);
  assert.equal(activated.status, 'accepted');
  assert.equal(activated.driverId, driver.id);
  assert.equal(repo.getLatestRequestedTrip(), null, 'claimed trip is not an open request');
});

test('a scheduled trip can be cancelled before it is activated', async () => {
  const { trip } = await tripService.createTrip({
    customerId: customer.id,
    pickup: { address: 'Home', lat: -26.2155, lng: 29.2916 },
    destination: { address: 'Shop', lat: -26.22, lng: 29.31 },
    scheduledAt: '2099-02-01T08:00:00Z',
  });
  assert.equal(trip.status, 'scheduled');

  const cancelled = await tripService.cancelTrip(trip.id, 'customer', 'Changed my mind');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.cancelReason, 'Changed my mind');

  // Once cancelled it leaves the driver's upcoming list.
  const upcoming = repo.getScheduledTripsForDriver();
  assert.equal(upcoming.some((x) => x.id === trip.id), false);
});

test('immediate trip still requires an online driver', async () => {
  // Driver offline: immediate booking rejected.
  repo.setDriverOnline(driver.id, false);
  const avail = tripService.checkAvailabilityForPickup({ lat: -26.2155, lng: 29.2916 });
  assert.equal(avail.ok, false);
  assert.equal(avail.code, 'DRIVER_OFFLINE');

  // ...but a scheduled trip for the future passes the availability gate.
  const scheduled = tripService.checkAvailabilityForPickup({ lat: -26.2155, lng: 29.2916 }, '2099-01-01T08:00:00Z');
  assert.equal(scheduled.ok, true);

  repo.setDriverOnline(driver.id, true);
});