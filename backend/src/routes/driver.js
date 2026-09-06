const express = require('express');
const repo = require('../db/repository');
const { authRequired, ownerDriverOnly } = require('../middleware');
const tripService = require('../services/trips');

function driverRoutes({ notify }) {
  const router = express.Router();
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

  // Trip history.
  router.get('/trips', (req, res) => {
    res.json(repo.getTripsForDriver(req.user.id));
  });

  // Earnings summary (today + all time, cash only in MVP).
  router.get('/earnings', (req, res) => {
    const trips = repo.getTripsForDriver(req.user.id);
    const todayIso = new Date().toISOString().slice(0, 10);
    let todayTotal = 0;
    let total = 0;
    let count = 0;
    for (const t of trips) {
      if (t.status === 'completed' && t.finalFare != null) {
        total += t.finalFare;
        count += 1;
        if ((t.timestamps.completed || '').slice(0, 10) === todayIso) todayTotal += t.finalFare;
      }
    }
    res.json({ today: todayTotal, total, completedTrips: count, currency: 'zar' });
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
      const { actualDistanceKm, actualDurationMin, tipAmount } = req.body;
      const result = await tripService.completeTrip(req.params.id, req.user.id, {
        actualDistanceKm, actualDurationMin, tipAmount,
      });
      notify.tripUpdated(result.trip);
      res.json(result);
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = driverRoutes;
