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
  // `getDriver()` is the platform rate card (representative pricing + booking
  // preview). Actual dispatch goes to every online approved driver.
  const driver = repo.getDriver();
  const customer = repo.getUserById(customerId);
  if (!driver || !customer) {
    const err = new Error('Booking is currently unavailable');
    err.status = 404;
    throw err;
  }

  const isScheduled = !!scheduledAt;

  // Any approved driver must be online to accept new *immediate* bookings.
  // Scheduled trips are queued for later, so we don't require a driver online now.
  if (!isScheduled && !repo.hasOnlineDriver()) {
    const err = new Error('No drivers available, try again later');
    err.status = 409;
    err.code = 'DRIVER_OFFLINE';
    throw err;
  }

  const route = await getRoute({ pickup, destination });
  const fare = pricing.estimateFare({
    baseFare: driver.baseFare,
    perKmRate: driver.perKmRate,
    perMinRate: driver.perMinRate,
    distanceKm: route.distanceKm,
    durationMin: route.durationMin,
  });

  // Apply a promo discount to the *payable* fare. The discounted total is what
  // the customer sees in the fare breakdown preview and what they actually pay.
  // `fare_estimate` on the trip keeps the undiscounted subtotal so the receipt
  // can show the original estimate struck through against the final fare.
  let appliedPromo = null;
  let discountPercent = 0;
  if (promoCode) {
    const valid = validatePromo(promoCode);
    if (valid.ok) {
      appliedPromo = valid.promo;
      discountPercent = valid.promo.discount_percent;
    }
  }
  const discounted = pricing.applyPromoDiscount(fare.subtotal, discountPercent, driver.baseFare);
  const estimate = {
    ...fare,
    discount: discounted.discount,
    promoCode: appliedPromo ? appliedPromo.code : null,
    promoPercent: discountPercent,
    total: discounted.total,
  };

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
    fareEstimate: pricing.round(fare.subtotal),
    promoCode: appliedPromo?.code || null,
    promoPercent: discountPercent,
    priceModel,
    paymentMethod,
  });

  // Consume the promo use (only on immediate bookings; scheduled trips consume
  // it when actually activated to avoid holding it for a ride that never happens).
  if (appliedPromo && !isScheduled) repo.usePromo(appliedPromo.id);

  return { trip, estimate, driverPublic: publicDriver(driver) };
}

// A driver activating a pre-booked ride claims it for themselves. Returns the
// trip or null if another driver got there first (atomic guarded claim).
// Any promo code attached to the scheduled ride is consumed at this point
// (not when the ride is first booked) to avoid holding a slot on a ride that
// may never happen.
function activateScheduledTrip(tripId, driverId) {
  const trip = repo.activateScheduledTripClaim(tripId, driverId);
  if (trip && trip.promoCode) {
    const promo = repo.getPromoByCode(trip.promoCode);
    if (promo) repo.usePromo(promo.id);
  }
  return trip;
}

// Check geofencing before dispatch: at least one approved driver must be online
// and — if any of them have reported a location — one must be within
// (service radius + pickup distance). The vehicles' reported positions are the
// fairest signal we have for "is someone near this pickup".
function checkAvailabilityForPickup(pickup, scheduledAt) {
  // Immediate trips need at least one approved driver ONLINE right now. Scheduled
  // trips only need the platform to have vetted drivers (they get activated
  // when the time comes, by whichever driver is around then).
  const drivers = scheduledAt ? repo.getAllActiveDrivers() : repo.listOnlineDrivers();
  if (!drivers.length) return { ok: false, code: scheduledAt ? 'NO_DRIVER' : 'DRIVER_OFFLINE' };

  // No driver has streamed a location yet — allow the booking; the drivers
  // handle pickup via their own navigation.
  const located = drivers
    .map((d) => ({ driver: d, loc: repo.getDriverLocation(d.id) }))
    .filter((x) => x.loc && typeof x.loc.lat === 'number' && typeof x.loc.lng === 'number')
    .map(({ driver, loc }) => {
      const { ok, distKm } = isWithinService(
        driver.serviceRadiusKm, loc.lat, loc.lng, pickup.lat, pickup.lng,
      );
      return { ok, distKm };
    });
  if (!located.length) return { ok: true, code: null };

  const nearest = located.sort((a, b) => a.distKm - b.distKm)[0];
  return nearest.ok
    ? { ok: true, code: null, distKm: pricing.round(nearest.distKm) }
    : { ok: false, code: 'OUT_OF_RANGE', distKm: pricing.round(nearest.distKm) };
}

