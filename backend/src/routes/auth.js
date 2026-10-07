const express = require('express');
const authService = require('../services/auth');
const { authRequired } = require('../middleware');
const { checkOtpIpLimit } = require('../services/rateLimit');

const router = express.Router();

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

router.post('/otp/request', async (req, res, next) => {
  // Per-IP cap so a phone-number foam attack (free requests across thousands
  // of numbers) can't burn SMS credits from one device. Per-phone caps still
  // apply inside the service.
  const ipLimit = checkOtpIpLimit(clientIp(req));
  if (!ipLimit.ok) {
    res.set('Retry-After', String(ipLimit.retryAfterSec));
    return res.status(429).json({ error: 'Too many requests, try again shortly', code: ipLimit.code });
  }
  try {
    const { phone, role } = req.body;
    const result = await authService.requestOtp({ phone, role });
    res.json(result);
  } catch (e) { next(e); }
});

router.post('/otp/verify', async (req, res, next) => {
  try {
    const { phone, code, name, email, role } = req.body;
    const result = await authService.verifyOtp({ phone, code, name, email, role });
    if (!result.success) {
      // Distinguish "locked out" (429 + Retry-After) from a plain wrong code
      // (401) so the UI can say "wait a minute" instead of "wrong code".
      return res
        .set('Retry-After', String(result.retryAfterSec ?? 60))
        .status(result.retryAfterSec ? 429 : 401)
        .json(result);
    }
    res.json(result);
  } catch (e) { next(e); }
});

// Return the authenticated user's profile (used on app reload).
router.get('/me', authRequired(), (req, res) => {
  res.json(req.user);
});

module.exports = router;
