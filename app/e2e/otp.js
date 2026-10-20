// Reads the random OTP that the backend logs to its console when no real
// SMS/email provider is configured (the e2e normal case). Mirrors the candidate
// log files used by backend/scripts/smoke.js.
//
// There is no fixed code any more, so e2e logins must read the code the server
// actually generated for the phone they just requested it for.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function logCandidates() {
  return [
    process.env.SMS_LOG_FILE,
    path.join(here, '..', '..', 'backend-dev.log'),
    path.join(here, '..', '..', 'dev.out.log'),
  ].filter(Boolean);
}

// The most recent 6-digit code logged for `phone`, or null.
export function latestOtp(phone) {
  const normalized = String(phone).replace(/[^+\d]/g, '');
  let best = null;
  for (const file of logCandidates()) {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const re = new RegExp(`To ${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\D.*?(\\d{6})`, 'g');
    let m;
    while ((m = re.exec(content)) !== null) best = m[1];
  }
  return best;
}

// Poll until the code for `phone` appears (the server logs it asynchronously).
export async function waitForOtp(phone, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const code = latestOtp(phone);
    if (code) return code;
    if (Date.now() > deadline) {
      throw new Error(`No dev OTP found for ${phone}. Is the backend running in dev mode with its output in backend-dev.log?`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}
