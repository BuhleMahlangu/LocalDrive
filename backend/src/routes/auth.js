const express = require('express');
const config = require('../config');
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
    if (result.success && result.token) {
      // Carry the JWT in an HttpOnly, Secure-in-prod cookie so the frontend
      // never needs to read it from JavaScript. Kept alongside the token in the
      // response for backwards-compatible clients.
      res.cookie('drivelocal_token', result.token, {
        httpOnly: true,
        secure: config.nodeEnv === 'production',
        sameSite: config.nodeEnv === 'production' ? 'none' : 'lax',
        path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
    }
    res.json(result);
  } catch (e) { next(e); }
});

// Clear the auth cookie (logout in cookie-based sessions).
router.post('/logout', (_req, res) => {
  res.clearCookie('drivelocal_token', { path: '/' });
  res.json({ success: true });
});

// Return the authenticated user's profile (used on app reload).
router.get('/me', authRequired(), (req, res) => {
  res.json(req.user);
});

module.exports = router;
