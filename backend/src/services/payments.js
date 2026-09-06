const crypto = require('crypto');
const config = require('../config');
const repo = require('../db/repository');
const pricing = require('./pricing');

// Yoco Checkout API — hosted, PCI-compliant card payments in ZAR.
//   createCheckout(): POST /checkouts → returns redirectUrl to Yoco's page
//   confirmPayment(): GET /checkouts/:id → mark paid when status = 'completed'
//   handleWebhook():  signed Standard-Webhooks event (payment.succeeded/failed)

function assertConfigured() {
  if (!config.yoco.secretKey) {
    const err = new Error('Yoco payments are not configured yet');
    err.status = 500;
    throw err;
  }
}

async function yocoFetch(path, { method = 'GET', body, idempotencyKey } = {}) {
  assertConfigured();
  const headers = {
    Authorization: `Bearer ${config.yoco.secretKey}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let res;
  try {
    res = await fetch(`${config.yoco.apiBase}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    const err = new Error(`Yoco request failed: ${e.message}`);
    err.status = 502;
    throw err;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || json.reason || `Yoco error ${res.status}`);
    err.status = 502;
    throw err;
  }
  return json;
}

function payableTrip(tripId, customerId) {
  const trip = repo.getTripById(tripId);
  if (!trip || (customerId && trip.customerId !== customerId)) {
    const err = new Error('Trip not found');
    err.status = 404;
    throw err;
  }
  if (trip.status !== 'completed' || trip.finalFare == null) {
    const err = new Error('Trip is not payable yet');
    err.status = 409;
    throw err;
  }
  return trip;
}

// Create (or reuse) a hosted Yoco checkout for a completed card trip.
// The payment row is created on trip completion; we attach the checkout there.
async function createCheckout({ tripId, customerId }) {
  const trip = payableTrip(tripId, customerId);
  let pay = repo.getPaymentByTrip(tripId);
  if (pay && pay.status === 'succeeded') {
    return { paid: true, trip, payment: pay };
  }

  const amountCents = pricing.dollarsToCents(trip.finalFare);

  // Reuse an existing, un-completed checkout instead of creating a duplicate
  // (prevents double-charging if the customer opens the pay screen twice).
  if (pay && pay.paymentIntentId) {
    const existing = await yocoFetch(`/checkouts/${encodeURIComponent(pay.paymentIntentId)}`).catch(() => null);
    if (existing && existing.id) {
      if (existing.status === 'completed') return confirmPayment({ tripId, customerId });
      if (existing.redirectUrl) {
        return { redirectUrl: existing.redirectUrl, checkoutId: existing.id, trip, payment: pay, paid: false };
      }
    }
  }

  const checkout = await yocoFetch('/checkouts', {
    method: 'POST',
    idempotencyKey: `trip-${tripId}`,
    body: {
      amount: amountCents,
      currency: config.currency.toUpperCase(),
      successUrl: config.yoco.successUrl,
      cancelUrl: config.yoco.cancelUrl,
      metadata: { tripId },
      clientReferenceId: tripId,
    },
  });

  if (!pay) {
    repo.createPayment({
      tripId,
      amountCents,
      provider: 'yoco',
      currency: config.currency,
    });
  }
  repo.updatePaymentCheckout(tripId, {
    checkoutId: checkout.id,
    redirectUrl: checkout.redirectUrl || null,
  });

  return {
    redirectUrl: checkout.redirectUrl,
    checkoutId: checkout.id,
    trip,
    payment: repo.getPaymentByTrip(tripId),
    paid: false,
  };
}

// Ask Yoco for the current checkout state and finalise the payment when the
// customer has completed the hosted flow. Safe to call repeatedly (idempotent).
async function confirmPayment({ tripId, customerId } = {}) {
  const trip = payableTrip(tripId, customerId);
  const pay = repo.getPaymentByTrip(tripId);
  if (!pay || !pay.paymentIntentId) {
    const err = new Error('No payment found for this trip');
    err.status = 404;
    throw err;
  }
  if (pay.status === 'succeeded') return { paid: true, trip, payment: pay };

  const checkout = await yocoFetch(`/checkouts/${encodeURIComponent(pay.paymentIntentId)}`);
  if (checkout.status !== 'completed') {
    return { paid: false, trip, payment: repo.getPaymentByTrip(tripId) };
  }
  return { paid: true, trip: repo.getTripById(tripId), payment: markPaid(tripId, pay, checkout) };
}

// Quick check used for frontend polling / initial load.
function getStatus({ tripId, customerId }) {
  const trip = payableTrip(tripId, customerId);
  const pay = repo.getPaymentByTrip(tripId);
  return { trip, payment: pay, paid: !!(pay && pay.status === 'succeeded') };
}

