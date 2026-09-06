const repo = require('../db/repository');
const config = require('../config');
const pricing = require('./pricing');
const { uid, now, estimatedRoadKm, isWithinService } = require('../utils/geo');

// Resolves a route to distance (km) and duration (min).
// Uses Google Directions API if a key is configured, else a straight-line estimate.
async function getRoute({ pickup, destination }) {
  if (config.googleMapsApiKey) {
    try {
      const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${pickup.lat},${pickup.lng}&destination=${destination.lat},${destination.lng}&mode=driving&key=${config.googleMapsApiKey}`;
      const resp = await fetch(url);
      const data = await resp.json();
      if (data.routes && data.routes.length) {
        const leg = data.routes[0].legs[0];
        return {
          distanceKm: leg.distance.value / 1000,
          durationMin: leg.duration.value / 60,
          polyline: data.routes[0].overview_polyline.points,
        };
      }
    } catch (e) {
      console.warn('[route] Directions API error, falling back to estimate:', e.message);
    }
  }
  const distanceKm = estimatedRoadKm(
    pickup.lat, pickup.lng, destination.lat, destination.lng,
  );
  return { distanceKm, durationMin: Math.max(2, distanceKm * 2 + 5), polyline: null };
}

async function createTrip({ customerId, pickup, destination, priceModel = 'distance_time', paymentMethod = 'cash' }) {
  const driver = repo.getDriver();
  const customer = repo.getUserById(customerId);
  if (!driver || !customer) {
    const err = new Error('Booking is currently unavailable');
    err.status = 404;
    throw err;
  }

  // Driver must be online to accept new bookings at all.
  if (!driver.isOnline) {
    const err = new Error('Driver unavailable, try again later');
    err.status = 409;
    err.code = 'DRIVER_OFFLINE';
    throw err;
  }

  const route = await getRoute({ pickup, destination });
  const estimate = pricing.estimateFare({
    baseFare: driver.baseFare,
    perKmRate: driver.perKmRate,
    perMinRate: driver.perMinRate,
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
  });

  const trip = repo.createTrip({
    id: uid('trip'),
    customerId,
    status: 'requested',
    pickup,
    destination,
    routePolyline: route.polyline,
    distanceKm: pricing.round(route.distanceKm),
    durationMin: pricing.round(route.durationMin),
    fareEstimate: pricing.round(estimate.total),
    priceModel,
    paymentMethod,
  });

  return { trip, estimate, driverPublic: publicDriver(driver) };
}

// Check geofencing before dispatch: driver must be online + within (service radius + pickup distance).
function checkAvailabilityForPickup(pickup) {
  const driver = repo.getDriver();
  if (!driver || !driver.isOnline) return { ok: false, code: 'DRIVER_OFFLINE' };
  const loc = repo.getDriverLocation(driver.id);
  if (!loc) return { ok: true, code: null }; // no location yet; allow booking, driver handles it
  const { ok, distKm } = isWithinService(
    driver.serviceRadiusKm, loc.lat, loc.lng, pickup.lat, pickup.lng,
  );
  return ok
    ? { ok: true, code: null, distKm }
    : { ok: false, code: 'OUT_OF_RANGE', distKm: pricing.round(distKm) };
}

async function acceptTrip(tripId, driverId) {
  const trip = repo.getTripById(tripId);
  if (!trip || trip.status !== 'requested') {
    const err = new Error('Trip is no longer available');
    err.status = 409;
    throw err;
  }
  // Only the single driver can accept.
  const driver = repo.getDriver();
  if (!driver || driver.id !== driverId) {
    const err = new Error('Unauthorized driver');
    err.status = 403;
    throw err;
  }
  const updated = repo.updateTrip(tripId, { driver_id: driverId, status: 'accepted', accepted_at: now() });
  return updated;
}

async function declineTrip(tripId, driverId, reason) {
  const trip = repo.getTripById(tripId);
  if (!trip || trip.status !== 'requested') {
    const err = new Error('Trip is no longer available');
    err.status = 409;
    throw err;
  }
  return repo.updateTrip(tripId, {
    status: 'cancelled',
    cancel_reason: reason || 'Declined by driver',
    cancel_actor: 'driver',
    cancelled_at: now(),
  });
}

async function startTrip(tripId, driverId) {
  const trip = repo.getTripById(tripId);
  if (!trip || trip.driverId !== driverId || trip.status !== 'accepted') {
    const err = new Error('Cannot start this trip');
    err.status = 409;
    throw err;
  }
  return repo.updateTrip(tripId, { status: 'ongoing', started_at: now() });
}

// Complete the trip: final fare = estimate (distance/time model). Create a payment.
async function completeTrip(tripId, driverId, { actualDistanceKm, actualDurationMin, tipAmount } = {}) {
  const trip = repo.getTripById(tripId);
  if (!trip || trip.driverId !== driverId || trip.status !== 'ongoing') {
    const err = new Error('Cannot complete this trip');
    err.status = 409;
    throw err;
  }

  const driver = repo.getDriver();
  const estimate = pricing.estimateFare({
    baseFare: driver.baseFare,
    perKmRate: driver.perKmRate,
    perMinRate: driver.perMinRate,
    distanceKm: actualDistanceKm ?? trip.distanceKm,
    durationMin: actualDurationMin ?? trip.durationMin,
    tipAmount: tipAmount ?? trip.tipAmount,
  });

  const updated = repo.updateTrip(tripId, {
    status: 'completed',
    completed_at: now(),
    final_fare: estimate.total,
    tip_amount: estimate.tipAmount,
    distance_km: actualDistanceKm ?? trip.distanceKm,
    duration_min: actualDurationMin ?? trip.durationMin,
  });

  // Create the payment record (cash by default; card paid via Yoco later).
  const payment = repo.createPayment({
    tripId,
    amountCents: pricing.dollarsToCents(estimate.total),
    provider: trip.paymentMethod === 'card' ? 'yoco' : 'cash',
    currency: config.currency,
  });

  return { trip: updated, payment };
}

async function cancelTrip(tripId, actor, reason) {
  const trip = repo.getTripById(tripId);
  if (!trip) {
    const err = new Error('Trip not found');
    err.status = 404;
    throw err;
  }
  const cancellable = ['requested', 'accepted'];
  if (!cancellable.includes(trip.status)) {
    const err = new Error('This trip cannot be cancelled');
    err.status = 409;
    throw err;
  }
  return repo.updateTrip(tripId, {
    status: 'cancelled',
    cancel_reason: reason || 'Cancelled',
    cancel_actor: actor,
    cancelled_at: now(),
  });
}

async function rateTrip(tripId, customerId, stars, tipAmount) {
  const trip = repo.getTripById(tripId);
  if (!trip || trip.customerId !== customerId || trip.status !== 'completed') {
    const err = new Error('Cannot rate this trip');
    err.status = 409;
    throw err;
  }
  if (stars != null) {
    if (stars < 1 || stars > 5) {
      const err = new Error('Rating must be between 1 and 5');
      err.status = 400;
      throw err;
    }
    repo.updateTrip(tripId, { rating: stars });
    if (trip.driverId) repo.addRating(trip.driverId, stars);
  }
  if (tipAmount != null) {
    const driver = repo.getDriver();
    const estimate = pricing.estimateFare({
      baseFare: driver.baseFare,
      perKmRate: driver.perKmRate,
      perMinRate: driver.perMinRate,
      distanceKm: trip.distanceKm,
      durationMin: trip.durationMin,
      tipAmount,
    });
    repo.updateTrip(tripId, { tip_amount: estimate.tipAmount, final_fare: estimate.total });
    const payment = repo.getPaymentByTrip(tripId);
    // Cash trips are finalised here (money handed over during the ride). Card
    // trips stay pending until Yoco confirms the charge via webhook/confirm.
    if (payment && payment.provider === 'cash') repo.markPaymentSucceeded(tripId, {
      driverPayoutCents: pricing.dollarsToCents(estimate.total),
      platformFeeCents: 0,
    });
  }
  return repo.getTripById(tripId);
}

function publicDriver(driver) {
  return {
    id: driver.id,
    name: driver.name,
    phone: driver.phone,
    photoUrl: driver.photoUrl,
    vehicleType: driver.vehicleType,
    licensePlate: driver.licensePlate,
    rating: driver.rating,
    ratingCount: driver.ratingCount,
    baseFare: driver.baseFare,
    perKmRate: driver.perKmRate,
  };
}

// Attach customer contact info to a trip for the driver's view.
function withCustomerInfo(trip) {
  if (!trip) return trip;
  const c = repo.getUserById(trip.customerId);
  if (c) {
    trip.customerName = c.name;
    trip.customerPhone = c.phone;
  }
  return trip;
}

// Attach driver contact info to a trip for the customer's view.
function withDriverInfo(trip) {
  if (!trip || !trip.driverId) return trip;
  const d = repo.getUserById(trip.driverId);
  if (d) trip.driverPublic = publicDriver(d);
  return trip;
}

module.exports = {
  createTrip,
  checkAvailabilityForPickup,
  acceptTrip,
  declineTrip,
  startTrip,
  completeTrip,
  cancelTrip,
  rateTrip,
  publicDriver,
  withCustomerInfo,
  withDriverInfo,
  getRoute,
};
