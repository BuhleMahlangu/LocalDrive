const { Router } = require('express');
const repo = require('../db/repository');
const config = require('../config');
const { authRequired } = require('../middleware');
const tripService = require('../services/trips');

// Factory takes socket notify helpers so REST can push realtime updates.
function customerRoutes({ notify }) {
  const router = Router();

  // Public: is the driver online right now?
  router.get('/driver/availability', (_req, res) => {
    const driver = repo.getDriver();
    res.json({ isOnline: !!(driver && driver.isOnline) });
  });

  // Public: driver's public details (for the booking screen).
  router.get('/driver', (_req, res) => {
    const driver = repo.getDriver();
    if (!driver) return res.status(404).json({ error: 'No driver configured' });
    res.json(tripService.publicDriver(driver));
  });

  // Public: get a price estimate for a trip.
  router.post('/estimate', async (req, res, next) => {
    try {
      const { pickup, destination } = req.body;
      const route = await tripService.getRoute({ pickup, destination });
      const driver = repo.getDriver();
      const estimate = require('../services/pricing').estimateFare({
        baseFare: driver.baseFare,
        perKmRate: driver.perKmRate,
        perMinRate: driver.perMinRate,
        distanceKm: route.distanceKm,
        durationMin: route.durationMin,
      });
      res.json({ estimate, route });
    } catch (e) { next(e); }
  });

  router.use(authRequired(['customer']));

  // Saved places (frequent home / work / other spots for quick booking).
  router.get('/places', (req, res) => {
    res.json(repo.listSavedPlaces(req.user.id));
  });

  router.post('/places', (req, res, next) => {
    try {
      const { label, kind, address, lat, lng, note } = req.body;
      if (label == null || typeof lat !== 'number' || typeof lng !== 'number') {
        return res.status(400).json({ error: 'label, lat and lng are required' });
      }
      const place = repo.createSavedPlace(req.user.id, { label, kind, address, lat, lng, note });
      res.status(201).json(place);
    } catch (e) { next(e); }
  });

  router.put('/places/:id', (req, res, next) => {
    try {
      const { label, kind, address, lat, lng, note } = req.body;
      const place = repo.updateSavedPlace(req.params.id, req.user.id, { label, kind, address, lat, lng, note });
      if (!place) return res.status(404).json({ error: 'Place not found' });
      res.json(place);
    } catch (e) { next(e); }
  });

  router.delete('/places/:id', (req, res, next) => {
    try {
      repo.deleteSavedPlace(req.params.id, req.user.id);
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  // Create a booking (trip request).
  router.post('/trips', async (req, res, next) => {
    try {
      const { pickup, destination, priceModel, paymentMethod, scheduledAt } = req.body;
      if (paymentMethod !== 'cash' && paymentMethod !== 'card') {
        return res.status(400).json({ error: 'Invalid payment method' });
      }
      if (paymentMethod === 'card' && !config.yoco.secretKey) {
        return res.status(400).json({ error: 'Card payments are not available yet. Please choose cash.' });
      }
      const avail = tripService.checkAvailabilityForPickup(pickup, scheduledAt);
      if (!avail.ok) {
        return res.status(409).json({
          error: avail.code === 'OUT_OF_RANGE'
            ? 'Pickup is outside the driver’s service area'
            : 'Driver unavailable, try again later',
          code: avail.code,
        });
      }
      const { trip, estimate, driverPublic } = await tripService.createTrip({
        customerId: req.user.id,
        pickup, destination, priceModel,
        paymentMethod,
        scheduledAt: scheduledAt || null,
      });

      // Push the request to the single driver (only for immediate trips;
      // scheduled trips are surfaced in the driver's Upcoming list instead).
      if (!trip.scheduledAt) {
        const driver = repo.getDriver();
        if (driver) notify.newTripToDriver(trip, driver.id, driverPublic);
      } else {
        const driver = repo.getDriver();
        if (driver) notify.scheduledTripAdded(trip, driver.id);
      }

      res.status(201).json({ trip, estimate, driver: driverPublic });
    } catch (e) { next(e); }
  });

  // My trips (history).
  router.get('/trips', (req, res) => {
    res.json(repo.getTripsForCustomer(req.user.id));
  });

  // My active trip (accepted/ongoing).
  router.get('/trips/active', (req, res) => {
    const trip = repo.getActiveTripForCustomer(req.user.id);
    res.json({ trip });
  });

  // My upcoming scheduled trips (pre-booked for a future time).
  router.get('/trips/upcoming', (req, res) => {
    const trips = repo.getTripsForCustomer(req.user.id)
      .filter((t) => t.status === 'scheduled');
    res.json({ trips });
  });

  // Cancel my booking.
  router.post('/trips/:id/cancel', async (req, res, next) => {
    try {
      const trip = await tripService.cancelTrip(req.params.id, 'customer', req.body.reason);
      notify.tripUpdated(trip);
      res.json({ trip });
    } catch (e) { next(e); }
  });

  // Rate + tip a completed trip.
  router.post('/trips/:id/rate', async (req, res, next) => {
    try {
      const { stars, tipAmount, feedbackTags } = req.body;
      const trip = await tripService.rateTrip(req.params.id, req.user.id, stars, tipAmount, feedbackTags);
      notify.tripUpdated(trip);
      res.json({ trip });
    } catch (e) { next(e); }
  });

  // Register FCM push token (for later real push notifications).
  router.post('/push-token', (req, res) => {
    const { token, platform } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    dbPush(req.user.id, token, platform);
    res.json({ ok: true });
  });

  return router;
}

function dbPush(userId, token, platform) {
  const db = repo.db;
  db.prepare(
    `INSERT INTO push_tokens (user_id, token, platform) VALUES (?, ?, ?)
     ON CONFLICT(user_id, token) DO UPDATE SET platform = excluded.platform, updated_at = datetime('now')`,
  ).run(userId, token, platform || null);
}

module.exports = customerRoutes;
