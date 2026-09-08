const { Router } = require('express');
const repo = require('../db/repository');
const { authRequired, ownerDriverOnly } = require('../middleware');
const tripService = require('../services/trips');
const payments = require('../services/payments');
const pricing = require('../services/pricing');

function driverRoutes({ notify }) {
  const router = Router();
  router.use(authRequired(['driver']));
  router.use(ownerDriverOnly);

  // Update driver profile / rates.
  router.put('/profile', (req, res, next) => {
    try {
      const { name, email, vehicleType, licensePlate, photoUrl, serviceRadiusKm, baseFare, perKmRate, perMinRate } = req.body;
      const updated = repo.updateUserProfile(req.user.id, {
        name, email, vehicle_type: vehicleType, license_plate: licensePlate, photo_url: photoUrl,
        service_radius_km: serviceRadiusKm, base_fare: baseFare, per_km_rate: perKmRate, per_min_rate: perMinRate,
      });
      res.json(updated);
    } catch (e) { next(e); }
  });

  // Go online / offline.
  router.post('/online', (req, res, next) => {
    try {
      const { isOnline } = req.body;
      const driver = repo.setDriverOnline(req.user.id, !!isOnline);
      res.json(driver);
    } catch (e) { next(e); }
  });

  // Report current GPS location (also streamed via socket.io).
  router.post('/location', (req, res, next) => {
    try {
      const { lat, lng, heading, accuracy } = req.body;
      const location = repo.upsertDriverLocation(req.user.id, { lat, lng, heading, accuracy });
      res.json(location);
    } catch (e) { next(e); }
  });

  // Live navigation route (driver -> pickup, or any from/to pair).
  router.post('/route', async (req, res, next) => {
    try {
      const { from, to } = req.body;
      if (!from || !to || typeof from.lat !== 'number' || typeof to.lat !== 'number') {
        return res.status(400).json({ error: 'from and to points are required' });
      }
      const route = await tripService.getRoute({ pickup: from, destination: to });
      res.json(route);
    } catch (e) { next(e); }
  });

  // Manage the service-area pickup spots (owner only, like all driver routes).
  router.get('/spots', (_req, res) => {
    res.json({ spots: repo.listPickupSpots() });
  });

  router.post('/spots', (req, res, next) => {
    try {
      const { name, category, address, lat, lng, note } = req.body;
      if (!name || typeof lat !== 'number' || typeof lng !== 'number') {
        return res.status(400).json({ error: 'name and lat/lng are required' });
      }
      const spot = repo.createPickupSpot({ name, category, address, lat, lng, note });
      res.json({ spot });
    } catch (e) { next(e); }
  });

  router.put('/spots/:id', (req, res, next) => {
    try {
      const { name, category, address, lat, lng, note, sort } = req.body;
      const spot = repo.updatePickupSpot(req.params.id, {
        name, category, address, lat, lng, note, sort,
      });
      if (!spot) return res.status(404).json({ error: 'Spot not found' });
      res.json({ spot });
    } catch (e) { next(e); }
  });

  router.delete('/spots/:id', (req, res, next) => {
    try {
      repo.deletePickupSpot(req.params.id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  router.get('/me', (req, res) => {
    res.json(repo.getUserById(req.user.id));
  });

  // Active trip (accepted/ongoing) for the driver.
  router.get('/active-trip', (req, res) => {
    const trips = repo.getActiveTripsForDriver(req.user.id);
    res.json({ trip: tripService.withCustomerInfo(trips[0] || null) });
  });

  // Pending requested trip (single driver -> one at a time).
  router.get('/pending-trip', (req, res) => {
    res.json({ trip: tripService.withCustomerInfo(repo.getLatestRequestedTrip() || null) });
  });

  // Upcoming scheduled trips (customer pre-booked a time).
  router.get('/scheduled-trips', (req, res) => {
    const trips = repo.getScheduledTripsForDriver().map(tripService.withCustomerInfo);
    res.json({ trips });
  });

  // Start (activate) a scheduled trip -> moves it into the request flow.
  router.post('/trips/:id/activate', (req, res, next) => {
    try {
      const trip = tripService.activateScheduledTrip(req.params.id);
      notify.tripUpdated(trip);
      notify.newTripToDriver(trip, req.user.id, {});
      res.json({ trip });
    } catch (e) { next(e); }
  });

  // Trip history.
  router.get('/trips', (req, res) => {
    const trips = repo.getTripsForDriver(req.user.id).map(tripService.withCustomerInfo);
    res.json(trips);
  });

  // Earnings summary (today / this week / all time, cash only in MVP).
  router.get('/earnings', (req, res) => {
    const trips = repo.getTripsForDriver(req.user.id);
    const nowDate = new Date();
    const todayIso = nowDate.toISOString().slice(0, 10);
    let todayTotal = 0;
    let weekTotal = 0;
    let total = 0;
    let count = 0;
    let weekCount = 0;
    let tipsTotal = 0;
    let ratingSum = 0;
    let ratingCount = 0;
    for (const t of trips) {
      if (t.status !== 'completed' || t.finalFare == null) continue;
      total += t.finalFare;
      count += 1;
      tipsTotal += t.tipAmount || 0;
      const completed = (t.timestamps.completed || '').slice(0, 10);
      if (completed === todayIso) todayTotal += t.finalFare;
      if (isThisWeek(completed)) { weekTotal += t.finalFare; weekCount += 1; }
      if (t.rating != null) { ratingSum += t.rating; ratingCount += 1; }
    }
    res.json({
      today: todayTotal,
      week: weekTotal,
      weeklyTrips: weekCount,
      total,
      completedTrips: count,
      averageFare: count ? pricing.round(total / count) : 0,
      tipsTotal,
      averageRating: ratingCount ? Number((ratingSum / ratingCount).toFixed(2)) : null,
      currency: 'zar',
    });
  });

  // Accept trip request.
  router.post('/trips/:id/accept', async (req, res, next) => {
    try {
      const trip = await tripService.acceptTrip(req.params.id, req.user.id);
      notify.tripAccepted(trip);
      notify.tripUpdated(trip);
      res.json({ trip });
    } catch (e) { next(e); }
  });

  // Decline trip request.
  router.post('/trips/:id/decline', async (req, res, next) => {
    try {
      const trip = await tripService.declineTrip(req.params.id, req.user.id, req.body.reason);
      notify.tripUpdated(trip);
      res.json({ trip });
    } catch (e) { next(e); }
  });

  // Start trip (arrived at pickup).
  router.post('/trips/:id/start', async (req, res, next) => {
    try {
      const trip = await tripService.startTrip(req.params.id, req.user.id);
      notify.tripUpdated(trip);
      res.json({ trip });
    } catch (e) { next(e); }
  });

  // Complete trip.
  router.post('/trips/:id/complete', async (req, res, next) => {
    try {
      const { actualDistanceKm, actualDurationMin } = req.body;
      const result = await tripService.completeTrip(req.params.id, req.user.id, {
        actualDistanceKm, actualDurationMin,
      });
      notify.tripUpdated(result.trip);
      res.json(result);
    } catch (e) { next(e); }
  });

  // Refund a card payment (driver-initiated, e.g. after a dispute or mistake).
  router.post('/trips/:id/refund', async (req, res, next) => {
    try {
      const tripId = req.params.id;
      const result = await payments.refundTripForDriver(req.user.id, tripId);
      notify.paymentUpdated(result.payment, result.trip);
      res.json(result);
    } catch (e) { next(e); }
  });

  return router;
}

// Whether an ISO date (YYYY-MM-DD) falls within the current week (Mon-Sun).
function isThisWeek(dateStr) {
  if (!dateStr) return false;
  const d = new Date(`${dateStr}T00:00:00${localOffsetTz()}`);
  if (Number.isNaN(d.getTime())) return false;
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const sundayEnd = new Date(monday);
  sundayEnd.setDate(monday.getDate() + 6);
  sundayEnd.setHours(23, 59, 59, 999);
  return d >= monday && d <= sundayEnd;
}

function localOffsetTz() {
  const o = -new Date().getTimezoneOffset();
  const sign = o >= 0 ? '+' : '-';
  const abs = Math.abs(o);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${sign}${hh}:${mm}`;
}

module.exports = driverRoutes;