// Refund a completed card payment back to the customer's card via Yoco.
// Only card payments that have actually succeeded are eligible; cash trips are
// settled in person and can't be refunded through us.
async function refundPayment({ tripId, customerId } = {}) {
  const trip = payableTrip(tripId, customerId);
  const pay = repo.getPaymentByTrip(tripId);
  if (!pay) {
    const err = new Error('No payment found for this trip');
    err.status = 404;
    throw err;
  }
  if (pay.provider !== 'yoco') {
    const err = new Error('Only card payments can be refunded');
    err.status = 409;
    throw err;
  }
  if (pay.status === 'refunded') {
    return { refunded: true, trip, payment: pay };
  }
  if (pay.status !== 'succeeded' || !pay.paymentIntentId) {
    const err = new Error('This payment is not refundable');
    err.status = 409;
    throw err;
  }
  const refund = await yocoFetch('/refunds', {
    method: 'POST',
    idempotencyKey: `refund-${tripId}`,
    body: {
      checkoutId: pay.paymentIntentId,
      amountInCents: pay.amountCents,
      description: `Refund for trip ${tripId}`,
    },
  });
  const payment = repo.markPaymentRefunded(tripId, { refundId: refund && refund.id });
  return { refunded: true, refund, trip: repo.getTripById(tripId), payment };
}

// Driver-initiated refund: verify the driver owns the given trip first.
async function refundTripForDriver(driverId, tripId) {
  const trip = repo.getTripById(tripId);
  if (!trip || trip.driverId !== driverId) {
    const err = new Error('Trip not found');
    err.status = 404;
    throw err;
  }
  return refundPayment({ tripId });
}

// Finalise a successful local payment (webhook or confirmed via API).
function markPaid(tripId, pay, checkout) {
  const amount = (checkout && checkout.amount != null ? checkout.amount : pay.amountCents) / 100;
  const payout = pricing.round(amount);
  return repo.markPaymentSucceeded(tripId, {
    paymentIntentId: (checkout && checkout.id) || pay.paymentIntentId,
    driverPayoutCents: pricing.dollarsToCents(payout),
    platformFeeCents: 0,
  });
}

// ---- Webhooks (Standard Webhooks spec: webhook-id / webhook-timestamp / webhook-signature) ----

function verifyWebhookSignature(rawBody, headers) {
  const secret = config.yoco.webhookSecret;
  if (!secret) {
    if (config.nodeEnv === 'production') {
      throw Object.assign(new Error('Yoco webhook secret is not configured'), { status: 500 });
    }
    console.warn('[yoco] webhook secret not set — skipping signature verification (dev only)');
    return;
  }

  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];
  if (!id || !timestamp || !signatureHeader) {
    throw Object.assign(new Error('Missing webhook headers'), { status: 400 });
  }

  // Replay protection: reject events older than 5 minutes.
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Math.abs(Date.now() / 1000 - ts) > 5 * 60) {
    throw Object.assign(new Error('Webhook timestamp is invalid or expired'), { status: 400 });
  }

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const valid = String(signatureHeader)
    .split(' ')
    .some((part) => {
      const comma = part.indexOf(',');
      if (comma === -1) return false;
      const version = part.slice(0, comma);
      const signature = part.slice(comma + 1);
      if (version !== 'v1' || !signature) return false;
      const expected = Buffer.from(signature, 'base64');
      const actual = crypto.createHmac('sha256', secret).update(signedContent).digest();
      return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    });

  if (!valid) {
    throw Object.assign(new Error('Webhook signature verification failed'), { status: 400 });
  }
}

// Map a webhook payload back to our trip via the metadata we set at creation,
// or by matching the checkout id we stored against the event.
function resolveTripId(payload, event) {
  if (payload && payload.metadata && payload.metadata.tripId) return payload.metadata.tripId;
  const candidates = [
    payload && payload.checkoutId,
    payload && payload.checkout && payload.checkout.id,
    payload && payload.payment && (payload.payment.checkoutId || payload.payment.id),
    event && event.id,
  ].filter(Boolean);
  for (const candidate of candidates) {
    const tripId = repo.getTripIdByCheckout(candidate);
    if (tripId) return tripId;
  }
  return null;
}

// Authoritative payment confirmation. Treated as duplicate-safe: it only flips a
// pending payment to succeeded once, after double-checking the charge with Yoco.
async function confirmByWebhook(tripId) {
  const pay = repo.getPaymentByTrip(tripId);
  if (!pay || pay.status === 'succeeded') return;
  const checkout = pay.paymentIntentId
    ? await yocoFetch(`/checkouts/${encodeURIComponent(pay.paymentIntentId)}`).catch(() => null)
    : null;
  if (checkout && checkout.status !== 'completed') return null;
  markPaid(tripId, pay, checkout || {});
  return repo.getTripById(tripId);
}

async function handleWebhook(req, notify) {
  const rawBody = req.body;
  const headers = req.headers;
  verifyWebhookSignature(rawBody, headers);

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid webhook JSON'), { status: 400 });
  }

  const payload = event.payload || event.data || {};
  const type = event.type || payload.status || '';
  const tripId = resolveTripId(payload, event);

  if (!tripId) return { received: true, error: 'no matching trip' };

  if (type === 'payment.succeeded') {
    const trip = await confirmByWebhook(tripId);
    if (trip && notify) notify.paymentUpdated(repo.getPaymentByTrip(tripId), trip);
    return { received: true, tripId };
  }
  if (type === 'payment.failed') {
    repo.markPaymentFailed(tripId);
    const trip = repo.getTripById(tripId);
    if (trip && notify) notify.paymentUpdated(repo.getPaymentByTrip(tripId), trip);
    return { received: true, tripId };
  }
  return { received: true };
}

module.exports = { createCheckout, confirmPayment, getStatus, refundPayment, refundTripForDriver, handleWebhook };