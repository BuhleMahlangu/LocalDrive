const express = require('express');
const config = require('../config');
const authService = require('../services/auth');
const { authRequired } = require('../middleware');
const { recordPinFailure, checkPinIpLimit, recordPinIpFailure } = require('../services/rateLimit');

const router = express.Router();

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Record a failed attempt against both the phone and the client IP (only
// failures count toward either cap — see services/rateLimit.js).
function recordFailure(req, phone) {
  recordPinFailure(phone);
  recordPinIpFailure(clientIp(req));
}

// Carry the JWT in an HttpOnly, Secure-in-prod cookie so the frontend never
// needs to read it from JavaScript. Also returned in the body for API clients.
function setAuthCookie(res, token) {
  res.cookie('drivelocal_token', token, {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: config.nodeEnv === 'production' ? 'none' : 'lax',
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

// Does this phone already have an account/PIN? Lets the login screen show the
// right step ("create a PIN" vs "enter your PIN") before asking for one.
router.post('/account', (req, res, next) => {
  const ipLimit = checkPinIpLimit(clientIp(req));
  if (!ipLimit.ok) {
    res.set('Retry-After', String(ipLimit.retryAfterSec));
    return res.status(429).json({ error: 'Too many requests, try again shortly' });
  }
  try {
    res.json(authService.getAccountStatus({ phone: req.body.phone }));
  } catch (e) { next(e); }
});

// First-time sign-in: create the account (if new) and set the PIN.
router.post('/pin/setup', (req, res, next) => {
  const ipLimit = checkPinIpLimit(clientIp(req));
  if (!ipLimit.ok) {
    res.set('Retry-After', String(ipLimit.retryAfterSec));
    return res.status(429).json({ error: 'Too many requests, try again shortly' });
  }
  try {
    const { phone, pin, name, email, role } = req.body;
    const result = authService.setupPin({ phone, pin, name, email, role });
    if (!result.success) {
      recordFailure(req, authService.normalizePhone(phone));
      return res.status(result.retryAfterSec ? 429 : 400).set('Retry-After', String(result.retryAfterSec ?? 60)).json(result);
    }
    setAuthCookie(res, result.token);
    res.json(result);
  } catch (e) { next(e); }
});

// Returning user: phone + PIN.
router.post('/pin/login', (req, res, next) => {
  const ipLimit = checkPinIpLimit(clientIp(req));
  if (!ipLimit.ok) {
    res.set('Retry-After', String(ipLimit.retryAfterSec));
    return res.status(429).json({ error: 'Too many requests, try again shortly' });
  }
  try {
    const { phone, pin, role } = req.body;
    const result = authService.loginWithPin({ phone, pin, role });
    if (!result.success) {
      recordFailure(req, authService.normalizePhone(phone));
      // Distinguish "locked out" (429 + Retry-After) from a wrong PIN (401) so
      // the UI can say "wait a minute" instead of "wrong PIN".
      return res
        .set('Retry-After', String(result.retryAfterSec ?? 60))
        .status(result.retryAfterSec ? 429 : 401)
        .json(result);
    }
    setAuthCookie(res, result.token);
    res.json(result);
  } catch (e) { next(e); }
});

// Change PIN from the Profile screen (must be signed in and know the old PIN).
router.post('/pin/change', authRequired(), (req, res, next) => {
  try {
    const { currentPin, newPin } = req.body;
    const result = authService.changePin({ userId: req.user.id, currentPin, newPin });
    res.status(result.success ? 200 : 400).json(result);
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
