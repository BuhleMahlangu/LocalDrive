// @ts-check
import { test, expect } from '@playwright/test';

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
  // The switch input is a visually-hidden checkbox (opacity 0), so click the
  // visible slider inside its label — the same gesture a real user does. The
  // driver's real state may have been left online by a previous run, so only
  // toggle when the switch isn't already on.
  const onlineSwitch = driver.locator('.switch input[type="checkbox"]');
  if (!(await onlineSwitch.isChecked())) {
    await driver.locator('.switch .slider').click();
    await expect(onlineSwitch).toBeChecked();
  }
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

  // The backend server may be reused across local runs (config reuses an
  // already-running server), so a previously accepted trip can still be "active".
  // Leave a clean slate: cancel any leftover active trip before booking.
  await cust.evaluate(async () => {
    const api = async (path, opts = {}) => {
      const res = await fetch(`/api${path}`, {
        ...opts,
        headers: { ...opts.headers, Authorization: `Bearer ${localStorage.getItem('drivelocal_token')}` },
      });
      return res.json();
    };
    try {
      const { trip } = await api('/customer/trips/active');
      if (trip && trip.status !== 'completed' && trip.status !== 'cancelled') {
        await api(`/customer/trips/${trip.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'Test cleanup' }), headers: { 'Content-Type': 'application/json' } });
      }
    } catch { /* ignore */ }
  });

  await expect(cust.locator('.topbar')).toBeVisible();
  await cust.locator('.book-hero .btn.primary.big').click();
  await expect(cust.locator('.leaflet-container')).toBeVisible();

  // Pickup: tap the first green pickup-spot marker (sets a real spot in-area).
  // The map sits below the fold, so scroll it into view first. Leaflet's
  // divIcon markers trip Playwright's hit-target check (the inner dot is the
  // paint target inside the interactive wrapper), so click by raw screen
  // coordinates — the browser targets the dot, which bubbles to the Leaflet
  // marker handler that selects the pickup spot.
  const marker = cust.locator('.leaflet-marker-icon.spot-icon').first();
  await expect(marker).toBeVisible();
  await marker.scrollIntoViewIfNeeded();
  const spotBox = await marker.boundingBox();
  await cust.mouse.click(spotBox.x + spotBox.width / 2, spotBox.y + spotBox.height / 2);
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
  await expect(cust.locator('.book-header h1').filter({ visible: true })).toHaveText('Booking requested');

  // ---- driver accepts within the 10s auto-decline window ----
  const accept = driver.locator('.request-overlay .btn.primary, .request-card .btn.primary').first();
  await accept.click({ timeout: 15_000 });

  // Customer's ActiveTrip flips to accepted via socket.
  await expect(cust.locator('.book-header h1').filter({ visible: true })).toHaveText('Driver on the way', { timeout: 15_000 });
  await expect(cust.locator('.trip-card')).toContainText('on the way');

  await custCtx.close();
  await driverCtx.close();
});

// The preset green dots are not pickup-only. With no pickup chosen yet the first
// dot must set the pickup; once a pickup exists the same dots become valid
// drop-offs.
test('a preset spot can be the drop-off, not just the pickup', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    localStorage.setItem('drivelocal_onboarded', '1');
    localStorage.setItem('drivelocal_theme', 'light');
  });
  const page = await ctx.newPage();
  await login(page, { role: 'customer', phone: '+27123456801', name: 'Lerato' });

  await expect(page.locator('.topbar')).toBeVisible();
  await page.locator('.book-hero .btn.primary.big').click();
  await expect(page.locator('.leaflet-container')).toBeVisible();

  const spotNames = await page.evaluate(async () => {
    const r = await fetch('/api/pickup-spots');
    const j = await r.json();
    return j.spots.map((s) => s.name).filter(Boolean);
  });
  expect(spotNames.length).toBeGreaterThanOrEqual(2);

  const spots = page.locator('.leaflet-marker-icon.spot-icon');
  await expect(spots.first()).toBeVisible();
  expect(await spots.count()).toBeGreaterThanOrEqual(2);

  // Same divIcon hit-target workaround as the smoke test above. The map sits
  // below the fold, so each marker has to be scrolled into view before its box
  // is measured, and re-measured for every click (scrolling moves the rest).
  const clickSpot = async (i) => {
    const marker = spots.nth(i);
    await expect(marker).toBeVisible();
    await marker.scrollIntoViewIfNeeded();
    const b = await marker.boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  };

  // Address inputs only. The pickup input is wrapped in `.field-row` (it has the
  // 🎯 button beside it), the destination is a direct child, and both cards also
  // render a nested `.gps-link-row` pin readout that must not be matched.
  const addressInputs = page.locator(
    'label.field > div.field-row > input[readonly], label.field > input[readonly]',
  );
  const pickupField = addressInputs.first();
  const destField = addressInputs.nth(1);

  // Nothing chosen yet, so the first green dot is the pickup.
  await clickSpot(0);
  await expect(pickupField).not.toHaveValue('');
  expect(spotNames).toContain(await pickupField.inputValue());
  await expect(destField).toHaveValue('');

  // The destination pin is the active one by default, so the next green dot
  // becomes the drop-off — and it is named like a spot, not a blank raw pin.
  await clickSpot(1);
  await expect(destField).not.toHaveValue('');
  expect(spotNames).toContain(await destField.inputValue());

  await ctx.close();
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