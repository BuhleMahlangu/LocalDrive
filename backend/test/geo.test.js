const { test } = require('node:test');
const assert = require('node:assert/strict');

const { haversineKm, estimatedRoadKm, isWithinService } = require('../src/utils/geo');

test('haversineKm: same point is zero', () => {
  assert.equal(haversineKm(-26.2155, 29.2916, -26.2155, 29.2916), 0);
});

test('haversineKm: Johannesburg to Cape Town is roughly 1270 km', () => {
  const km = haversineKm(-26.2041, 28.0473, -33.9249, 18.4241);
  assert.ok(km > 1250 && km < 1350, `got ${km}`);
});

test('estimatedRoadKm is always >= direct distance', () => {
  const direct = haversineKm(-26.2155, 29.2916, -26.2500, 29.3200);
  assert.ok(estimatedRoadKm(-26.2155, 29.2916, -26.2500, 29.3200) > direct);
});

test('isWithinService respects the radius', () => {
  const nearby = isWithinService(50, -26.2155, 29.2916, -26.2156, 29.2917);
  assert.equal(nearby.ok, true);

  const far = isWithinService(50, -26.2155, 29.2916, -33.9249, 18.4241);
  assert.equal(far.ok, false);
});