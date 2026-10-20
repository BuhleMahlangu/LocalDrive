const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const repo = require('../db/repository');
const sms = require('./sms');
const email = require('./email');
const { checkOtpLimit, checkVerifyLimit } = require('./rateLimit');

const OTP_TTL_MIN = 10;
const MAX_ATTEMPTS = 5;

// OTP codes are stored as a salted SHA-256 hash, never in plaintext. Even if the
// database leaks, the hash can't be mined offline without the JWT secret (which
// is already required to be strong in production). Rate limiting on the verify
// endpoint is what actually stops online brute force.
function hashOtp(phone, code) {
  return crypto.createHash('sha256').update(`${phone}:${String(code)}:${config.jwtSecret}`).digest('hex');
}

async function requestOtp({ phone, role: _role, email: requestedEmail }) {
  if (!/^\+?\d{9,15}$/.test(phone)) {
    const err = new Error('Invalid phone number');
    err.status = 400;
    throw err;
  }
  const normalized = normalizePhone(phone);

  // Throttle OTP requests per phone (window + daily cap). This caps SMS cost
  // once a provider is integrated and stops one phone from spamming another.
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

  // Always issue a real random one-time code. SMS goes to the requesting number
  // when a provider is configured, else email (SMTP) if we have an address; with
  // neither, sms.send logs the code to the server console in development only
  // (production refuses to start without a delivery path — see config/index.js).
  const existingUser = repo.getUserByPhone(normalized) || repo.getUserByPhone(normalized, _role === 'driver' ? 'driver' : 'customer');
  const toEmail = String(requestedEmail || existingUser?.email || '').trim();

  const canSms = sms.deliversReal();
  const canEmail = !canSms && email.isConfigured() && !!toEmail;
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60 * 1000).toISOString();

  repo.saveOtp(normalized, hashOtp(normalized, code), expiresAt);

  if (canSms) {
    await sms.send({
      to: normalized,
      body: `DriveLocal: your verification code is ${code}. Valid for ${OTP_TTL_MIN} minutes. Never share it with anyone.`,
    });
  } else if (canEmail) {
    await email.send({
      to: toEmail,
      subject: 'Your DriveLocal verification code',
      text: `Your DriveLocal verification code is ${code}. It is valid for ${OTP_TTL_MIN} minutes. Never share it with anyone.`,
      html: `<p>Your DriveLocal verification code is <strong>${code}</strong>.</p><p>Valid for ${OTP_TTL_MIN} minutes. Never share it with anyone.</p>`,
    });
  } else {
    // No SMS/email provider: sms.send() logs the code to the console in
    // development. Production never reaches here (config refuses to start).
    await sms.send({
      to: normalized,
      body: `DriveLocal: your verification code is ${code}. Valid for ${OTP_TTL_MIN} minutes.`,
    });
  }

  const delivery = canSms ? 'sms' : canEmail ? 'email' : 'console';
  return {
    phone: normalized,
    expiresInSeconds: OTP_TTL_MIN * 60,
    dev: delivery === 'console',
    delivery,
  };
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

function verifyOtp({ phone, code, name, email, role }) {
  const normalized = normalizePhone(phone);

  // Throttle brute-force attempts per phone per window.
  const verifyLimit = checkVerifyLimit(normalized);
  if (!verifyLimit.ok) {
    return { success: false, error: 'Too many attempts, try again shortly', retryAfterSec: verifyLimit.retryAfterSec };
  }

  // The code is generated + stored locally (see requestOtp); validate against
  // our own record in every environment.
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
  if (hashOtp(normalized, code) !== otp.code) {
    repo.incrementOtpAttempts(normalized);
    return { success: false, error: 'Incorrect code' };
  }

  repo.deleteOtp(normalized);

  let user = lookupUserByPhone(normalized, role);
  if (!user) {
    user = createUserOrReject(normalized, role, name, email);
    if (!user) return { success: false, error: 'This number is not the registered driver' };
  } else if (role === 'driver' && user.role === 'customer') {
    // A customer choosing "I'm the driver" applies to drive. Their account is
    // converted to a pending driver applicant; nothing is deleted, so any old
    // ride history stays on the same id.
    user = repo.convertToDriverApplicant(user.id);
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

module.exports = { requestOtp, verifyOtp, normalizePhone, hashOtp };
