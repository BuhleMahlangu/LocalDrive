// Server-side app config that the client needs before signing in
// (GET /api/public/config): the OTP delivery channel tells the login screen
// whether it must collect an email address (email-only deployments) and lets it
// show accurate "we sent your code to …" copy. Contains no secrets.
import { api } from '../api.js';

const DEFAULT = { otpDelivery: 'sms' };

let cache = null;
let inflight = null;

export async function loadAppConfig() {
  if (cache) return cache;
  if (!inflight) {
    inflight = api('/public/config')
      .then((r) => {
        cache = { ...DEFAULT, otpDelivery: (r && r.otpDelivery) || 'sms' };
        return cache;
      })
      .catch(() => DEFAULT)
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export default { loadAppConfig, DEFAULT };
