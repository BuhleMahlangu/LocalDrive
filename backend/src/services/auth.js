const jwt = require('jsonwebtoken');
const config = require('../config');
const repo = require('../db/repository');
const sms = require('./sms');
const { checkOtpLimit } = require('./rateLimit');
const { makeOtp } = require('../utils/geo');

const OTP_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;

async function requestOtp({ phone, role: _role }) {
  if (!/^\+?\d{9,15}$/.test(phone)) {
    const err = new Error('Invalid phone number');
    err.status = 400;
    throw err;
  }
  const normalized = normalizePhone(phone);

  // Throttle OTP requests per phone (window + daily cap). In production this
  // caps real SMS cost and stops one phone from spamming another.
  const limit = checkOtpLimit(normalized);
  if (!limit.ok) {
    const err = new Error(
      limit.code === 'DAILY_LIMIT'
        ? 'Daily OTP limit reached for this number'
        : 'Too many requests, try again shortly',
    );
    err.status = 429;
    err.code = limit.code;
    err.retryAfterSec = limit.retryAfterSec;
    throw err;
  }

  // The convenience fixed code is only for local development. Any other
  // environment generates a random OTP, which is then delivered by `sms.send`.
  const code = config.nodeEnv === 'development' ? '123456' : makeOtp();
  const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000).toISOString();

  repo.saveOtp(normalized, code, expiresAt);
  await sms.send({
    to: normalized,
    body: `DriveLocal: your verification code is ${code}. Valid for ${OTP_TTL_MIN} minutes.`,
  });

  return { phone: normalized, expiresInSeconds: OTP_TTL_MIN * 60, dev: config.nodeEnv !== 'production' };
}

function lookupUserByPhone(normalized, role) {
  let user = repo.getUserByPhone(normalized, role === 'driver' ? 'driver' : 'customer');
  // Allow the same phone to be both a customer and a driver when roles differ.
  if (!user) user = repo.getUserByPhone(normalized, undefined);
  return user;
}

function createUserOrReject(normalized, role, name, email) {
  const createRole = role === 'driver' ? 'driver' : 'customer';
  // Critical: never let a stranger register as the driver. Only the phone in
  // config.driverPhone may create a driver account (e.g. first login from the
  // owner's device). Everyone else gets a customer account.
  if (createRole === 'driver' && normalized !== config.driverPhone) {
    return null;
  }
  return repo.createUser({ phone: normalized, name, email, role: createRole });
}

function verifyOtp({ phone, code, name, email, role }) {
  const normalized = normalizePhone(phone);

  // The code is generated + stored locally (see requestOtp) and delivered by
  // `sms.send`; validate against our own record in every environment.
  const otp = repo.getOtp(normalized);
  if (!otp) return { success: false, error: 'No code requested' };

  if (new Date(otp.expires_at).getTime() < Date.now()) {
    repo.deleteOtp(normalized);
    return { success: false, error: 'Code expired, request a new one' };
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    repo.deleteOtp(normalized);
    return { success: false, error: 'Too many attempts, request a new code' };
  }
  if (String(otp.code) !== String(code)) {
    repo.incrementOtpAttempts(normalized);
    return { success: false, error: 'Incorrect code' };
  }

  repo.deleteOtp(normalized);

  let user = lookupUserByPhone(normalized, role);
  if (!user) {
    user = createUserOrReject(normalized, role, name, email);
    if (!user) return { success: false, error: 'This number is not the registered driver' };
  }

  const token = jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: config.jwtExpires });
  return { success: true, token, user };
}

function normalizePhone(phone) {
  // Convert local SA +27/0 format to E.164 if needed.
  let p = String(phone).replace(/[^+\d]/g, '');
  if (!p.startsWith('+')) {
    if (p.startsWith('0')) p = '+27' + p.slice(1);
    else p = '+' + p;
  }
  return p;
}

module.exports = { requestOtp, verifyOtp, normalizePhone };
