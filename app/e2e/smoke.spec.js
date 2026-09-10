// @ts-check
const { test, expect } = require('@playwright/test');

// Owner driver phone + service-area centre (mirrors config on the backend).
const DRIVER_PHONE = process.env.VITE_DRIVER_PHONE || '+27000000000';
const OTP = '123456'; // fixed dev code (backend must run with NODE_ENV=development)

// One-browser-per-role smoke of the core loop: driver online -> customer books
// -> driver accepts -> customer sees "Driver on the way".
test.describe.configure({ mode: 'serial' });

test('core booking loop: driver online + accept, customer books + sees ETA', async ({ browser }) => {
  // ---- driver context (owner dashboard) ----
  const driverCtx = await browser.newContext();
  const driver = await driverCtx.newPage();
  await login(driver, { role: 'driver', phone: DRIVER_PHONE });

  await expect(driver.locator('.dash-header')).toBeVisible();
  await driver.locator('.switch input[type="checkbox"]').check();
  await expect(driver.locator('.switch input[type="checkbox"]')).toBeChecked();
  // Dashboard poll fires on /driver/online + socket connect; give it a beat.
  await expect(driver.locator('.online-panel')).toContainText('online');

  // ---- customer context (guest role) ----
  const custCtx = await browser.newContext();
  // Fresh context: pre-mark onboarding as seen so it never blocks the UI.
  await custCtx.addInitScript(() => {
    localStorage.setItem('drivelocal_onboarded', '1');
    localStorage.setItem('drivelocal_theme', 'light');
  });
  const cust = await custCtx.newPage();
  await login(cust, { role: 'customer', phone: '+27123456789', name: 'Thandi' });

  await expect(cust.locator('.topbar')).toBeVisible();
  await cust.locator('.book-hero .btn.primary.big').click();
  await expect(cust.locator('.leaflet-container')).toBeVisible();

  // Pickup: tap the first green pickup-spot marker (sets a real spot in-area).
  const marker = cust.locator('.leaflet-marker-icon').first();
  await expect(marker).toBeVisible();
  await marker.click();
  // The pickup address field (first readonly input) fills with the spot name.
  await expect(cust.locator('label.field input[readonly]').first()).not.toHaveValue('');

  // Destination: tap just off the middle of the map (within the service area)
  // to drop a pin — activePin is "destination" so this never re-sets pickup.
  const map = cust.locator('.leaflet-container');
  const box = await map.boundingBox();
  await map.click({ position: { x: box.width / 2, y: box.height / 2 + 30 } });

  // Estimate should resolve via the fare engine.
  const amount = cust.locator('.estimate-bar .estimate-amount');
  await expect(amount).toBeVisible();
  await expect(amount).toHaveText(/^R?\d/);

  // Review -> confirm the booking.
  await cust.locator('.estimate-bar .btn.primary').click();
  await cust.locator('.modal-card .btn.primary.big').click();

  // Customer is now on the active-trip screen waiting for the driver.
  await expect(cust.locator('.book-header h1')).toHaveText('Booking requested');

  // ---- driver accepts within the 10s auto-decline window ----
  const accept = driver.locator('.request-overlay .btn.primary, .request-card .btn.primary').first();
  await accept.click({ timeout: 15_000 });

  // Customer's ActiveTrip flips to accepted via socket.
  await expect(cust.locator('.book-header h1')).toHaveText('Driver on the way', { timeout: 15_000 });
  await expect(cust.locator('.trip-card')).toContainText('on the way');

  await custCtx.close();
  await driverCtx.close();
});

// Quick logout sanity: the link-btn in the customer topbar clears the session.
test('customer can log out back to the landing page', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    localStorage.setItem('drivelocal_onboarded', '1');
  });
  const page = await ctx.newPage();
  await login(page, { role: 'customer', phone: '+27123456789', name: 'Thandi' });
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page.locator('.landing-screen')).toBeVisible();
  await ctx.close();
});

async function login(page, { role, phone, name = 'Test User' }) {
  const isDriver = role === 'driver';
  await page.goto('/');
  await expect(page.locator('.landing-screen')).toBeVisible();

  // Landing has two big buttons: customer (primary) and driver.
  if (isDriver) {
    await page.locator('.landing-card .btn.driver.big').click();
  } else {
    await page.locator('.landing-card .btn.primary.big').click();
  }

  await expect(page.locator('.login-screen')).toBeVisible();
  await page.locator('input[type="tel"]').fill(phone);
  await page.locator('form.card button.btn').click();
  await expect(page.locator('form.card button.btn')).toBeDisabled().catch(() => {});

  await page.locator('input[inputmode="numeric"]').fill(OTP);
  await page.locator('input[placeholder="Thabo"]').fill(name);
  await page.locator('form.card button.btn').click();

  if (isDriver) {
    await expect(page.locator('.dash-header')).toBeVisible({ timeout: 20_000 });
  } else {
    await expect(page.locator('.topbar')).toBeVisible({ timeout: 20_000 });
  }
}