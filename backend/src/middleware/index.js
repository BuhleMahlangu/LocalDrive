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
      // The single operator is trusted with every role on their own phone
      // (their account is 'driver', but they also preview/test the customer
      // app and card payments from the same device).
      const isOwner = user.role === 'driver' && user.phone === config.driverPhone;
      const allowed = (roles && roles.includes(user.role)) || (isOwner && roles && roles.includes('customer'));
      if (roles && !allowed) {
        return res.status(403).json({ error: 'Forbidden' });
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

// Defense-in-depth for the single-driver design: even if a legacy/rogue
// role='driver' account exists in the DB, only the phone listed in config may
// use the driver routes.
function ownerDriverOnly(req, res, next) {
  if (req.user && req.user.role === 'driver' && req.user.phone === config.driverPhone) {
    return next();
  }
  return res.status(403).json({ error: 'Not the registered driver' });
}

function errorHandler(err, req, res, _next) {
  logError(err, req);
  const status = err.status || 500;
  res.status(status).json({
    error: err.message || 'Internal server error',
    code: err.code,
  });
}

module.exports = { authRequired, signToken, ownerDriverOnly, notFound, errorHandler };
