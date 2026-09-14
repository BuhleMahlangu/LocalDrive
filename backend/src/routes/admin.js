const { Router } = require('express');
const repo = require('../db/repository');
const { authRequired, adminOnly } = require('../middleware');

// Platform owner administration. Mounted at /api/admin and only reachable by
// the role 'admin' owner account (the same person who also drives).
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

module.exports = router;