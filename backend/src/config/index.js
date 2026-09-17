require('dotenv').config();

const nodeEnv = process.env.NODE_ENV || 'development';
const jwtSecret = process.env.JWT_SECRET || 'dev-secret-change-me';

const config = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv,
  jwtSecret,
  jwtExpires: process.env.JWT_EXPIRES || '30d',
  // The single driver account for this service. Gate-keeping driver signup and
  // the driver-only routes to this phone is what stops a stranger registering
  // as "the driver" and seeing other customers' bookings.
  driverPhone: process.env.DRIVER_PHONE || '+27000000000',
  // ClickSend delivers the OTP SMS. The API authenticates with the account
  // username + API key (Basic auth). `from` is optional (alpha tag must be
  // WASPA-registered for SA; leave blank to use the account's default sender).
  clickSend: {
    username: process.env.CLICKSEND_USERNAME,
    apiKey: process.env.CLICKSEND_API_KEY,
    from: process.env.SMS_FROM,
    source: process.env.SMS_SOURCE || 'DriveLocal',
  },
  yoco: {
    publishableKey: process.env.YOCO_PUBLISHABLE_KEY,
    secretKey: process.env.YOCO_SECRET_KEY,
    webhookSecret: process.env.YOCO_WEBHOOK_SECRET,
    apiBase: process.env.YOCO_API_BASE || 'https://payments.yoco.com/api',
    successUrl: process.env.YOCO_SUCCESS_URL || 'http://localhost:5173/?payment=success',
    cancelUrl: process.env.YOCO_CANCEL_URL || 'http://localhost:5173/?payment=cancelled',
  },
  webPush: {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT || 'mailto:driver@drivelocal.co.za',
  },
  platformFeePercent: parseFloat(process.env.PLATFORM_FEE_PERCENT || '10'),
  // Grace period before auto-offlining a disconnected driver. Page refreshes,
  // brief network blips and dev restarts reconnect within a few seconds, so we
  // wait before assuming the driver actually went away.
  autoOfflineGraceMs: parseInt(process.env.AUTO_OFFLINE_GRACE_MS || '60000', 10),
  currency: process.env.CURRENCY || 'zar',
  dbDriver: process.env.DB_DRIVER || 'sqlite',
  databaseUrl: process.env.DATABASE_URL,
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174,http://localhost:5175')
    .split(',').map((s) => s.trim()).filter(Boolean),
};

// Fail fast in production: never run with a known default secret, without SMS
// delivery for OTPs, or without the owner-driver phone configured.
if (nodeEnv === 'production') {
  const problems = [];
  if (!jwtSecret || jwtSecret === 'dev-secret-change-me' || jwtSecret.length < 32) {
    problems.push('JWT_SECRET must be a strong random secret (32+ characters)');
  }
  if (!process.env.CLICKSEND_USERNAME || !process.env.CLICKSEND_API_KEY) {
    problems.push('ClickSend credentials (CLICKSEND_USERNAME / CLICKSEND_API_KEY) are required to deliver OTP SMS');
  }
  if (!process.env.DRIVER_PHONE) {
    problems.push('DRIVER_PHONE must be set to the owner-driver phone in E.164 format');
  }
  if (problems.length) {
    throw new Error(`DriveLocal refuses to start in production:\n - ${problems.join('\n - ')}`);
  }
} else if (!jwtSecret || jwtSecret === 'dev-secret-change-me') {
  // Development convenience: keep running, but make it obvious the default secret
  // is in use so nobody accidentally ships it to a public server.
  console.warn('[config] ⚠ JWT_SECRET is not set — using the insecure dev default. Tokens issued now can be forged by anyone who reads the source.');
}

module.exports = config;