const { test } = require('node:test');
const assert = require('node:assert/strict');

const { estimateFare, round, dollarsToCents } = require('../src/services/pricing');

test('estimateFare: base + distance + duration', () => {
  const fare = estimateFare({
    baseFare: 3,
    perKmRate: 1.5,
    perMinRate: 0.25,
    distanceKm: 10,
    durationMin: 20,
  });
  assert.equal(fare.distanceCharge, 15);
  assert.equal(fare.durationCharge, 5);
  assert.equal(fare.subtotal, 23);
  assert.equal(fare.total, 23);
});

test('estimateFare: tip is added on top but not double counted', () => {
  const fare = estimateFare({
    baseFare: 3,
    perKmRate: 1.5,
    perMinRate: 0.25,
    distanceKm: 10,
    durationMin: 20,
    tipAmount: 10,
  });
  assert.equal(fare.subtotal, 23);
  assert.equal(fare.tipAmount, 10);
  assert.equal(fare.total, 33);
});

test('estimateFare: subtotal is clamped at zero', () => {
  const fare = estimateFare({
    baseFare: 0,
    perKmRate: 0,
    perMinRate: 0,
    distanceKm: 10,
    durationMin: 0,
  });
  assert.equal(fare.total, 0);
});

test('round and dollarsToCents', () => {
  assert.equal(round(5.678), 5.68);
  assert.equal(dollarsToCents(12.34), 1234);
  assert.equal(dollarsToCents(0.1), 10);
});