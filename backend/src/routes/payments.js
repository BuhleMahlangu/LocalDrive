const express = require('express');
const config = require('../config');
const { authRequired } = require('../middleware');
const payments = require('../services/payments');

const router = express.Router();

// Public config: which provider is active so the client can show/hide the UI.
router.get('/config', (_req, res) => {
  res.json({ provider: 'yoco', enabled: !!config.yoco.secretKey });
});

// Customer: get a hosted Yoco checkout (redirect to Yoco's payment page).
router.post('/checkout', authRequired(['customer']), async (req, res, next) => {
  try {
    const { tripId } = req.body;
    const result = await payments.createCheckout({ tripId, customerId: req.user.id });
    res.json(result);
  } catch (e) { next(e); }
});

// Customer: confirm + finalise a card payment after the hosted flow.
router.post('/confirm', authRequired(['customer']), async (req, res, next) => {
  try {
    const { tripId } = req.body;
    const result = await payments.confirmPayment({ tripId, customerId: req.user.id });
    res.json(result);
  } catch (e) { next(e); }
});

// Customer: poll payment status (used while the payment tab is open).
router.get('/status', authRequired(['customer']), (req, res, next) => {
  try {
    const result = payments.getStatus({ tripId: req.query.tripId, customerId: req.user.id });
    res.json(result);
  } catch (e) { next(e); }
});

// Customer: request a refund of a successful card payment.
router.post('/refund', authRequired(['customer']), async (req, res, next) => {
  try {
    const { tripId } = req.body;
    const result = await payments.refundPayment({ tripId, customerId: req.user.id });
    res.json(result);
  } catch (e) { next(e); }
});

module.exports = router;