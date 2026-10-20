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
  // Grace period before auto-offlining a disconnected driver. Page refreshes,
  // brief network blips and dev restarts reconnect within a few seconds, so we
  // wait before assuming the driver actually went away.
  autoOfflineGraceMs: parseInt(process.env.AUTO_OFFLINE_GRACE_MS || '60000', 10),
  currency: process.env.CURRENCY || 'zar',
  dbDriver: process.env.DB_DRIVER || 'sqlite',
  databaseUrl: process.env.DATABASE_URL,
  // The town/area the app operates in. Shown as the default map centre and the
  // bounds the map is limited to. The owner can change it at runtime in
  // Admin → Settings (stored in the `settings` table); these env values are the
  // fallback used before the owner sets one.
  serviceArea: {
    name: process.env.SERVICE_AREA_NAME || '',
    lat: parseFloat(process.env.SERVICE_AREA_LAT || '0'),
    lng: parseFloat(process.env.SERVICE_AREA_LNG || '0'),
    radiusKm: parseFloat(process.env.SERVICE_AREA_RADIUS_KM || '30'),
  },
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY,
  bankDetailsKey: process.env.BANK_DETAILS_KEY,
  payoutWebhookSecret: process.env.PAYOUT_WEBHOOK_SECRET,
  smtp: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true' || process.env.SMTP_PORT === '465',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    from: process.env.SMTP_FROM || process.env.SMTP_USER || 'DriveLocal <no-reply@drivelocal.co.za>',
    replyTo: process.env.SMTP_REPLY_TO,
  },
  // Real SMS OTP delivery (see services/sms.js). Set SMS_PROVIDER to one of
  // 'whatsapp' | 'africastalking' | 'twilio' | 'clicksend' plus that provider's
  // credentials. In development and tests, messages are logged to the console
  // instead of sent unless SMS_FORCE=true (so local work never burns SMS credit).
  sms: {
    provider: process.env.SMS_PROVIDER,
    // Force real sending in dev/test (used by the E2E smoke run to assert the
    // exact HTTP request per provider). Without it dev/test log only.
    force: process.env.SMS_FORCE === 'true',
    // WhatsApp Cloud API (Meta) — preferred for SA: free tier, cheapest OTPs.
    whatsappToken: process.env.WHATSAPP_ACCESS_TOKEN,
    whatsappPhoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
    whatsappOtpTemplate: process.env.WHATSAPP_OTP_TEMPLATE,
    whatsappTemplateLang: process.env.WHATSAPP_TEMPLATE_LANG || 'en',
    atApiKey: process.env.AT_API_KEY,
    atUsername: process.env.AT_USERNAME,
    atSenderId: process.env.AT_SENDER_ID,
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID,
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN,
    twilioFrom: process.env.TWILIO_FROM,
    clicksendUser: process.env.CLICKSEND_USERNAME,
    clicksendApiKey: process.env.CLICKSEND_API_KEY,
    clicksendFrom: process.env.CLICKSEND_FROM || process.env.SMS_FROM,
  },
  // Public OSRM demo server. Used whenever no GOOGLE_MAPS_API_KEY is configured
  // so routes follow real roads instead of a straight line. Point this at your
  // own OSRM instance (self-hosted or paid) for production traffic — the demo
  // server has no uptime or rate-limit guarantee.
  osrmBaseUrl: process.env.OSRM_BASE_URL || 'https://router.project-osrm.org',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:5174,http://localhost:5175')
    .split(',').map((s) => s.trim()).filter(Boolean),
};

// Env-level readiness checks (kept here, not imported from sms.js/email.js, to
// avoid a config <-> service circular import).
function otpEmailReady() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function otpSmsReady() {
  switch (process.env.SMS_PROVIDER) {
    case 'whatsapp': return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
    case 'africastalking': return !!(process.env.AT_API_KEY && process.env.AT_USERNAME);
    case 'twilio': return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
    case 'clicksend': return !!(process.env.CLICKSEND_USERNAME && process.env.CLICKSEND_API_KEY);
    default: return false;
  }
}

// Fail fast in production: never run with a known default secret or without the
// owner-driver phone configured.
if (nodeEnv === 'production') {
  const problems = [];
  if (!jwtSecret || jwtSecret === 'dev-secret-change-me' || jwtSecret.length < 32) {
    problems.push('JWT_SECRET must be a strong random secret (32+ characters)');
  }
  if (!process.env.DRIVER_PHONE) {
    problems.push('DRIVER_PHONE must be set to the owner-driver phone in E.164 format');
  }
  // The app needs a town to serve, otherwise maps open nowhere and the service
  // radius check has no centre. Set it in the environment or in Admin → Settings
  // (the settings row wins, so this only guards a truly unconfigured deploy).
  const hasAreaEnv = Number.isFinite(config.serviceArea.lat) && Number.isFinite(config.serviceArea.lng)
    && (config.serviceArea.lat !== 0 || config.serviceArea.lng !== 0);
  if (!hasAreaEnv) {
    problems.push('SERVICE_AREA_LAT and SERVICE_AREA_LNG must be set to the town centre (or configure it in Admin → Settings before going live)');
  }
  // A real login code needs a real delivery path: SMS (see services/sms.js) or
  // email OTP via SMTP. There is no fixed-code fallback in production — without
  // a delivery path nobody could sign in, and a static code would let anyone
  // sign in as anyone.
  if (!otpSmsReady() && !otpEmailReady()) {
    problems.push('No OTP delivery path configured — set SMS_PROVIDER + credentials (see .env.example), or SMTP_HOST/SMTP_USER/SMTP_PASS for email OTP');
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