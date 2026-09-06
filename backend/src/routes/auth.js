const express = require('express');
const authService = require('../services/auth');
const { authRequired } = require('../middleware');

const router = express.Router();

router.post('/otp/request', async (req, res, next) => {
  try {
    const { phone, role } = req.body;
    const result = await authService.requestOtp({ phone, role });
    res.json(result);
  } catch (e) { next(e); }
});

router.post('/otp/verify', (req, res, next) => {
  try {
    const { phone, code, name, email, role } = req.body;
    const result = authService.verifyOtp({ phone, code, name, email, role });
    if (!result.success) return res.status(401).json(result);
    res.json(result);
  } catch (e) { next(e); }
});

// Return the authenticated user's profile (used on app reload).
router.get('/me', authRequired(), (req, res) => {
  res.json(req.user);
});

module.exports = router;
