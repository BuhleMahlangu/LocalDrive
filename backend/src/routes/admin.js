const { Router } = require('express');
const repo = require('../db/repository');
const { authRequired, adminOnly } = require('../middleware');

// Platform owner administration. Mounted at /api/admin and only reachable by
// the role 'admin' owner account (the same person who also drives).
function adminRoutes({ notify }) {
  const router = Router();

  router.use(authRequired(['admin']));
  router.use(adminOnly);

// Every driver account: account details + vetting application + wallet.
router.get('/drivers', (_req, res) => {
  res.json({ drivers: repo.listDriversForAdmin() });
});

// Full detail for a single driver's application.
router.get('/drivers/:id/application', (req, res) => {
  const driver = repo.getUserById(req.params.id);
  if (!driver || !['driver', 'admin'].includes(driver.role)) {
    return res.status(404).json({ error: 'Driver not found' });
  }
  res.json({
    driver,
    application: repo.getDriverApplication(driver.id),
    wallet: repo.getWallet(driver.id),
  });
});

// Approve a pending driver application: they can now go online and take rides.
router.post('/drivers/:id/approve', (req, res, next) => {
  try {
    const driver = repo.getUserById(req.params.id);
    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({ error: 'Driver not found' });
    }
    if (driver.driverStatus === 'approved') {
      return res.json({ driver: repo.getUserById(driver.id) });
    }
    // A driver may only be approved once they've submitted vetting documents.
    const app = repo.getDriverApplication(driver.id);
    const hasDocs = !!(app && (app.idCopyUrl || app.selfieUrl || app.proofOfResidenceUrl));
    if (!hasDocs) {
      return res.status(409).json({ error: 'Driver has not submitted their vetting documents yet' });
    }
    const updated = repo.setDriverStatus(driver.id, 'approved');
    const wallet = repo.createWalletIfMissing(driver.id);
    res.json({ driver: updated, wallet });
  } catch (e) { next(e); }
});

// Reject a pending driver application (with a reason shown to the applicant).
router.post('/drivers/:id/reject', (req, res, next) => {
  try {
    const driver = repo.getUserById(req.params.id);
    if (!driver || driver.role !== 'driver') {
      return res.status(404).json({ error: 'Driver not found' });
    }
    if (driver.driverStatus === 'approved') {
      return res.status(409).json({ error: 'Driver is already approved' });
    }
    const reason = (req.body && req.body.reason) || 'Not approved';
    const updated = repo.setDriverStatus(driver.id, 'rejected', reason);
    res.json({ driver: updated });
  } catch (e) { next(e); }
});

// ---------- Trip records (safety / audit) ----------
// Search every trip by customer or driver name/phone, plus optional day range
// (?from=2026-09-10&to=2026-09-15) and exact status. The result is a flat list
// of "who was with whom, when, and between which addresses".
router.get('/trips/search', (req, res, next) => {
  try {
    const { q = '', from = '', to = '', status = '', limit } = req.query;
    const trips = repo.searchTripsForAdmin({
      q,
      from: String(from || '').trim(),
      to: String(to || '').trim(),
      status: String(status || '').trim(),
      limit: Number.isFinite(Number(limit)) ? Number(limit) : 50,
    });
    res.json({ trips, count: trips.length });
  } catch (e) { next(e); }
});

// One full audit record: participant identities, addresses, route, payment
// details, all timestamps, and the in-trip message thread.
router.get('/trips/:id', (req, res, next) => {
  try {
    const record = repo.getTripAuditRecord(req.params.id);
    if (!record) return res.status(404).json({ error: 'Trip not found' });
    res.json({ trip: record });
  } catch (e) { next(e); }
});

// ---------- Driver suspend / unsuspend ----------
  // A suspended driver is immediately forced offline, blocked from using driver
  // routes (the approvedDriverOnly middleware rejects them), and kicked from the
  // app so the suspension takes effect without waiting for their next reconnect.
  router.post('/drivers/:id/suspend', (req, res, next) => {
    try {
      const driver = repo.getUserById(req.params.id);
      if (!driver) return res.status(404).json({ error: 'Driver not found' });
      if (driver.role === 'admin') return res.status(409).json({ error: 'Cannot suspend the platform owner' });
      const updated = repo.setDriverStatus(driver.id, 'suspended');
      repo.setDriverOnline(driver.id, false);
      notify.forceOffline(driver.id);
      notify.kickDriver(driver.id);
      res.json({ driver: updated });
    } catch (e) { next(e); }
  });

  router.post('/drivers/:id/unsuspend', (req, res, next) => {
    try {
      const driver = repo.getUserById(req.params.id);
      if (!driver) return res.status(404).json({ error: 'Driver not found' });
      const updated = repo.setDriverStatus(driver.id, 'approved');
      res.json({ driver: updated });
    } catch (e) { next(e); }
  });

// ---------- Pickup spots ----------
// List spots (active + inactive for the admin overview).
router.get('/spots', (_req, res) => {
  res.json({ spots: repo.listPickupSpots(500) });
});

router.post('/spots', (req, res, next) => {
  try {
    const { name, category, address, lat, lng, note, sort } = req.body || {};
    if (!name || typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'name and lat/lng are required' });
    }
    const spot = repo.createPickupSpot({ name, category, address, lat, lng, note, sort });
    res.status(201).json({ spot });
  } catch (e) { next(e); }
});

router.put('/spots/:id', (req, res, next) => {
  try {
    const spot = repo.getPickupSpotById(req.params.id);
    if (!spot) return res.status(404).json({ error: 'Spot not found' });
    const updated = repo.updatePickupSpot(req.params.id, req.body || {});
    res.json({ spot: updated });
  } catch (e) { next(e); }
});

router.delete('/spots/:id', (req, res, next) => {
  try {
    const spot = repo.getPickupSpotById(req.params.id);
    if (!spot) return res.status(404).json({ error: 'Spot not found' });
    repo.deletePickupSpot(req.params.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

  return router;
}

module.exports = adminRoutes;