// Phone + PIN authentication.
//
// A new user sets a 6-digit PIN on first sign-in; it is stored only as a salted
// scrypt hash (services/pin.js). Returning users verify against that hash. There
// is no OTP: no SMS/email delivery, no short-lived code, no fixed fallback.
//
// Because a 6-digit PIN has a small keyspace, verification is throttled hard:
// checkPinLimit() caps attempts per phone per window (see services/rateLimit.js)
// and returns a 429 with Retry-After once the budget is spent. Never lower that
// protection — it is what makes a 6-digit PIN safe.
const jwt = require('jsonwebtoken');
const config = require('../config');
const repo = require('../db/repository');
const { hashPin, verifyPin } = require('./pin');
const { checkPinLimit, recordPinFailure } = require('./rateLimit');

const PIN_MIN = 6;
const PIN_MAX = 6;

function normalizePhone(phone) {
  // Convert local SA +27/0 format to E.164 if needed.
  let p = String(phone).replace(/[^+\d]/g, '');
  if (!p.startsWith('+')) {
    if (p.startsWith('0')) p = '+27' + p.slice(1);
    else p = '+' + p;
  }
  return p;
}

function validatePin(pin) {
  const s = String(pin ?? '');
  if (!/^\d+$/.test(s) || s.length < PIN_MIN || s.length > PIN_MAX) {
    const err = new Error(`PIN must be ${PIN_MIN} digits`);
    err.status = 400;
    throw err;
  }
  return s;
}

function lookupUserByPhone(normalized, role) {
  let user = repo.getUserByPhone(normalized, role === 'driver' ? 'driver' : 'customer');
  // Allow the same phone to be both a customer and a driver when roles differ.
  if (!user) user = repo.getUserByPhone(normalized, undefined);
  return user;
}

function createUserOrReject(normalized, role, name, email) {
  if (role === 'driver') {
    // The platform owner (config.driverPhone) is the admin AND a driver, always
    // pre-approved. Anyone else who registers to drive starts as 'pending' and
    // is vetted by the admin before they can receive bookings.
    const isOwner = normalized === config.driverPhone;
    if (isOwner) {
      return repo.createUser({ phone: normalized, name, email, role: 'admin', driverStatus: 'approved' });
    }
    return repo.createUser({ phone: normalized, name, email, role: 'driver', driverStatus: 'pending' });
  }
  return repo.createUser({ phone: normalized, name, email, role: 'customer' });
}

function issueToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpires });
}

// Does this phone already have a PIN set? Drives the login screen's
// "create a PIN" vs "enter your PIN" step.
function getAccountStatus({ phone }) {
  if (!/^\+?\d{9,15}$/.test(phone || '')) {
    const err = new Error('Invalid phone number');
    err.status = 400;
    throw err;
  }
  const normalized = normalizePhone(phone);
  const user = repo.getUserByPhone(normalized, undefined);
  return { phone: normalized, exists: !!user, hasPin: !!(user && repo.getPinHash(normalized)) };
}

// First-time sign-in: create the account (if new) and set its PIN. If the phone
// already has a PIN, this refuses — the caller must use the verify path so an
// attacker can't reset someone else's PIN just by knowing their number.
function setupPin({ phone, pin, name, email, role }) {
  if (!/^\+?\d{9,15}$/.test(phone || '')) {
    const err = new Error('Invalid phone number');
    err.status = 400;
    throw err;
  }
  const normalized = normalizePhone(phone);
  const cleanPin = validatePin(pin);

  // Same brute-force throttle as login: guessing the phone isn't enough, but a
  // flood of setups for one number must be capped too.
  const limit = checkPinLimit(normalized);
  if (!limit.ok) {
    return { success: false, error: 'Too many attempts, try again shortly', retryAfterSec: limit.retryAfterSec };
  }

  let user = lookupUserByPhone(normalized, role);
  if (user && repo.getPinHash(normalized)) {
    return { success: false, error: 'This number already has a PIN. Enter it to sign in.' };
  }
  if (!user) {
    user = createUserOrReject(normalized, role, name, email);
    if (!user) return { success: false, error: 'This number is not the registered driver' };
  } else if (role === 'driver' && user.role === 'customer') {
    user = repo.convertToDriverApplicant(user.id);
  }

  repo.setUserPin(user.id, hashPin(cleanPin));
  // Reflect any name/email the user supplied at signup.
  if (name || email) {
    user = repo.updateUserProfile(user.id, { name: name || user.name, email: email || user.email });
  }
  return { success: true, token: issueToken(user), user };
}

function loginWithPin({ phone, pin, role }) {
  if (!/^\+?\d{9,15}$/.test(phone || '')) {
    const err = new Error('Invalid phone number');
    err.status = 400;
    throw err;
  }
  const normalized = normalizePhone(phone);

  const limit = checkPinLimit(normalized);
  if (!limit.ok) {
    return { success: false, error: 'Too many attempts, try again shortly', retryAfterSec: limit.retryAfterSec };
  }

  const stored = repo.getPinHash(normalized);
  // Same message whether the phone is unknown or the PIN is wrong, so login
  // can't be used to enumerate which numbers have accounts.
  if (!stored || !verifyPin(String(pin ?? ''), stored)) {
    recordPinFailure(normalized);
    return { success: false, error: 'Incorrect phone number or PIN' };
  }

  let user = lookupUserByPhone(normalized, role);
  if (!user) user = repo.getUserByPhone(normalized, undefined);
  if (role === 'driver' && user && user.role === 'customer') {
    // A customer choosing "I'm the driver" applies to drive. Their account is
    // converted to a pending driver applicant; history stays on the same id.
    user = repo.convertToDriverApplicant(user.id);
  }
  return { success: true, token: issueToken(user), user };
}

// Change an existing account's PIN (used from the Profile screen while signed
// in). Requires the current PIN so a hijacked session can't lock the owner out.
function changePin({ userId, currentPin, newPin }) {
  const user = repo.getUserById(userId);
  if (!user) {
    const err = new Error('Not found');
    err.status = 404;
    throw err;
  }
  const stored = repo.getPinHash(user.phone);
  if (!stored || !verifyPin(String(currentPin ?? ''), stored)) {
    return { success: false, error: 'Current PIN is incorrect' };
  }
  const cleanNew = validatePin(newPin);
  repo.setUserPin(user.id, hashPin(cleanNew));
  return { success: true };
}

module.exports = {
  normalizePhone, getAccountStatus, setupPin, loginWithPin, changePin,
};
