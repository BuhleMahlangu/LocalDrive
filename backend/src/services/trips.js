const repo = require('../db/repository');
const config = require('../config');
const pricing = require('./pricing');
const { uid, now, estimatedRoadKm, isWithinService } = require('../utils/geo');

// Validate a promo code: active, not expired, under use cap.
function validatePromo(code) {
  if (!code) return { ok: true };
  const promo = repo.getPromoByCode(String(code).trim().toUpperCase());
  if (!promo) return { ok: false, error: 'This promo code is not valid' };
  if (!promo.active) return { ok: false, error: 'This promo code has been deactivated' };
  if (new Date(promo.valid_from) > new Date()) return { ok: false, error: 'This promo code is not active yet' };
  if (promo.valid_until && new Date(promo.valid_until) < new Date()) return { ok: false, error: 'This promo code has expired' };
  if (promo.used_count >= promo.max_uses) return { ok: false, error: 'This promo code has reached its usage limit' };
  return { ok: true, promo };
}

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

async function createTrip({ customerId, pickup, destination, priceModel = 'distance_time', paymentMethod = 'cash', scheduledAt = null, promoCode = null }) {
  const driver = repo.getDriver();
  const customer = repo.getUserById(customerId);
  if (!driver || !customer) {
    const err = new Error('Booking is currently unavailable');
    err.status = 404;
    throw err;
  }

  const isScheduled = !!scheduledAt;

  // Driver must be online to accept new *immediate* bookings. Scheduled trips
  // are queued for later, so we don't require the driver to be online now.
  if (!isScheduled && !driver.isOnline) {
    const err = new Error('Driver unavailable, try again later');
    err.status = 409;
    err.code = 'DRIVER_OFFLINE';
    throw err;
  }

  const route = await getRoute({ pickup, destination });
  let estimate = pricing.estimateFare({
    baseFare: driver.baseFare,
    perKmRate: driver.perKmRate,
    perMinRate: driver.perMinRate,
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
  });

  // Apply a promo discount to the estimate (shown to the customer as a
  // "promo discount" line in the fare breakdown).
  let discountAmount = 0;
  let appliedPromo = null;
  if (promoCode) {
    const valid = validatePromo(promoCode);
    if (valid.ok) {
      const p = valid.promo;
      discountAmount = Math.round(estimate.total * (p.discount_percent / 100) * 100) / 100;
      estimate = { ...estimate, discount: discountAmount, promoCode: p.code, promoPercent: p.discount_percent };
      appliedPromo = p;
    }
  }

  const trip = repo.createTrip({
    id: uid('trip'),
    customerId,
    status: isScheduled ? 'scheduled' : 'requested',
    scheduledAt: isScheduled ? scheduledAt : null,
    pickup,
    destination,
    routePolyline: route.polyline,
    distanceKm: pricing.round(route.distanceKm),
    durationMin: pricing.round(route.durationMin),
    fareEstimate: pricing.round(estimate.total),
    priceModel,
    paymentMethod,
  });

  // Consume the promo use (only on immediate bookings; scheduled trips consume
  // it when actually activated to avoid holding it for a ride that never happens).
  if (appliedPromo && !isScheduled) repo.usePromo(appliedPromo.id);

  return { trip, estimate, driverPublic: publicDriver(driver) };
}

// Move a scheduled trip into the live request flow so the driver can accept it.
function activateScheduledTrip(tripId) {
  const trip = repo.getTripById(tripId);
  if (!trip || trip.status !== 'scheduled') {
    const err = new Error('Trip is no longer scheduled');
    err.status = 409;
    throw err;
  }
  return repo.updateTrip(tripId, { status: 'requested' });
}

