// @ts-check
import { test, expect } from '@playwright/test';

// Map regressions that only show up in a real browser: tiles actually painting,
// and the live-tracking marker being *moved* rather than destroyed and rebuilt.
//
// The second one is the important one. Markers used to be keyed on their
// coordinates, so every GPS frame removed the driver pin and constructed a new
// one. The car teleported, its icon animation could never run, and a tooltip
// would blink out and back. These tests assert the DOM node survives an update.

const DRIVER_PHONE = process.env.VITE_DRIVER_PHONE || '+27000000000';
const OTP = '123456';

const AREA = { lat: -26.2155, lng: 29.2916 };

test.describe.configure({ mode: 'serial' });

test('map tiles load and carry the required OpenStreetMap attribution', async ({ browser }) => {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { localStorage.setItem('drivelocal_onboarded', '1'); });
  const page = await ctx.newPage();

  // Any tile the browser cannot load is a real defect, not test noise — surface
  // it as a failure rather than letting a grey grid pass as "map visible".
  // These tiles come from the live openstreetmap.org servers, so the responses
  // are recorded as evidence: when the paint check below fails, the difference
  // between "we asked for a URL that does not exist" and "OSM was slow" has to
  // be visible in the failure message.
  const failed = [];
  const note = (kind, detail) => failed.push(`${kind}: ${detail}`);
  page.on('response', (res) => {
    if (/tile\.openstreetmap\.org/.test(res.url()) && res.status() >= 400) {
      note(String(res.status()), res.url());
    }
  });
  page.on('requestfailed', (req) => {
    if (/tile\.openstreetmap\.org/.test(req.url())) {
      note('requestfailed', `${req.url()} (${req.failure()?.errorText || 'unknown'})`);
    }
  });

  await page.goto('/');
  await expect(page.locator('.landing-screen')).toBeVisible();
  await page.locator('.landing-card .btn.primary.big').click();
  await expect(page.locator('.login-screen')).toBeVisible();
  await page.locator('input[type="tel"]').fill('+27710001122');
  await page.locator('form.card button.btn').click();
  await page.locator('input[inputmode="numeric"]').fill(OTP);
  await page.locator('input[placeholder="Thabo"]').fill('Map Tester');
  await page.locator('form.card button.btn').click();
  await expect(page.locator('.topbar')).toBeVisible({ timeout: 20_000 });

  await page.locator('.book-hero .btn.primary.big').click();
  const map = page.locator('.leaflet-container');
  await expect(map).toBeVisible();

  // The OSM tile usage policy requires visible attribution. Checked first
  // because it is pure DOM and cannot be blamed on the network.
  await expect(page.locator('.leaflet-control-attribution')).toContainText('OpenStreetMap');

  // Tiles are only counted once decoded, so this means the basemap really
  // painted rather than just the container existing. Retried, because a
  // third-party tile server being briefly unreachable is not an app defect —
  // but a hard failure is reported together with the responses behind it.
  try {
    await expect(async () => {
      const loaded = await map.locator('.leaflet-tile-loaded').count();
      expect(loaded, 'decoded OpenStreetMap tiles').toBeGreaterThan(0);
    }).toPass({ timeout: 45_000 });
  } catch (err) {
    throw new Error(`no map tiles painted. Tile responses seen: ${failed.length ? failed.join('\n') : 'none (the requests never came back at all)'}`);
  }

  expect(failed, `tile requests failed:\n${failed.join('\n')}`).toEqual([]);

  await ctx.close();
});

