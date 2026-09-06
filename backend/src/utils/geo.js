const crypto = require('crypto');

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function now() {
  return new Date().toISOString();
}

// Haversine distance in km between two lat/lng points.
function haversineKm(la1, lo1, la2, lo2) {
  const R = 6371;
  const dLat = ((la2 - la1) * Math.PI) / 180;
  const dLon = ((lo2 - lo1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((la1 * Math.PI) / 180) *
      Math.cos((la2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Straight-line distance with a road-factor applied to approximate driving km.
function estimatedRoadKm(la1, lo1, la2, lo2) {
  const direct = haversineKm(la1, lo1, la2, lo2);
  return direct * 1.3; // roads are ~30% longer than crow-flies in urban areas
}

// Distance from a point to a line segment (lat/lng), in km.
function distToSegmentKm(px, py, ax, ay, bx, by) {
  const dLat = bx - ax;
  const dLng = by - ay;
  if (dLat === 0 && dLng === 0) return haversineKm(px, py, ax, ay);

  const t = Math.max(0, Math.min(1,
    ((px - ax) * dLat + (py - ay) * dLng) / (dLat * dLat + dLng * dLng),
  ));

  const cx = ax + t * dLat;
  const cy = ay + t * dLng;
  return haversineKm(px, py, cx, cy);
}

// Estimate whether a driver is within a service radius of the pickup, already on the road.
function isWithinService(serviceKm, driverLat, driverLng, pickupLat, pickupLng, radiusKm = 50) {
  const dist = haversineKm(driverLat, driverLng, pickupLat, pickupLng);
  return { ok: dist <= radiusKm + serviceKm, distKm: dist };
}

function makeOtp() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

module.exports = {
  uid,
  now,
  haversineKm,
  estimatedRoadKm,
  distToSegmentKm,
  isWithinService,
  makeOtp,
};