async function acceptTrip(tripId, driverId) {
  // Atomic first-wins claim: if another driver already accepted (or the
  // customer cancelled), claimTrip returns null and the loser gets a 409.
  const updated = repo.claimTrip(tripId, driverId);
  if (!updated) {
    const err = new Error('Trip is no longer available');
    err.status = 409;
    throw err;
  }
  return updated;
}

async function declineTrip(tripId, _driverId, _reason) {
  // Multi-driver dispatch: a decline is a *dismissal for this driver only* — the
  // request stays live for the other online drivers until one claims it or the
  // customer cancels. The trip state is intentionally left untouched.
  return { trip: repo.getTripById(tripId), declined: true };
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
  const fare = pricing.estimateFare({
    baseFare: driver.baseFare,
    perKmRate: driver.perKmRate,
    perMinRate: driver.perMinRate,
    distanceKm: actualDistanceKm ?? trip.distanceKm,
    durationMin: actualDurationMin ?? trip.durationMin,
  });
  // Apply any promo code the customer booked with: the discount applies to the
  // fare (not the tip), then the tip is added on top.
  const discounted = pricing.applyPromoDiscount(fare.subtotal, trip.promoPercent, driver.baseFare);
  const tip = pricing.round(Number(tipAmount ?? trip.tipAmount ?? 0));
  const total = pricing.round(discounted.total + tip);

  const updated = repo.updateTrip(tripId, {
    status: 'completed',
    completed_at: now(),
    final_fare: total,
    tip_amount: tip,
    distance_km: actualDistanceKm ?? trip.distanceKm,
    duration_min: actualDurationMin ?? trip.durationMin,
  });

  // Create the payment record. Cash trips are settled now (money handed
  // directly to the driver). Card trips stay pending until the customer
  // completes the hosted Yoco checkout.
  const platformFeeCents = Math.round(pricing.dollarsToCents(total) * (platformFeePercent() / 100));
  repo.createPayment({
    tripId,
    amountCents: pricing.dollarsToCents(total),
    provider: trip.paymentMethod === 'card' ? 'yoco' : 'cash',
    currency: config.currency,
  });

  if (trip.paymentMethod !== 'card') {
    repo.markPaymentSucceeded(tripId, {
      driverPayoutCents: pricing.dollarsToCents(total) - platformFeeCents,
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
    const fare = pricing.estimateFare({
      baseFare: driver.baseFare,
      perKmRate: driver.perKmRate,
      perMinRate: driver.perMinRate,
      distanceKm: trip.distanceKm,
      durationMin: trip.durationMin,
    });
    const discounted = pricing.applyPromoDiscount(fare.subtotal, trip.promoPercent, driver.baseFare);
    const tip = pricing.round(Number(tipAmount));
    const total = pricing.round(discounted.total + tip);
    repo.updateTrip(tripId, { tip_amount: tip, final_fare: total });
    // Keep the payment record in sync with the new total when the trip is
    // cash (card amounts are fixed at checkout time and can't be adjusted
    // retrospectively — a tip on a card trip is informational only).
    const payment = repo.getPaymentByTrip(tripId);
    if (payment && payment.provider === 'cash') {
      repo.updatePaymentAmount(tripId, pricing.dollarsToCents(total));
      if (payment.status !== 'succeeded') {
        const platformFeeCents = Math.round(pricing.dollarsToCents(total) * (platformFeePercent() / 100));
        repo.markPaymentSucceeded(tripId, {
          driverPayoutCents: pricing.dollarsToCents(total) - platformFeeCents,
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
