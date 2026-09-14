const jwt = require('jsonwebtoken');
const config = require('../config');
const repo = require('../db/repository');
const { logError } = require('../services/logger');

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpires });
}

function authRequired(roles) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
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
  res.status(status).json({
    error: err.message || 'Internal server error',
    code: err.code,
  });
}

module.exports = { authRequired, signToken, approvedDriverOnly, adminOnly, notFound, errorHandler };