test('the driver marker is moved, not rebuilt, and the map follows it', async ({ browser }) => {
  const driverCtx = await browser.newContext();
  await driverCtx.grantPermissions(['geolocation'], { origin: 'http://localhost:5173' });
  // Set the simulated position BEFORE the driver ever navigates, so the very
  // first watchPosition fix is a real one and the stream is proven live before
  // any booking exists.
  await driverCtx.setGeolocation({ latitude: AREA.lat - 0.010, longitude: AREA.lng, accuracy: 12 });
  const driver = await driverCtx.newPage();
  await login(driver, { role: 'driver', phone: DRIVER_PHONE });

  const onlineSwitch = driver.locator('.switch input[type="checkbox"]');
  if (!(await onlineSwitch.isChecked())) await driver.locator('.switch .slider').click();
  await expect(onlineSwitch).toBeChecked();
  // The driver's own map showing the car proves the whole publish path works.
  await expect(driver.locator('.leaflet-marker-icon.car-icon')).toBeVisible({ timeout: 20_000 });

  // ---- customer books, driver accepts ----
  const custCtx = await browser.newContext();
  await custCtx.addInitScript(() => {
    localStorage.setItem('drivelocal_onboarded', '1');
    localStorage.setItem('drivelocal_theme', 'light');
  });
  const cust = await custCtx.newPage();
  await login(cust, { role: 'customer', phone: '+27720002222', name: 'Nomvula' });

  // A locally reused backend can still be holding a trip from a previous run;
  // clear it or the booking below is rejected.
  await cust.evaluate(async () => {
    const call = async (path, opts = {}) => {
      const res = await fetch(`/api${path}`, {
        ...opts,
        headers: { ...opts.headers, Authorization: `Bearer ${localStorage.getItem('drivelocal_token')}` },
      });
      return res.json();
    };
    try {
      const { trip } = await call('/customer/trips/active');
      if (trip && !['completed', 'cancelled'].includes(trip.status)) {
        await call(`/customer/trips/${trip.id}/cancel`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'Test cleanup' }),
          headers: { 'Content-Type': 'application/json' },
        });
      }
    } catch { /* ignore */ }
  });

  await cust.locator('.book-hero .btn.primary.big').click();
  await expect(cust.locator('.leaflet-container')).toBeVisible();

  const spot = cust.locator('.leaflet-marker-icon.spot-icon').first();
  await spot.scrollIntoViewIfNeeded();
  const spotBox = await spot.boundingBox();
  await cust.mouse.click(spotBox.x + spotBox.width / 2, spotBox.y + spotBox.height / 2);
  await expect(cust.locator('label.field input[readonly]').first()).not.toHaveValue('');

  const map = cust.locator('.leaflet-container');
  const box = await map.boundingBox();
  await map.click({ position: { x: box.width / 2, y: box.height / 2 + 30 } });
  await expect(cust.locator('.estimate-bar .estimate-amount')).toBeVisible();
  await cust.locator('.estimate-bar .btn.primary').click();
  await expect(cust.locator('.modal-card')).toBeVisible();
  await cust.locator('.modal-card .btn.primary.big').click();

  await driver.locator('.request-overlay .btn.primary, .request-card .btn.primary').first().click({ timeout: 15_000 });
  await expect(cust.locator('.book-header h1').filter({ visible: true }))
    .toHaveText('Driver on the way', { timeout: 15_000 });

  // A locally reused backend can still hand the client a trip from an earlier
  // run. Pin down the trip we are actually following so the rest of the
  // assertions cannot silently be about somebody else's ride.
  // /customer/trips/active only reports accepted/ongoing trips, so read it
  // after the driver has accepted.
  const tripId = await cust.evaluate(async () => {
    const res = await fetch('/api/customer/trips/active', {
      headers: { Authorization: `Bearer ${localStorage.getItem('drivelocal_token')}` },
    });
    const { trip } = await res.json();
    return trip?.id ?? null;
  });
  expect(tripId, 'the customer should be on an accepted trip').toBeTruthy();

  // ---- the car reaches the customer's map ----
  // The driver only emits on a real GPS change, so they have to actually drive
  // once the trip exists. Every step is >5m, which clears the publish throttle.
  const car = cust.locator('.leaflet-marker-icon.car-icon');
  await drive(driverCtx, cust, tripId, AREA.lat - 0.008, AREA.lng + 0.002, 'first approach');
  await expect(car).toBeVisible({ timeout: 25_000 });
  // The trip:location event must survive the trip id being resolved after mount.
  await expect(cust.locator('.eta-chip')).toBeVisible({ timeout: 25_000 });

  // Tag the live DOM node. If the marker is rebuilt, this handle goes stale and
  // the assertions below fail — which is exactly the bug being guarded.
  await car.evaluate((el) => { el.dataset.probe = 'original'; });

  await drive(driverCtx, cust, tripId, AREA.lat - 0.004, AREA.lng + 0.005, 'closing in');
  await drive(driverCtx, cust, tripId, AREA.lat - 0.002, AREA.lng + 0.007, 'almost there');

  // The same element must still be on the map, still tagged, and still alone.
  await expect(cust.locator('.leaflet-marker-icon[data-probe="original"]')).toHaveCount(1, { timeout: 25_000 });
  await expect(cust.locator('.leaflet-marker-icon.car-icon')).toHaveCount(1);

  // Following is on by default, so the map pans to keep the car framed and the
  // customer never has to touch anything. In follow mode the car's layer-point
  // offset is deliberately pinned to the map centre, so assert that rather than
  // asserting the icon transform changed.
  await expect(cust.locator('.leaflet-control-recenter')).toBeHidden();
  await expect(async () => {
    const mapBox = await map.boundingBox();
    const carBox = await car.boundingBox();
    const dx = (carBox.x + carBox.width / 2) - (mapBox.x + mapBox.width / 2);
    const dy = (carBox.y + carBox.height / 2) - (mapBox.y + mapBox.height / 2);
    expect(Math.hypot(dx, dy), 'car should be framed by follow mode').toBeLessThan(90);
  }).toPass({ timeout: 25_000 });

  // Panning by hand hands control back to the customer and offers the button.
  // Re-measure: the trip map sits in a different place on the page than the
  // booking map these coordinates were taken from.
  const tripBox = await map.boundingBox();
  await cust.mouse.move(tripBox.x + tripBox.width / 2, tripBox.y + tripBox.height / 2);
  await cust.mouse.down();
  await cust.mouse.move(tripBox.x + tripBox.width / 2 - 120, tripBox.y + tripBox.height / 2 - 80, { steps: 8 });
  await cust.mouse.up();
  await expect(cust.locator('.leaflet-control-recenter')).toBeVisible({ timeout: 10_000 });
  // The booking screen stays mounted behind the trip, so scope to what is on
  // screen rather than matching its hidden status bar too.
  await expect(cust.locator('.map-status').filter({ visible: true }))
    .toContainText('follow the driver again');

  // With follow released the map stops compensating for the car, so a new
  // position now has to move the pin across the screen — on the very same DOM
  // node that was tagged before the first update.
  const parked = await car.evaluate((el) => el.style.transform);
  await drive(driverCtx, cust, tripId, AREA.lat - 0.001, AREA.lng + 0.010, 'driving on');
  await expect(async () => {
    expect(await car.evaluate((el) => el.style.transform)).not.toBe(parked);
  }).toPass({ timeout: 25_000 });
  await expect(cust.locator('.leaflet-marker-icon[data-probe="original"]')).toHaveCount(1);

  // Tapping the button hands the view back to follow mode.
  await cust.locator('.leaflet-control-recenter button').click();
  await expect(cust.locator('.leaflet-control-recenter')).toBeHidden({ timeout: 10_000 });

  await custCtx.close();
  await driverCtx.close();
});

