const config = require('../config');

// SMS provider abstraction.
// In development (no Twilio creds), OTPs are logged to the console.
// In production, OTPs are sent via Twilio.

class SmsProvider {
  async send({ to, body }) {
    if (!config.twilio.accountSid || !config.twilio.authToken) {
      if (config.nodeEnv === 'production') {
        console.error('[sms] Twilio not configured - OTP would not be sent in production!');
      } else {
        console.log(`[sms:dev] To ${to}: ${body}`);
      }
      return { dev: true };
    }
    return this._sendViaTwilio({ to, body });
  }

  async _sendViaTwilio({ to, body }) {
    const twilio = require('twilio');
    const client = twilio(config.twilio.accountSid, config.twilio.authToken);
    const from = config.twilio.from;
    try {
      if (!from) throw new Error('TWILIO_FROM_NUMBER is not set');
      const message = await client.messages.create({
        to,
        from,
        body,
      });
      console.log(`[sms] Sent to ${to} (sid ${message.sid})`);
      return { ok: true, sid: message.sid };
    } catch (e) {
      console.error('[sms] Twilio send failed:', e.message);
      throw e;
    }
  }
}

module.exports = new SmsProvider();
