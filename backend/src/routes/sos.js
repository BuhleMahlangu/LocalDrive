const { Router } = require('express');
const repo = require('../db/repository');
const config = require('../config');
const { authRequired } = require('../middleware');
const sms = require('../services/sms');

// Emergency SOS: any authenticated user (customer or driver) can record an
// alert. It's stored forever (the Records audit trawls them), pushed to every
// admin/owner account over socket, and — in production — the owner gets an SMS
// so a tapped-out/closed browser doesn't delay response.
//
// Mounted at /api/sos and intentionally not role-gated beyond authentication:
// an emergency alert must never be rejected because of a role check.
function sosRoutes({ notify }) {
  const router = Router();
  router.use(authRequired());

  router.post('/', (req, res, next) => {
    try {
      const { tripId = null, note = '', lat = null, lng = null } = req.body || {};

      // If a trip is cited, it must actually belong to this user.
      let trip = null;
      if (tripId) {
        trip = repo.getTripById(tripId);
        if (!trip) return res.status(404).json({ error: 'Trip not found' });
        if (trip.customerId !== req.user.id && trip.driverId !== req.user.id) {
          return res.status(403).json({ error: 'Not your trip' });
        }
      }

      const alert = repo.createSosAlert({
        userId: req.user.id,
        tripId: trip ? trip.id : null,
        role: req.user.role,
        note: String(note).trim() || `Emergency SOS pressed by ${req.user.name || req.user.phone}`,
        lat: typeof lat === 'number' ? lat : null,
        lng: typeof lng === 'number' ? lng : null,
      });

      // Owner SMS is best-effort: a provider hiccup must not eat the response
      // (the socket + record already captured the alert).
      const owner = config.driverPhone
        ? repo.getUserByPhone(config.driverPhone, 'admin')
        : null;
      if (owner && owner.phone) {
        const smsBody = `[DriveLocal SOS] ${req.user.name || req.user.phone} (${req.user.role}) pressed SOS`
          + (trip ? ` on trip ${trip.id} from ${trip.pickup?.address || 'unknown'} to ${trip.destination?.address || 'unknown'}` : '');
        sms.send({ to: owner.phone, body: smsBody })
          .catch((e) => console.warn('[sms] SOS to owner failed:', e.message));
      }

      notify.sosAlert(alert, trip);
      res.status(201).json({ alert });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = sosRoutes;