// SMS/OTP delivery abstraction.
//
// Configure one provider via env (see .env.example) and OTP codes are sent as
// real SMS with a random per-request code. With no provider configured this
// falls back to logging the message to the server console and the interim
// fixed code 123456 (development only — see services/auth.js + config).
//
// Supported providers (SMS_PROVIDER):
//   - africastalking  Africa's Talking (SA + rest of Africa) — AT_API_KEY, AT_USERNAME, optional AT_SENDER_ID
//   - twilio          Twilio           — TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
//   - clicksend       ClickSend        — CLICKSEND_USERNAME, CLICKSEND_API_KEY, optional CLICKSEND_FROM
//
// All three are plain HTTP APIs, so we use the built-in fetch (Node >= 18).
// Callers only rely on `send()` throwing on failure, so adding a provider is
// contained to this file.

const config = require('../config');

function isConfigured() {
  const s = config.sms;
  if (!s || !s.provider) return false;
  switch (s.provider) {
    case 'africastalking': return !!(s.atApiKey && s.atUsername);
    case 'twilio': return !!(s.twilioAccountSid && s.twilioAuthToken && s.twilioFrom);
    case 'clicksend': return !!(s.clicksendUser && s.clicksendApiKey);
    default: return false;
  }
}

// True when an OTP would actually leave the device: a provider is configured
// and we're not in the development/test console-only fallback (see send()).
function deliversReal() {
  return isConfigured() && !consoleOnly();
}

// Development and test never send for real (no credit burned, no network in
// CI) unless SMS_FORCE=true explicitly forces it.
function consoleOnly() {
  const env = config.nodeEnv;
  return !config.sms.force && (env === 'development' || env === 'test');
}

function providerName() {
  return deliversReal() ? config.sms.provider : null;
}

// Providers expect bare E.164 without dashes/spaces.
function normalize(to) {
  return String(to || '').replace(/[^\d+]/g, '');
}

async function sendAfricasTalking({ to, body }, s) {
  const res = await fetch('https://api.africastalking.com/version1/messaging', {
    method: 'POST',
    headers: {
      apiKey: s.atApiKey,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({
      username: s.atUsername,
      to: normalize(to),
      message: body,
      ...(s.atSenderId ? { from: s.atSenderId } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Africa's Talking error ${res.status}: ${data.message || data.error || 'send failed'}`);
  }
  const recipient = data?.SMSMessageData?.Recipients?.[0];
  if (recipient && !['Sent', 'Queued'].includes(recipient.status)) {
    throw new Error(`Africa's Talking rejected the message: ${recipient.status} ${recipient.errorCode ? `(${recipient.errorCode})` : ''}`.trim());
  }
  return { queued: true, provider: 'africastalking', messageId: recipient?.messageId };
}

async function sendTwilio({ to, body }, s) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${s.twilioAccountSid}/Messages.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${s.twilioAccountSid}:${s.twilioAuthToken}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: normalize(to), From: s.twilioFrom, Body: body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Twilio error ${res.status}: ${data.message || 'send failed'}`);
  }
  return { queued: true, provider: 'twilio', messageId: data.sid };
}

async function sendClicksend({ to, body }, s) {
  const res = await fetch('https://rest.clicksend.com/v3/sms/send', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${s.clicksendUser}:${s.clicksendApiKey}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{
        source: 'sdk',
        from: s.clicksendFrom || undefined,
        to: normalize(to),
        body,
      }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`ClickSend error ${res.status}: ${data.response?.message || data.message || 'send failed'}`);
  }
  const msg = data?.data?.messages?.[0];
  if (msg && String(msg.status).toLowerCase() !== 'queued') {
    throw new Error(`ClickSend rejected the message: ${msg.status} ${msg.status_code ? `(${msg.status_code})` : ''}`.trim());
  }
  return { queued: true, provider: 'clicksend', messageId: msg?.message_id };
}

async function send({ to, body }) {
  const s = config.sms;
  if (isConfigured() && !consoleOnly()) {
    switch (s.provider) {
      case 'africastalking': return sendAfricasTalking({ to, body }, s);
      case 'twilio': return sendTwilio({ to, body }, s);
      case 'clicksend': return sendClicksend({ to, body }, s);
      default: break;
    }
  }
  // Development default (or no provider configured): log instead of sending so
  // local work never burns SMS credit. Set SMS_SEND_IN_DEV=true to send for
  // real from a dev machine (e.g. testing a ClickSend integration).
  const why = isConfigured() ? 'dev mode — SMS not sent' : 'no provider configured';
  console.log(`[sms] (${why}) To ${to}: ${body}`);
  return { logged: true };
}

module.exports = { send, isConfigured, deliversReal, providerName };