// Moves the simulated driver and waits until the server has actually recorded
// the fix. Chromium's geolocation service drops into an error state under
// repeated CDP overrides, after which watchPosition simply stops firing and the
// driver sits still forever; re-applying the override recovers it. The server's
// copy of the location is the only honest signal that the whole publish path
// worked, so that is what we wait on rather than a sleep.
async function drive(ctx, cust, tripId, lat, lng, label) {
  const coords = { latitude: lat, longitude: lng, accuracy: 12 };
  const want = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const serverHas = () => cust.evaluate(async (id) => {
    const res = await fetch(`/api/public/trips/${id}/live`);
    const body = await res.json();
    return body.driverLoc ? `${body.driverLoc.lat.toFixed(4)},${body.driverLoc.lng.toFixed(4)}` : 'null';
  }, tripId);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await ctx.setGeolocation(coords);
    for (let poll = 0; poll < 8; poll += 1) {
      if (await serverHas() === want) return;
      await cust.waitForTimeout(400);
    }
  }
  throw new Error(`driver GPS never reached the server (${label}): wanted ${want}, server has ${await serverHas()}`);
}

async function login(page, { role, phone, name = 'Test User' }) {
  const isDriver = role === 'driver';
  await page.goto('/');
  await expect(page.locator('.landing-screen')).toBeVisible();
  await page.locator(isDriver ? '.landing-card .btn.driver.big' : '.landing-card .btn.primary.big').click();
  await expect(page.locator('.login-screen')).toBeVisible();
  await page.locator('input[type="tel"]').fill(phone);
  await page.locator('form.card button.btn').click();
  await page.locator('input[inputmode="numeric"]').fill(OTP);
  await page.locator('input[placeholder="Thabo"]').fill(name);
  await page.locator('form.card button.btn').click();
  if (isDriver) await expect(page.locator('.dash-header')).toBeVisible({ timeout: 20_000 });
  else await expect(page.locator('.topbar')).toBeVisible({ timeout: 20_000 });
}
