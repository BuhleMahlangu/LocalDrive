// Login is phone + a 6-digit PIN (no OTP). The e2e specs use dedicated test
// phone numbers that are freshly created on first run, so a deterministic PIN
// per phone lets a spec both create the account and sign back in on a re-run.

// The 6-digit PIN derived from a phone number (last 6 digits, zero-padded).
export function pinFor(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return digits.slice(-6).padStart(6, '0');
}

// Drive the login UI for a phone number: choose the role, enter the phone, then
// either create the PIN (first time) or enter it (returning). Leaves the page on
// the signed-in screen.
export async function loginWithPin(page, { role, phone, name = 'Test User' }) {
  const isDriver = role === 'driver';
  const pin = pinFor(phone);

  await page.goto('/');
  await page.locator(isDriver ? '.landing-card .btn.driver.big' : '.landing-card .btn.primary.big').click();
  await page.locator('.login-screen').waitFor();
  await page.locator('input[type="tel"]').fill(phone);
  await page.locator('form.card button.btn').click();

  // The server tells the client whether this number already has a PIN. Either
  // way the next screen has a PIN field; the setup step adds name + confirm.
  await page.locator('input[type="password"]').first().waitFor();
  const confirm = page.locator('input[placeholder="Thabo"]');
  const onSetup = await confirm.count() > 0;

  if (onSetup) {
    await page.locator('input[placeholder="Thabo"]').fill(name);
    const pins = page.locator('input[type="password"]');
    await pins.nth(0).fill(pin);
    await pins.nth(1).fill(pin);
  } else {
    await page.locator('input[type="password"]').first().fill(pin);
  }
  await page.locator('form.card button.btn').click();
}

export default { pinFor, loginWithPin };