// Check geofencing before dispatch: driver must be online + within (service radius + pickup distance).
function checkAvailabilityForPickup(pickup, scheduledAt) {
  const driver = repo.getDriver();
  // Scheduled trips are queued for later, so the driver doesn't need to be
  // online right now — only the geofence matters.
  if (!driver) return { ok: false, code: 'NO_DRIVER' };
  if (!scheduledAt && !driver.isOnline) return { ok: false, code: 'DRIVER_OFFLINE' };
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

// Driver has reached the pickup point. The trip stays 'accepted' — this is a
// heads-up so the customer knows to step out, and the driver starts the ride
// (-> ongoing) once the customer is in.
async function arriveAtPickup(tripId, driverId) {
  const trip = repo.getTripById(tripId);
  if (!trip || trip.driverId !== driverId || trip.status !== 'accepted') {
    const err = new Error('Cannot mark arrival on this trip');
    err.status = 409;
    throw err;
  }
  return repo.updateTrip(tripId, { arrived_at: now() });
}

// Customer agrees with the final fare before rating/tipping.
async function confirmFare(tripId, customerId) {
  const trip = repo.getTripById(tripId);
  if (!trip || trip.customerId !== customerId || trip.status !== 'completed') {
    const err = new Error('Cannot confirm the fare for this trip');
    err.status = 409;
    throw err;
  }
  return repo.updateTrip(tripId, { fare_confirmed_at: now() });
}

// Platform fee is runtime-configurable via the admin settings page, falling
// back to the env-configured default.
function platformFeePercent() {
  const setting = repo.getSetting('platform_fee_percent');
  const parsed = parseFloat(setting);
  return Number.isFinite(parsed) ? parsed : config.platformFeePercent;
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

  // Create the payment record. Cash trips are settled now (money handed
  // directly to the driver). Card trips stay pending until the customer
  // completes the hosted Yoco checkout.
  const platformFeeCents = Math.round(pricing.dollarsToCents(estimate.total) * (platformFeePercent() / 100));
  repo.createPayment({
    tripId,
    amountCents: pricing.dollarsToCents(estimate.total),
    provider: trip.paymentMethod === 'card' ? 'yoco' : 'cash',
    currency: config.currency,
  });

  if (trip.paymentMethod !== 'card') {
    repo.markPaymentSucceeded(tripId, {
      driverPayoutCents: pricing.dollarsToCents(estimate.total) - platformFeeCents,
      platformFeeCents,
    });
  }

  return { trip: updated, payment: repo.getPaymentByTrip(tripId) };
}

async function cancelTrip(tripId, actor, reason) {
  const trip = repo.getTripById(tripId);
  if (!trip) {
    const err = new Error('Trip not found');
    err.status = 404;
    throw err;
  }
  const cancellable = ['requested', 'accepted', 'ongoing', 'scheduled'];
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

async function rateTrip(tripId, customerId, stars, tipAmount, feedbackTags) {
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
  if (Array.isArray(feedbackTags) && feedbackTags.length) {
    const clean = feedbackTags.slice(0, 8).map((t) => String(t).trim()).filter(Boolean).slice(0, 8);
    repo.updateTrip(tripId, { feedback_tags: clean.join(',') });
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
    // Keep the payment record in sync with the new total when the trip is
    // cash (card amounts are fixed at checkout time and can't be adjusted
    // retrospectively — a tip on a card trip is informational only).
    const payment = repo.getPaymentByTrip(tripId);
    if (payment && payment.provider === 'cash') {
      repo.updatePaymentAmount(tripId, pricing.dollarsToCents(estimate.total));
      if (payment.status !== 'succeeded') {
const platformFeeCents = Math.round(pricing.dollarsToCents(estimate.total) * (platformFeePercent() / 100));
        repo.markPaymentSucceeded(tripId, {
          driverPayoutCents: pricing.dollarsToCents(estimate.total) - platformFeeCents,
          platformFeeCents,
        });
      }
    }
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
  arriveAtPickup,
  confirmFare,
  completeTrip,
  cancelTrip,
  rateTrip,
  activateScheduledTrip,
  platformFeePercent,
  validatePromo,
  publicDriver,
  withCustomerInfo,
  withDriverInfo,
  getRoute,
};
