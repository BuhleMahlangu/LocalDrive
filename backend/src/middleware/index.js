const jwt = require('jsonwebtoken');
const config = require('../config');
const repo = require('../db/repository');
const { logError } = require('../services/logger');

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpires });
}

// Parse a Cookie header string into a name->value map (no extra dependency).
function parseCookieHeader(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of String(cookieHeader).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    let v = part.slice(eq + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* keep raw */ }
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

// Prefer an explicit Bearer token, but fall back to the HttpOnly cookie issued
// at PIN login so tokens never have to live in client-side storage.
function extractToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return parseCookieHeader(req.headers.cookie).drivelocal_token || null;
}

function authRequired(roles) {
  return (req, res, next) => {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
      const payload = jwt.verify(token, config.jwtSecret);
      const user = repo.getUserById(payload.sub);
      if (!user) return res.status(401).json({ error: 'User not found' });
      if (roles) {
        // The platform owner (admin, on their own phone) may preview the
        // customer app / customer endpoints from the same session.
        const isOwnerPreview = user.role === 'admin' && user.phone === config.driverPhone && roles.includes('customer');
        const allowed = roles.includes(user.role) || isOwnerPreview;
        if (!allowed) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }
      req.user = user;
      next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

// Resolve the caller when a valid token is present, but never reject. For
// endpoints that are safe to call anonymously yet can personalise their answer —
// e.g. "which driver am I getting?" is the platform rate card for a browser, but
// the driver actually assigned to a signed-in customer with a live trip.
function optionalAuth(req, _res, next) {
  const token = extractToken(req);
  if (!token) return next();
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = repo.getUserById(payload.sub);
    if (user) req.user = user;
  } catch {
    /* treat an unusable token as anonymous rather than failing the request */
  }
  return next();
}

function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// A user is an active driver (may go online and use driver routes) when they
// are the admin owner or a vetted driver (driver_status = 'approved').
function approvedDriverOnly(req, res, next) {
  const u = req.user;
  const ok = u && (
    u.role === 'admin'
    || (u.role === 'driver' && (u.driverStatus === 'approved' || u.driverStatus == null))
  );
  if (!ok) return res.status(403).json({ error: 'Driver application is not approved yet' });
  return next();
}

// Platform owner only (role 'admin').
function adminOnly(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Admin access required' });
}

function errorHandler(err, req, res, _next) {
  logError(err, req);
  const status = err.status || 500;
  if (err.retryAfterSec) res.set('Retry-After', String(err.retryAfterSec));
  const body = {
    error: err.message || 'Internal server error',
    code: err.code,
  };
  // Include subscription state on the freemium gate so the app can show the
  // renewal details alongside the "renew to take rides" message.
  if (err.subscription) body.subscription = err.subscription;
  res.status(status).json(body);
}

module.exports = { authRequired, optionalAuth, signToken, approvedDriverOnly, adminOnly, notFound, errorHandler, parseCookieHeader, extractToken };
