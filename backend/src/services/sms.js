// SMS/OTP delivery abstraction.
//
// No provider is wired up yet: the verification code is currently the fixed
// interim value `123456` in every environment (see services/auth.js), and this
// module only logs the message to the server console.
//
// TODO(integrate-otp): after deploying, plug a real OTP/SMS provider in here
// (e.g. ClickSend, Twilio, Vonage, Africa's Talking) and switch auth.js back to
// generating a random code per request. Callers only rely on `send()` throwing
// on failure, so the swap is contained to this file + requestOtp.

async function send({ to, body }) {
  console.log(`[sms] (no provider configured) To ${to}: ${body}`);
  return { logged: true };
}

module.exports = { send };
