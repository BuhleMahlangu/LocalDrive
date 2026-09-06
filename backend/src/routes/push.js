const express = require('express');
const config = require('../config');
const repo = require('../db/repository');
const { authRequired } = require('../middleware');

const router = express.Router();

// Public VAPID public key so clients can subscribe.
router.get('/vapid', (_req, res) => {
  res.json({ publicKey: config.webPush.publicKey || null });
});

// Save/refresh a web-push subscription for the current user.
router.post('/subscribe', authRequired(), (req, res, next) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    repo.savePushSubscription(req.user.id, {
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
    });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Unsubscribe (remove) the given endpoint.
router.post('/unsubscribe', authRequired(), (req, res, next) => {
  try {
    const { endpoint } = req.body || {};
    if (endpoint) repo.removePushSubscription(endpoint);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
