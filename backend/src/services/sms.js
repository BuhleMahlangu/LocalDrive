// SMS provider abstraction (ClickSend).
// In any non-production environment, OTPs are logged to the console (never sent
// to the real ClickSend API) so local development works without an account.
// In production, OTPs are delivered via ClickSend's v3 REST API (Basic auth:
// account username + API key).

const config = require('../config');

const API_BASE = 'https://rest.clicksend.com/v3';
const REQUEST_TIMEOUT_MS = 15000;

class SmsProvider {
  assertConfigured() {
    if (config.nodeEnv !== 'production') return;
    if (!config.clickSend.username || !config.clickSend.apiKey) {
      throw new Error('ClickSend is not configured (CLICKSEND_USERNAME / CLICKSEND_API_KEY)');
    }
  }

  async send({ to, body }) {
    this.assertConfigured();
    if (config.nodeEnv !== 'production') {
      console.log(`[sms:dev] To ${to}: ${body}`);
      return { dev: true };
    }

    const auth = 'Basic ' + Buffer.from(`${config.clickSend.username}:${config.clickSend.apiKey}`).toString('base64');
    const message = {
      source: config.clickSend.source || 'DriveLocal',
      body,
      to,
    };
    if (config.clickSend.from) message.from = config.clickSend.from;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${API_BASE}/sms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ messages: [message] }),
        signal: controller.signal,
      });
    } catch (e) {
      throw new Error(`ClickSend request failed: ${e.name === 'AbortError' ? 'timed out' : e.message}`);
    } finally {
      clearTimeout(timer);
    }

    const json = await res.json().catch(() => ({}));
    const code = String(json.response_code || '').toUpperCase();
    if (!res.ok || code !== 'SUCCESS') {
      const msg = String(json.response_msg || `HTTP ${res.status}`).replace(/^"/, '');
      throw new Error(`ClickSend send failed: ${msg}`);
    }

    // ClickSend returns envelope SUCCESS even when individual messages are not
    // queued (e.g. INSUFFICIENT_CREDIT, REJECTED). The real outcome is per
    // message: queued_count tells us whether delivery was actually accepted.
    const first = (json.data?.messages || [])[0];
    const queued = Number.isInteger(json.data?.queued_count)
      ? json.data.queued_count
      : (first ? 1 : 0);
    const perMessageStatus = String(first?.status || '').toUpperCase();
    if (queued < 1) {
      throw new Error(`ClickSend did not queue the message: ${perMessageStatus || `queued_count=${queued}`}`);
    }

    console.log(`[sms] Queued to ${to}: ${body}`);
    return { ok: true, status: perMessageStatus || 'QUEUED', messageId: first?.message_id };
  }
}

module.exports = new SmsProvider();