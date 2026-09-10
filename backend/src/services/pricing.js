// DriveLocal pricing: base fare + per-km rate + per-minute rate.
// Returns amounts in ZAR (decimal).

function estimateFare({ baseFare, perKmRate, perMinRate, distanceKm, durationMin, tipAmount = 0 }) {
  const distanceCharge = Number(distanceKm || 0) * Number(perKmRate || 0);
  const durationCharge = Number(durationMin || 0) * Number(perMinRate || 0);
  const subtotal = Number(baseFare || 0) + distanceCharge + durationCharge;
  const total = Math.max(0, subtotal) + Number(tipAmount || 0);
  return {
    baseFare: round(Number(baseFare || 0)),
    distanceCharge: round(distanceCharge),
    durationCharge: round(durationCharge),
    subtotal: round(Math.max(0, subtotal)),
    tipAmount: round(Number(tipAmount || 0)),
    total: round(total),
  };
}

// Estimate because distance/duration are estimates at booking time.
function round(n) {
  return Math.round(n * 100) / 100;
}

function dollarsToCents(dollars) {
  return Math.round(Number(dollars) * 100);
}

module.exports = { estimateFare, round, dollarsToCents };
