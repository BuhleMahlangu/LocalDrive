// Shared point maths for the app. The haversine formula was previously
// copy-pasted into five screens with slightly different signatures, which meant
// the ETA a customer saw and the ETA a friend following the share link could
// quietly disagree. One implementation, one answer.

const EARTH_RADIUS_KM = 6371;
const EARTH_RADIUS_M = 6371000;

const toRad = (deg) => (deg * Math.PI) / 180;

function valid(a, b) {
  return !!a && !!b
    && Number.isFinite(a.lat) && Number.isFinite(a.lng)
    && Number.isFinite(b.lat) && Number.isFinite(b.lng);
}

// Great-circle distance between two {lat,lng} points, in kilometres.
export function haversineKm(a, b) {
  if (!valid(a, b)) return 0;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

// Same, in metres — for accuracy readouts and "how far is the car" labels.
export function haversineM(a, b) {
  return haversineKm(a, b) * 1000;
}

// Straight-line time estimate in whole minutes, matching the fare model on the
// server (2 min/km + 5 min) so the countdown tracks the driver as they close in.
export function etaMinutes(from, to) {
  if (!valid(from, to)) return null;
  return Math.max(1, Math.round(haversineKm(from, to) * 2 + 5));
}

// The closest of `points` to `origin`, or null when there are none. `points`
// entries may be {lat,lng,...} so a pickup spot can be returned whole.
export function nearestPoint(origin, points) {
  if (!Array.isArray(points) || points.length === 0) return null;
  let best = null;
  for (const p of points) {
    if (!valid(origin, p)) continue;
    const m = haversineM(origin, p);
    if (!best || m < best.m) best = { point: p, m };
  }
  return best;
}

export { EARTH_RADIUS_KM, EARTH_RADIUS_M };
