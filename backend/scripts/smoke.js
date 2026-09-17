// End-to-end smoke test for the DriveLocal backend.
// Starts nothing itself - assumes the server is already running on PORT.
const PORT = process.env.PORT || 4000;
const BASE = `http://localhost:${PORT}`;

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

function assert(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; throw new Error(msg); }
  console.log('  ok:', msg);
}

async function login(phone, role, name, email) {
  await api('POST', '/api/auth/otp/request', { phone, role });
  const res = await api('POST', '/api/auth/otp/verify', { phone, code: '123456', role, name, email });
  return res;
}

async function main() {
  console.log('== DriveLocal smoke test ==');

  console.log('\n[0] Public pickup spots');
  const spots = await api('GET', '/api/pickup-spots');
  assert(spots.status === 200 && Array.isArray(spots.json.spots) && spots.json.spots.length > 0, 'pickup spots listed');

  console.log('\n[1] Driver goes online');
  const driver = await login('+27000000000', 'driver', 'Thabo', 'd@x.za');
  assert(driver.status === 200 && ['admin', 'driver'].includes(driver.json.user.role), 'driver OTP verify');
  const driverToken = driver.json.token;

  const online = await api('POST', '/api/driver/online', { isOnline: true }, driverToken);
  assert(online.json.isOnline === true, 'driver online');

  const loc = await api('POST', '/api/driver/location', { lat: -26.2041, lng: 28.0473, heading: 90, accuracy: 12 }, driverToken);
  assert(loc.status === 200 && loc.json.lat === -26.2041, 'driver location set');

  const route = await api('POST', '/api/driver/route', { from: { lat: -26.2041, lng: 28.0473 }, to: { lat: -26.2155, lng: 29.2916 } }, driverToken);
  assert(route.status === 200 && typeof route.json.distanceKm === 'number', 'driver navigation route computed');

  // Spot CRUD is admin-only (the owner-driver logs in with role 'admin').
  console.log('\n[2] Pickup spot management');
  const made = await api('POST', '/api/admin/spots', { name: 'Smoke Spot', lat: -26.21, lng: 29.28 }, driverToken);
  assert(made.status === 201 && made.json.spot.id, 'pickup spot created');
  const moved = await api('PUT', `/api/admin/spots/${made.json.spot.id}`, { lat: -26.22, lng: 29.29 }, driverToken);
  assert(moved.status === 200 && Math.abs(moved.json.spot.lat - -26.22) < 1e-6, 'pickup spot moved');
  const renamed = await api('PUT', `/api/admin/spots/${made.json.spot.id}`, { name: 'Smoke Spot Renamed' }, driverToken);
  assert(renamed.status === 200 && renamed.json.spot.name === 'Smoke Spot Renamed', 'pickup spot renamed');
  const removed = await api('DELETE', `/api/admin/spots/${made.json.spot.id}`, null, driverToken);
  assert(removed.status === 200, 'pickup spot deleted');

  console.log('\n[2] Customer availability + estimate');
  const avail = await api('GET', '/api/customer/driver/availability');
  assert(avail.json.isOnline === true, 'availability reports online');

  const est = await api('POST', '/api/customer/estimate', {
    pickup: { lat: -26.2041, lng: 28.0473, address: 'Joburg CBD' },
    destination: { lat: -26.1076, lng: 28.0567, address: 'Sandton' },
  });
  assert(est.status === 200 && est.json.estimate.total > 0, `estimate computed (R${est.json.estimate?.total})`);

  console.log('\n[3] Customer books a trip');
  const customer = await login('+27730002222', 'customer', 'Naledi', 'n@x.za');
  assert(customer.status === 200 && customer.json.user.role === 'customer', 'customer OTP verify');
  const custToken = customer.json.token;

  const book = await api('POST', '/api/customer/trips', {
    pickup: { lat: -26.2041, lng: 28.0473, address: 'Joburg CBD' },
    destination: { lat: -26.1076, lng: 28.0567, address: 'Sandton' },
    paymentMethod: 'cash',
  }, custToken);
  assert(book.status === 201 && book.json.trip.status === 'requested', 'trip created (requested)');
  const tripId = book.json.trip.id;
  const estFare = book.json.estimate.total;
  console.log(`  trip=${tripId} estimate=R${estFare} dist=${book.json.trip.distanceKm}km`);

  console.log('\n[4] Driver sees pending trip, accepts');
  const pending = await api('GET', '/api/driver/pending-trip', null, driverToken);
  assert(pending.json.trip && pending.json.trip.id === tripId, 'driver sees pending trip');

  const accept = await api('POST', `/api/driver/trips/${tripId}/accept`, {}, driverToken);
  assert(accept.json.trip.status === 'accepted', 'driver accepted');
  // acceptTrip is sync in our service; ensure no throw

  console.log('\n[5] Driver starts trip');
  const start = await api('POST', `/api/driver/trips/${tripId}/start`, {}, driverToken);
  assert(start.json.trip.status === 'ongoing', 'trip ongoing');

  console.log('\n[6] Driver completes trip');
  const complete = await api('POST', `/api/driver/trips/${tripId}/complete`, {
    actualDistanceKm: 14.5, actualDurationMin: 28, tipAmount: 0,
  }, driverToken);
  assert(complete.json.trip.status === 'completed', 'trip completed');
  assert(complete.json.payment && complete.json.payment.status === 'succeeded', 'cash payment settled');
  console.log(`  final fare=R${complete.json.trip.finalFare}`);

  console.log('\n[7] Customer rates + tips');
  const rate = await api('POST', `/api/customer/trips/${tripId}/rate`, { stars: 5, tipAmount: 10 }, custToken);
  assert(rate.json.trip.rating === 5, 'customer rated 5');
  assert(rate.json.trip.finalFare > 0 && rate.json.trip.tipAmount === 10, 'tip of R10 applied');

  console.log('\n[8] Driver earnings');
  const earn = await api('GET', '/api/driver/earnings', null, driverToken);
  assert(earn.json.completedTrips >= 1 && earn.json.total > 0, `earnings total R${earn.json.total}`);
  assert(earn.json.weeklyTrips === earn.json.completedTrips, 'weekly trips counted');

  console.log('\n[9] Customer history + re-check availability after offline');
  const history = await api('GET', '/api/customer/trips', null, custToken);
  assert(history.json.length >= 1, 'customer history has trips');

  await api('POST', '/api/driver/online', { isOnline: false }, driverToken);
  const avail2 = await api('GET', '/api/customer/driver/availability');
  assert(avail2.json.isOnline === false, 'availability false when offline');

  console.log('\n[10] Booking rejected when driver offline');
  const cust2 = await login('+27730003333', 'customer');
  const book2 = await api('POST', '/api/customer/trips', {
    pickup: { lat: -25.7461, lng: 28.1881, address: 'Pretoria' },
    destination: { lat: -25.7461, lng: 28.25, address: 'Centurion' },
    paymentMethod: 'cash',
  }, cust2.json.token);
  assert(book2.status === 409 && book2.json.code === 'DRIVER_OFFLINE', 'offline booking rejected');

  console.log('\n[11] Saved places + scheduled trip (new features)');
  const p1 = await api('POST', '/api/customer/places', { label: 'Home', kind: 'home', address: 'Thubelihle, Kriel', lat: -26.2155, lng: 29.2916 }, cust2.json.token);
  assert(p1.status === 201 && p1.json.kind === 'home', 'save place (home)');
  const p2 = await api('POST', '/api/customer/places', { label: 'Work', kind: 'work', address: 'Kriel Power Station', lat: -26.2, lng: 29.3 }, cust2.json.token);
  assert(p2.status === 201, 'save place (work)');
  const places = await api('GET', '/api/customer/places', null, cust2.json.token);
  assert(places.json.length === 2 && places.json[0].kind === 'home', 'places listed homes first');
  const del = await api('DELETE', `/api/customer/places/${p2.json.id}`, null, cust2.json.token);
  assert(del.json.ok === true, 'place deleted');

  // Even with the driver offline, a future scheduled trip can be booked.
  const sched = await api('POST', '/api/customer/trips', {
    pickup: { lat: -26.2041, lng: 28.0473, address: 'Joburg CBD' },
    destination: { lat: -26.1076, lng: 28.0567, address: 'Sandton' },
    paymentMethod: 'cash',
    scheduledAt: '2099-01-01T08:00:00Z',
  }, cust2.json.token);
  assert(sched.status === 201 && sched.json.trip.status === 'scheduled', 'scheduled trip created while offline');
  const upcoming = await api('GET', '/api/customer/trips/upcoming', null, cust2.json.token);
  assert(upcoming.json.trips.some((t) => t.id === sched.json.trip.id), 'scheduled trip in upcoming list');
  const schedId = sched.json.trip.id;

  await api('POST', '/api/driver/online', { isOnline: true }, driverToken);
  const schedList = await api('GET', '/api/driver/scheduled-trips', null, driverToken);
  assert(schedList.json.trips.some((t) => t.id === schedId), 'driver sees scheduled trip');
  const act = await api('POST', `/api/driver/trips/${schedId}/activate`, {}, driverToken);
  assert(act.status === 200 && act.json.trip.status === 'requested', 'driver activated scheduled trip');

  // A second scheduled ride can be cancelled by the customer before activation.
  const sched2 = await api('POST', '/api/customer/trips', {
    pickup: { lat: -26.2041, lng: 28.0473, address: 'Joburg CBD' },
    destination: { lat: -26.1076, lng: 28.0567, address: 'Sandton' },
    paymentMethod: 'cash',
    scheduledAt: '2099-03-01T08:00:00Z',
  }, cust2.json.token);
  assert(sched2.status === 201 && sched2.json.trip.status === 'scheduled', 'second scheduled trip created');
  const cancelled = await api('POST', `/api/customer/trips/${sched2.json.trip.id}/cancel`, { reason: 'Changed my mind' }, cust2.json.token);
  assert(cancelled.status === 200 && cancelled.json.trip.status === 'cancelled', 'scheduled ride cancelled by customer');
  const schedList2 = await api('GET', '/api/driver/scheduled-trips', null, driverToken);
  assert(!schedList2.json.trips.some((t) => t.id === sched2.json.trip.id), 'cancelled ride left the driver list');

  console.log('\nAll smoke tests passed.');
}

main().catch((e) => {
  console.error('\nTest failed:', e.message);
});
