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
  // 'africastalking' | 'twilio' | 'clicksend' plus that provider's credentials.
  // In development, messages are logged to the console instead of sent unless
  // SMS_SEND_IN_DEV=true (so local work never burns SMS credit).
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
  // A real login code needs a real delivery path: SMS (see services/sms.js) or
  // email OTP via SMTP. Without one, the code stays the fixed 123456 and
  // anyone can sign in as any number. ALLOW_FIXED_OTP=true is a deliberate,
  // loud escape hatch for a private/closed beta.
  if (!otpSmsReady() && !otpEmailReady() && process.env.ALLOW_FIXED_OTP !== 'true') {
    problems.push('No OTP delivery path configured — set SMS_PROVIDER + credentials (see .env.example), or SMTP_HOST/SMTP_USER/SMTP_PASS for email OTP, or explicitly set ALLOW_FIXED_OTP=true for a closed beta');
  }
  if (problems.length) {
    throw new Error(`DriveLocal refuses to start in production:\n - ${problems.join('\n - ')}`);
  }
  if (!otpSmsReady() && !otpEmailReady()) {
    console.warn('[config] ⚠ ALLOW_FIXED_OTP=true — the verification code is fixed at 123456 for every number. Anyone who knows this can sign in as anyone. Do not expose this deployment publicly.');
  }
} else if (!jwtSecret || jwtSecret === 'dev-secret-change-me') {
  // Development convenience: keep running, but make it obvious the default secret
  // is in use so nobody accidentally ships it to a public server.
  console.warn('[config] ⚠ JWT_SECRET is not set — using the insecure dev default. Tokens issued now can be forged by anyone who reads the source.');
}

module.exports = config;