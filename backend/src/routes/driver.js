const { Router } = require('express');
const repo = require('../db/repository');
const config = require('../config');
const { authRequired, approvedDriverOnly } = require('../middleware');
const tripService = require('../services/trips');
const payments = require('../services/payments');
const pricing = require('../services/pricing');
const uploadsService = require('../services/uploads');

function driverRoutes({ notify }) {
  const router = Router();
  // Any authenticated user may reach the application endpoints below; the
  // operational driver routes after them require an approved driver.
  router.use(authRequired());

  // --- Driver application / vetting (also usable while pending/rejected) ---

  // The current user's application + approval status.
  router.get('/application', (req, res) => {
    const app = repo.getDriverApplication(req.user.id);
    const user = repo.getUserById(req.user.id);
    res.json({
      role: user.role,
      driverStatus: user.driverStatus,
      rejectionReason: user.rejectionReason,
      application: app,
    });
  });

  // Submit (or re-submit) a driver application with vetting documents:
  // FormData: idNumber (text) + idCopy, selfie, proofOfResidence (files).
  router.post(
    '/register',
    uploadsService.upload.fields([
      { name: 'idCopy', maxCount: 1 },
      { name: 'selfie', maxCount: 1 },
      { name: 'proofOfResidence', maxCount: 1 },
    ]),
    (req, res, next) => {
      try {
        if (!['driver', 'admin'].includes(req.user.role)) {
          return res.status(403).json({ error: 'Only drivers can apply' });
        }
        const { idNumber } = req.body || {};
        if (!idNumber || !require('../services/saidNumber').isValidSaId(idNumber)) {
          return res.status(400).json({ error: 'A valid 13-digit SA ID number is required' });
        }
        const files = req.files || {};
        const pick = (name) => (files[name] && files[name][0] ? files[name][0].filename : null);

        // A re-submission may omit unchanged documents; keep the existing paths.
        const existing = repo.getDriverApplication(req.user.id);
        const idCopyPath = pick('idCopy') || existing?.idCopyUrl?.split('/').pop() || null;
        const selfiePath = pick('selfie') || existing?.selfieUrl?.split('/').pop() || null;
        const proofPath = pick('proofOfResidence') || existing?.proofOfResidenceUrl?.split('/').pop() || null;

        const app = repo.saveDriverApplication(req.user.id, {
          idNumber: String(idNumber).trim(),
          idCopyPath,
          selfiePath,
          proofOfResidencePath: proofPath,
        });

        // Replaced documents are gone for good — remove the old copies from disk.
        try {
          const previous = [existing?.idCopyUrl, existing?.selfieUrl, existing?.proofOfResidenceUrl];
          const current = [idCopyPath, selfiePath, proofPath];
          previous.forEach((oldUrl, i) => {
            if (oldUrl && current[i] && !oldUrl.endsWith(current[i])) {
              uploadsService.deleteFile(oldUrl.split('/').pop());
            }
          });
        } catch { /* best-effort cleanup */ }

        // Only pending/rejected applicants change status; approved/admin stay put.
        if (req.user.driverStatus !== 'approved' && req.user.role !== 'admin') {
          repo.setDriverStatus(req.user.id, 'pending');
        }
        const user = repo.getUserById(req.user.id);
        res.status(201).json({ application: app, driverStatus: user.driverStatus, user });
      } catch (e) { next(e); }
    },
  );

  // --- Operational driver routes: approved drivers only ---
  router.use(authRequired(['driver', 'admin']));
  router.use(approvedDriverOnly);

  // Wallet balance (available to withdraw vs commission owed to the platform).
  router.get('/wallet', (req, res) => {
    res.json({ wallet: repo.getWallet(req.user.id) });
  });

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

  // Advanced analytics: daily earnings, busiest hours, acceptance rate, etc.
  router.get('/analytics', (req, res) => {
    res.json(repo.getDriverAnalytics(req.user.id));
  });

  // Open fare disputes (driver view) + resolution.
  router.get('/disputes', (_req, res) => {
    res.json({ disputes: repo.listOpenDisputes() });
  });

  router.post('/disputes/:id/resolve', (req, res, next) => {
    try {
      const { resolution } = req.body;
      const dispute = repo.resolveDispute(req.params.id, resolution || 'Resolved');
      res.json({ dispute });
    } catch (e) { next(e); }
  });

  // Promo code management (driver/admin side).
  router.get('/promos', (_req, res) => {
    res.json({ promos: repo.listPromos() });
  });

  router.post('/promos', (req, res, next) => {
    try {
      const { code, discountPercent, maxUses, validUntil } = req.body;
      if (!code || !/^[A-Z0-9]{3,20}$/.test(String(code).toUpperCase())) {
        return res.status(400).json({ error: 'Code must be 3-20 letters/numbers' });
      }
      const promo = repo.createPromo({
        code: String(code).toUpperCase(),
        discountPercent: parseFloat(discountPercent),
        maxUses: parseInt(maxUses, 10),
        validUntil: validUntil || null,
      });
      res.status(201).json({ promo });
    } catch (e) { next(e); }
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

  // Driver arrived at the pickup (customer hears "your driver is here").
  router.post('/trips/:id/arrive', async (req, res, next) => {
    try {
      const trip = await tripService.arriveAtPickup(req.params.id, req.user.id);
      notify.tripArrived(trip);
      notify.tripUpdated(trip);
      res.json({ trip });
    } catch (e) { next(e); }
  });

  // Start trip (customer is in the car).
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

  // Cancel an accepted or ongoing trip (driver-initiated).
  router.post('/trips/:id/cancel', async (req, res, next) => {
    try {
      const trip = repo.getTripById(req.params.id);
      if (!trip || trip.driverId !== req.user.id) {
        return res.status(404).json({ error: 'Trip not found' });
      }
      if (!['accepted', 'ongoing'].includes(trip.status)) {
        return res.status(409).json({ error: 'This trip cannot be cancelled' });
      }
      const updated = await tripService.cancelTrip(req.params.id, 'driver', req.body.reason || 'Cancelled by driver');
      notify.tripUpdated(updated);
      res.json({ trip: updated });
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

  // ----- Admin settings (owner driver only, like all driver routes) -----
  // Runtime knobs with env-configured defaults: pricing can also be edited via
  // the profile endpoint, so this covers platform fee + auto-offline grace.
  router.get('/settings', (_req, res) => {
    const defaults = {
      platform_fee_percent: config.platformFeePercent,
      auto_offline_grace_ms: config.autoOfflineGraceMs,
    };
    const saved = {};
    for (const row of repo.listSettings()) saved[row.key] = row.value;
    res.json({ settings: { ...defaults, ...saved } });
  });

  router.put('/settings', (req, res, next) => {
    try {
      const { platform_fee_percent, auto_offline_grace_ms } = req.body || {};
      if (platform_fee_percent != null) {
        const n = parseFloat(platform_fee_percent);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          return res.status(400).json({ error: 'Platform fee must be a percentage (0-100)' });
        }
        repo.setSetting('platform_fee_percent', n);
      }
      if (auto_offline_grace_ms != null) {
        const n = parseInt(auto_offline_grace_ms, 10);
        if (!Number.isFinite(n) || n < 1000 || n > 3600000) {
          return res.status(400).json({ error: 'Auto-offline grace must be between 1000 and 3600000 ms' });
        }
        repo.setSetting('auto_offline_grace_ms', n);
      }
      res.json({ saved: repo.listSettings() });
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
