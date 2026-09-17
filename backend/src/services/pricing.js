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

// Apply a promo discount to a fare subtotal. The discount is capped so the
// customer always pays at least the base fare (a ride is never completely free).
// Shared by the booking preview, trip creation and trip completion so the
// discount shown up front is exactly what gets charged at the end.
function applyPromoDiscount(subtotal, discountPercent, baseFare) {
  const base = Math.max(0, Number(subtotal) || 0);
  const percent = Number(discountPercent) || 0;
  if (percent <= 0) return { discount: 0, total: round(base) };
  const floor = Math.max(0, Number(baseFare) || 0);
  const raw = round(base * (percent / 100));
  const discount = round(Math.min(Math.max(0, base - floor), raw));
  return { discount, total: round(Math.max(0, base - discount)) };
}

function dollarsToCents(dollars) {
  return Math.round(Number(dollars) * 100);
}

module.exports = { estimateFare, applyPromoDiscount, round, dollarsToCents };
