// Acquires a precise customer location using the browser geolocation API.
//
// getCurrentPosition gives a single, sometimes-inaccurate fix. The reported
// "accuracy" can lie: a Wi-Fi/cell fix can claim < 60 m while being kilometres
// off (the "Bethal trap"). To guard against this we sample a short burst of
// fixes and only accept a fix when consecutive samples are consistent (close in
// metres), which proves the position is real rather than a one-off glitch.
//
// When consistent fixes aren't available (e.g. weak signal, desktop WiFi) we
// still return the best fix we found rather than failing entirely — an
// approximate pin is better than no pin, and the customer can fine-tune it on
// the map. The green accuracy circle and "±N m" label tell them how much to
// trust it.
//
// Two-phase acquisition: run a burst with enableHighAccuracy:true (real GPS).
// If the browser can't produce even one fix (desktop with no GPS chip, indoors,
// Windows Wi-Fi positioning that turns up nothing), retry the whole burst once
// with high accuracy off — the coarser Wi-Fi/cell fix is most of what a laptop
// can get, and beats failing entirely. The customer can still fine-tune the pin
// by tapping the map (or re-tapping 🎯 for better GPS on a phone outdoors).
//
// Returns a Promise<{ lat, lng, accuracy }> of the accepted fix, or rejects
// when permission is denied, the API is unavailable, or no fix at all was
// obtained — the caller then falls back to manual pinning. We never guess
// when we have nothing.

const DESIRED_ACCURACY = 60;     // prefer a fix this good or better (m)
const CONSISTENT_DRIFT_M = 200;  // two fixes within this distance "agree"
const MAX_SAMPLES = 5;           // stop sampling after this many fixes
const PER_SAMPLE_TTL = 4;        // how long each getCurrentPosition call may take (s)
const OVERALL_TIMEOUT = 12 * 1000;

// Detect obvious refusals before the first getCurrentPosition call:
//  * non-secure context (http:// on LAN) → geolocation API missing entirely
//  * browser site permission saved as "blocked" → silent PERMISSION_DENIED
//  * OS location service disabled (Windows) → silent POSITION_UNAVAILABLE
async function geolocationBlockedReason() {
  if (!('geolocation' in navigator)) {
    return 'Location needs a secure connection (HTTPS or localhost) — tap the map to set your pickup instead.';
  }
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    if (status.state === 'denied') {
      return 'Location is blocked in your browser. Open the lock/settings icon next to the address bar, allow Location for this site, then try again.';
    }
  } catch {
    // navigator.permissions.query not supported; fall through to getCurrentPosition.
  }
  return null;
}

// One burst of consistent-fix sampling with a given accuracy mode. Resolves
// with a fix (accepting the best found once we run out of patience), rejects
// only when every attempt returned nothing at all in that mode.
function runBurst(enableHighAccuracy, minMeters) {
  return new Promise((resolve, reject) => {
    const samples = [];
    let done = false;
    let timer = 0;

    const finish = (err, point) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      if (err) reject(err);
      else resolve(point);
    };

    const bestAccuracy = (arr) => arr.reduce((a, b) => (b.accuracy < a.accuracy ? b : a));

    // Two fixes "agree" when their positions are close together — regardless
    // of what they claim their accuracy is. Consistency is a stronger signal
    // than the reported number.
    const consistent = (a, b) => metersApart(a, b) <= CONSISTENT_DRIFT_M;

    const decide = () => {
      const last = samples[samples.length - 1];
      const prev = samples.length >= 2 ? samples[samples.length - 2] : null;

      // Enough samples to check: if the last two agree, accept the latest
      // (it's the most converged, most recent GPS fix).
      if (samples.length >= 2 && prev && consistent(prev, last)) {
        // Accept if latest is at least as good as desired, or at least better
        // than the one before it (GPS improving over time = good sign).
        if (last.accuracy <= minMeters || last.accuracy <= prev.accuracy) {
          finish(null, last);
          return true;
        }
      }

      // Ran out of samples: return the best we found rather than failing
      // entirely. An approximate pin is better than no pin at all.
      if (samples.length >= MAX_SAMPLES) {
        finish(null, bestAccuracy(samples));
        return true;
      }

      return false;
    };

    const onSuccess = (pos) => {
      if (done) return;
      const { latitude, longitude, accuracy } = pos.coords;
      samples.push({
        lat: latitude,
        lng: longitude,
        accuracy: Number.isFinite(accuracy) ? accuracy : Infinity,
      });
      if (!decide()) acquire();
    };

    const onError = (err) => {
      if (done) return;
      // If we already gathered some samples, hand back the best one — still
      // better than nothing for the customer to fine-tune.
      if (samples.length) {
        finish(null, bestAccuracy(samples));
        return;
      }
      let message = 'geolocation-error';
      if (err && err.code === 1) message = 'permission-denied';
      else if (err && err.code === 2) message = 'position-unavailable';
      else if (err && err.code === 3) message = 'position-timeout';
      finish(new Error(message));
    };

    const acquire = () =>
      navigator.geolocation.getCurrentPosition(onSuccess, onError, {
        enableHighAccuracy,
        maximumAge: 0,
        timeout: PER_SAMPLE_TTL * 1000,
      });

    timer = window.setTimeout(() => {
      if (!done && samples.length) finish(null, bestAccuracy(samples));
      else if (!done) finish(new Error('position-timeout'));
    }, OVERALL_TIMEOUT);

    acquire();
  });
}

export default function geolocate(minMeters = DESIRED_ACCURACY) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('geolocation-unsupported'));
      return;
    }

    // Check whether the browser/OS will refuse us BEFORE we call getCurrentPosition
    // (e.g. site permission saved as blocked, or OS location service disabled).
    geolocationBlockedReason().then((blocked) => {
      if (blocked) {
        reject(new Error(blocked));
        return;
      }
      // Phase 1: precise GPS. If the browser can't produce even a single fix
      // (desktop, no GPS chip, indoors), retry with high accuracy off — the
      // Wi-Fi/cell fix is what most laptops can get.
      runBurst(true, minMeters).then(resolve, () => {
        runBurst(false, minMeters).then(resolve, reject);
      });
    }).catch(() => reject(new Error('geolocation-error')));
  });
}

// Approximate distance between two points in metres (haversine).
function metersApart(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la = (a.lat * Math.PI) / 180;
  const lb = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(la) * Math.cos(lb) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}