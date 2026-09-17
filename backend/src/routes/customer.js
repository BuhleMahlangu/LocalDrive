const { Router } = require('express');
const repo = require('../db/repository');
const config = require('../config');
const { authRequired } = require('../middleware');
const tripService = require('../services/trips');
const push = require('../services/push');

// Factory takes socket notify helpers so REST can push realtime updates.
function customerRoutes({ notify }) {
  const router = Router();

  // Public: is any approved driver online right now?
  router.get('/driver/availability', (_req, res) => {
    res.json({ isOnline: repo.hasOnlineDriver() });
  });

  // Public: driver's public details (for the booking screen) — the platform's
  // representative "rate card" driver. The actual assigned driver is whoever
  // claims the request.
  router.get('/driver', (_req, res) => {
    const driver = repo.getDriver();
    if (!driver) return res.status(404).json({ error: 'No driver configured' });
    res.json(tripService.publicDriver(driver));
  });

  // Public: get a price estimate for a trip.
  router.post('/estimate', async (req, res, next) => {
    try {
      const { pickup, destination, promoCode } = req.body;
      const route = await tripService.getRoute({ pickup, destination });
      const driver = repo.getDriver();
      let estimate = require('../services/pricing').estimateFare({
        baseFare: driver.baseFare,
        perKmRate: driver.perKmRate,
        perMinRate: driver.perMinRate,
        distanceKm: route.distanceKm,
        durationMin: route.durationMin,
      });
      // Apply a promo discount to the estimate if a valid code is supplied.
      if (promoCode) {
        const valid = tripService.validatePromo(promoCode);
        if (valid.ok) {
          const discounted = require('../services/pricing').applyPromoDiscount(
            estimate.subtotal, valid.promo.discount_percent, driver.baseFare,
          );
          estimate = {
            ...estimate,
            discount: discounted.discount,
            promoCode: valid.promo.code.toUpperCase(),
            promoPercent: valid.promo.discount_percent,
            total: discounted.total,
          };
        }
      }
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
      const { pickup, destination, priceModel, paymentMethod, scheduledAt, promoCode } = req.body;
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

      // Validate promo code (optional) BEFORE creating the trip so we can attach
      // the discount to the trip and apply it to the fare.
      let promo = null;
      if (promoCode) {
        promo = tripService.validatePromo(promoCode);
        if (!promo.ok) {
          return res.status(400).json({ error: promo.error });
        }
      }

      const { trip, estimate, driverPublic } = await tripService.createTrip({
        customerId: req.user.id,
        pickup, destination, priceModel,
        paymentMethod,
        scheduledAt: scheduledAt || null,
        promoCode: promo?.promo?.code || null,
      });

      // Track recent destinations for the one-tap rebook bar.
      repo.saveRecentDestination(req.user.id, {
        destAddress: destination?.address, destLat: destination?.lat, destLng: destination?.lng, destNote: destination?.note,
        pickupAddress: pickup?.address, pickupLat: pickup?.lat, pickupLng: pickup?.lng,
      });

      // Fan the request out to every online approved driver (immediate trips).
      // Scheduled trips live in every approved driver's Upcoming list instead,
      // with a heads-up push so they know to look.
      const drivers = repo.listOnlineDrivers();
      if (!trip.scheduledAt) {
        for (const d of drivers) notify.newTripToDriver(trip, d.id, driverPublic);
      } else {
        for (const d of drivers) notify.scheduledTripAdded(trip, d.id);
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
    res.json({ trips: repo.getUpcomingTripsForCustomer(req.user.id) });
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
      // Notify the driver of the rating (if the trip had a driver assigned).
      if (trip.driverId) {
        push.sendToUser(trip.driverId, {
          title: 'New rating received',
          body: `A customer rated your trip ${trip.rating != null ? trip.rating + ' stars' : ''}${trip.tipAmount > 0 ? ` and tipped R${trip.tipAmount}` : ''}.`,
          data: { type: 'rating', tripId: trip.id },
        });
      }
      res.json({ trip });
    } catch (e) { next(e); }
  });

  // Customer agrees the final fare (unlocks rating/tipping).
  router.post('/trips/:id/fare-confirm', async (req, res, next) => {
    try {
      const trip = await tripService.confirmFare(req.params.id, req.user.id);
      notify.tripUpdated(trip);
      res.json({ trip });
    } catch (e) { next(e); }
  });

  // Recent destinations (frequent rebook targets).
  router.get('/recent-destinations', (req, res) => {
    res.json({ destinations: repo.getRecentDestinations(req.user.id) });
  });

  router.delete('/recent-destinations/:id', (req, res) => {
    repo.deleteRecentDestination(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  // Customer opens a fare dispute on a completed trip.
  router.post('/trips/:id/dispute', async (req, res, next) => {
    try {
      const { reason } = req.body;
      const trip = repo.getTripById(req.params.id);
      if (!trip || trip.customerId !== req.user.id) {
        return res.status(404).json({ error: 'Trip not found' });
      }
      if (trip.status !== 'completed') {
        return res.status(409).json({ error: 'Only completed trips can be disputed' });
      }
      const existing = repo.getDisputeByTrip(req.params.id);
      if (existing && existing.status === 'open') {
        return res.status(409).json({ error: 'A dispute is already open for this trip' });
      }
      const dispute = repo.createDispute({ tripId: req.params.id, userId: req.user.id, reason });
      // Notify the driver that a dispute was opened.
      if (trip.driverId) {
        notify.tripUpdated(trip);
        push.sendToUser(trip.driverId, {
          title: 'Fare dispute opened',
          body: `A customer disputed the fare on one of your trips.`,
          data: { type: 'dispute', tripId: trip.id },
        });
      }
      res.status(201).json({ dispute });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = customerRoutes;
