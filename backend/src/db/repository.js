const db = require('../db/connection');
const config = require('../config');
const { uid, now } = require('../utils/geo');
const { round } = require('../services/pricing');

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    email: row.email,
    role: row.role,
    rating: row.rating_count > 0 ? round(row.rating_sum / row.rating_count) : null,
    ratingCount: row.rating_count,
    isOnline: !!row.is_online,
    vehicleType: row.vehicle_type,
    licensePlate: row.license_plate,
    photoUrl: row.photo_url,
    serviceRadiusKm: row.service_radius_km,
    baseFare: row.base_fare,
    perKmRate: row.per_km_rate,
    perMinRate: row.per_min_rate,
    createdAt: row.created_at,
  };
}

function mapTrip(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    driverId: row.driver_id,
    status: row.status,
    pickup: {
      address: row.pickup_address,
      lat: row.pickup_lat,
      lng: row.pickup_lng,
      note: row.pickup_note,
    },
    destination: {
      address: row.dest_address,
      lat: row.dest_lat,
      lng: row.dest_lng,
      note: row.dest_note,
    },
    routePolyline: row.route_polyline,
    distanceKm: row.distance_km,
    durationMin: row.duration_min,
    fareEstimate: row.fare_estimate,
    finalFare: row.final_fare,
    priceModel: row.price_model,
    paymentMethod: row.payment_method,
    tipAmount: row.tip_amount,
    rating: row.rating,
    feedbackTags: row.feedback_tags ? String(row.feedback_tags).split(',').filter(Boolean) : [],
    cancelReason: row.cancel_reason,
    cancelActor: row.cancel_actor,
    scheduledAt: row.scheduled_at,
    arrivedAt: row.arrived_at,
    fareConfirmedAt: row.fare_confirmed_at,
    timestamps: {
      requested: row.requested_at,
      accepted: row.accepted_at,
      started: row.started_at,
      completed: row.completed_at,
      cancelled: row.cancelled_at,
    },
  };
}

function mapPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    tripId: row.trip_id,
    amountCents: row.amount_cents,
    status: row.status,
    provider: row.provider,
    paymentIntentId: row.payment_intent_id,
    redirectUrl: row.redirect_url,
    driverPayoutCents: row.driver_payout_cents,
    platformFeeCents: row.platform_fee_cents,
    currency: row.currency,
    createdAt: row.created_at,
    paidAt: row.paid_at,
  };
}

function mapPlace(row) {
  if (!row) return null;
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    note: row.note,
    createdAt: row.created_at,
  };
}

function mapSpot(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    note: row.note,
    sort: row.sort,
    createdAt: row.created_at,
  };
}

module.exports = {
  db,
  uid,
  now,
  mapUser,
  mapTrip,
  mapPayment,
  mapSpot,

  // ---------- Users ----------
  createUser({ phone, name, email, role }) {
    const id = uid('u');
    db.prepare(
      'INSERT INTO users (id, phone, name, email, role) VALUES (?, ?, ?, ?, ?)',
    ).run(id, phone, name || null, email || null, role || 'customer');
    return this.getUserById(id);
  },

  getUserById(id) {
    return mapUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  },

  getUserByPhone(phone, role) {
    const row = role
      ? db.prepare('SELECT * FROM users WHERE phone = ? AND role = ?').get(phone, role)
      : db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
    return mapUser(row);
  },

  getDriver() {
    // The owner driver is identified by phone (config.driverPhone), falling
    // back to the oldest driver account for legacy databases.
    const byPhone = db.prepare('SELECT * FROM users WHERE role = ? AND phone = ?').get('driver', config.driverPhone);
    const row = byPhone || db.prepare("SELECT * FROM users WHERE role = 'driver' ORDER BY created_at LIMIT 1").get();
    return mapUser(row);
  },

  getAllOnlineDrivers() {
    return db
      .prepare("SELECT * FROM users WHERE role = 'driver' AND is_online = 1")
      .all()
      .map(mapUser);
  },

  updateUserProfile(id, fields) {
    const allowed = ['name', 'email', 'vehicle_type', 'license_plate', 'photo_url',
      'service_radius_km', 'base_fare', 'per_km_rate', 'per_min_rate'];
    const updates = [];
    const vals = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && allowed.includes(key)) {
        updates.push(`${key} = ?`);
        vals.push(value);
      }
    }
    if (updates.length) {
      updates.push('updated_at = ?');
      vals.push(now());
      vals.push(this.getUserById ? id : id);
      db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
    }
    return this.getUserById(id);
  },

  setDriverOnline(id, isOnline) {
    db.prepare('UPDATE users SET is_online = ?, updated_at = ? WHERE id = ?').run(
      isOnline ? 1 : 0, now(), id,
    );
    return this.getUserById(id);
  },

  promoteToDriver(id) {
    db.prepare("UPDATE users SET role = 'driver', is_online = 0, updated_at = ? WHERE id = ?").run(now(), id);
    return this.getUserById(id);
  },

  addRating(id, stars) {
    db.prepare('UPDATE users SET rating_sum = rating_sum + ?, rating_count = rating_count + 1, updated_at = ? WHERE id = ?')
      .run(stars, now(), id);
  },

  // ---------- Driver location ----------
  upsertDriverLocation(driverId, { lat, lng, heading, accuracy }) {
    db.prepare(
      `INSERT INTO driver_locations (driver_id, lat, lng, heading, accuracy)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(driverId, lat, lng, heading || null, accuracy || null);

    // Retain last 60 minutes of history for replay; prune older rows.
    db.prepare(
      `DELETE FROM driver_locations
       WHERE driver_id = ? AND timestamp < datetime('now', '-60 minutes')`,
    ).run(driverId);
    return this.getDriverLocation(driverId);
  },

  getDriverLocation(driverId) {
    const row = db.prepare(
      'SELECT * FROM driver_locations WHERE driver_id = ? ORDER BY timestamp DESC LIMIT 1',
    ).get(driverId);
    if (!row) return null;
    return { lat: row.lat, lng: row.lng, heading: row.heading, accuracy: row.accuracy, timestamp: row.timestamp };
  },

  getDriverLocationHistory(driverId, limit = 200) {
    return db.prepare(
      'SELECT * FROM driver_locations WHERE driver_id = ? ORDER BY timestamp DESC LIMIT ?',
    ).all(driverId, limit).map((r) => ({
      lat: r.lat, lng: r.lng, heading: r.heading, timestamp: r.timestamp,
    })).reverse();
  },

  // ---------- OTP ----------
  saveOtp(phone, code, expiresAtIso) {
    db.prepare(
      `INSERT INTO otps (phone, code, expires_at) VALUES (?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at,
       attempts = 0, created_at = datetime('now')`,
    ).run(phone, code, expiresAtIso);
  },

  getOtp(phone) {
    return db.prepare('SELECT * FROM otps WHERE phone = ?').get(phone);
  },

  incrementOtpAttempts(phone) {
    db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE phone = ?').run(phone);
  },

  deleteOtp(phone) {
    db.prepare('DELETE FROM otps WHERE phone = ?').run(phone);
  },

  // ---------- Trips ----------
  createTrip(data) {
    const id = data.id || uid('trip');
    db.prepare(
      `INSERT INTO trips
       (id, customer_id, driver_id, status, pickup_address, pickup_lat, pickup_lng,
        pickup_note, dest_address, dest_lat, dest_lng, dest_note, route_polyline,
        distance_km, duration_min, fare_estimate, price_model, payment_method, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, data.customerId, data.driverId || null, data.status || 'requested',
      data.pickup?.address, data.pickup?.lat, data.pickup?.lng,
      data.pickup?.note || null,
      data.destination?.address, data.destination?.lat, data.destination?.lng,
      data.destination?.note || null,
      data.routePolyline || null, data.distanceKm || null, data.durationMin || null,
      data.fareEstimate ?? null, data.priceModel || 'distance_time',
      data.paymentMethod || 'cash', data.scheduledAt || null,
    );
    return this.getTripById(id);
  },

  getTripById(id) {
    return mapTrip(db.prepare('SELECT * FROM trips WHERE id = ?').get(id));
  },

  getTripsForCustomer(customerId, limit = 50) {
    return db.prepare(
      'SELECT * FROM trips WHERE customer_id = ? ORDER BY requested_at DESC LIMIT ?',
    ).all(customerId, limit).map(mapTrip);
  },

  getTripsForDriver(driverId, limit = 50) {
    return db.prepare(
      'SELECT * FROM trips WHERE driver_id = ? ORDER BY requested_at DESC LIMIT ?',
    ).all(driverId, limit).map(mapTrip);
  },

  getActiveTripsForDriver(driverId) {
    return db.prepare(
      `SELECT * FROM trips
       WHERE driver_id = ? AND status IN ('accepted', 'ongoing')
       ORDER BY accepted_at DESC`,
    ).all(driverId).map(mapTrip);
  },

  getActiveTripForCustomer(customerId) {
    return mapTrip(db.prepare(
      `SELECT * FROM trips
       WHERE customer_id = ? AND status IN ('accepted', 'ongoing')
       ORDER BY requested_at DESC LIMIT 1`,
    ).get(customerId));
  },

  getLatestRequestedTrip() {
    return mapTrip(db.prepare(
      "SELECT * FROM trips WHERE status = 'requested' ORDER BY requested_at ASC LIMIT 1",
    ).get());
  },

  updateTrip(id, fields) {
    const allowed = ['driver_id', 'status', 'route_polyline', 'distance_km', 'duration_min',
      'fare_estimate', 'final_fare', 'payment_method', 'tip_amount', 'rating', 'feedback_tags', 'cancel_reason', 'cancel_actor',
      'accepted_at', 'started_at', 'completed_at', 'cancelled_at', 'scheduled_at', 'arrived_at', 'fare_confirmed_at'];
    const updates = [];
    const vals = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && allowed.includes(key)) {
        updates.push(`${key} = ?`);
        vals.push(value);
      }
    }
    if (updates.length) {
      db.prepare(`UPDATE trips SET ${updates.join(', ')} WHERE id = ?`).run(...vals, id);
    }
    return this.getTripById(id);
  },

  setTripStatus(id, status) {
    return this.updateTrip(id, { status });
  },

  // ---------- Payments ----------
  createPayment({ tripId, amountCents, provider, currency = 'zar' }) {
    const id = uid('pay');
    db.prepare(
      'INSERT INTO payments (id, trip_id, amount_cents, provider, currency) VALUES (?, ?, ?, ?, ?)',
    ).run(id, tripId, amountCents, provider, currency);
    return this.getPaymentByTrip(tripId);
  },

  getPaymentByTrip(tripId) {
    return mapPayment(db.prepare('SELECT * FROM payments WHERE trip_id = ?').get(tripId));
  },

  // Store the Yoco checkout id (in payment_intent_id) + hosted redirect URL.
  updatePaymentCheckout(tripId, { checkoutId, redirectUrl }) {
    db.prepare(
      `UPDATE payments SET payment_intent_id = ?, redirect_url = ?, status = 'pending' WHERE trip_id = ?`,
    ).run(checkoutId || null, redirectUrl || null, tripId);
    return this.getPaymentByTrip(tripId);
  },

  // Reverse lookup: a Yoco checkout id → trip id (for webhooks).
  getTripIdByCheckout(checkoutId) {
    const row = db.prepare(
      'SELECT trip_id FROM payments WHERE payment_intent_id = ? LIMIT 1',
    ).get(checkoutId);
    return row ? row.trip_id : null;
  },

  markPaymentSucceeded(tripId, { paymentIntentId, driverPayoutCents, platformFeeCents }) {
    db.prepare(
      `UPDATE payments SET status = 'succeeded', payment_intent_id = ?, driver_payout_cents = ?,
       platform_fee_cents = ?, paid_at = ? WHERE trip_id = ?`,
    ).run(paymentIntentId || null, driverPayoutCents ?? null, platformFeeCents ?? 0, now(), tripId);
    return this.getPaymentByTrip(tripId);
  },

  markPaymentFailed(tripId) {
    db.prepare("UPDATE payments SET status = 'failed' WHERE trip_id = ?").run(tripId);
    return this.getPaymentByTrip(tripId);
  },

  setPaymentStatus(tripId, status) {
    db.prepare('UPDATE payments SET status = ? WHERE trip_id = ?').run(status, tripId);
    return this.getPaymentByTrip(tripId);
  },

  updatePaymentAmount(tripId, amountCents) {
    db.prepare('UPDATE payments SET amount_cents = ? WHERE trip_id = ?').run(amountCents, tripId);
    return this.getPaymentByTrip(tripId);
  },

  markPaymentRefunded(tripId, { refundId } = {}) {
    db.prepare(
      `UPDATE payments SET status = 'refunded', payment_intent_id = COALESCE(?, payment_intent_id),
       paid_at = paid_at WHERE trip_id = ?`,
    ).run(refundId || null, tripId);
    return this.getPaymentByTrip(tripId);
  },

  // ---------- Push subscriptions ----------
  savePushSubscription(userId, { endpoint, p256dh, auth }) {
    db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
    ).run(userId, endpoint, p256dh, auth);
  },

  getPushSubscriptions(userId) {
    return db.prepare(
      'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?',
    ).all(userId);
  },

  removePushSubscription(endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  },

  // ---------- Saved places ----------
  listSavedPlaces(userId) {
    return db.prepare(
      `SELECT * FROM saved_places WHERE user_id = ?
       ORDER BY CASE kind WHEN 'home' THEN 0 WHEN 'work' THEN 1 ELSE 2 END ASC,
       created_at ASC`,
    ).all(userId).map(mapPlace);
  },

  createSavedPlace(userId, { label, kind, address, lat, lng, note }) {
    const id = uid('place');
    db.prepare(
      'INSERT INTO saved_places (id, user_id, label, kind, address, lat, lng, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, userId, label, kind || 'place', address || null, lat, lng, note || null);
    return this.getSavedPlaceById(id);
  },

  getSavedPlaceById(id) {
    return mapPlace(db.prepare('SELECT * FROM saved_places WHERE id = ?').get(id));
  },

  updateSavedPlace(id, userId, fields) {
    const allowed = ['label', 'kind', 'address', 'lat', 'lng', 'note'];
    const updates = [];
    const vals = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && allowed.includes(key)) {
        updates.push(`${key} = ?`);
        vals.push(value);
      }
    }
    if (updates.length) {
      db.prepare(`UPDATE saved_places SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(...vals, id, userId);
    }
    return this.getSavedPlaceById(id);
  },

  deleteSavedPlace(id, userId) {
    db.prepare('DELETE FROM saved_places WHERE id = ? AND user_id = ?').run(id, userId);
  },

  // ---------- Pickup spots ----------
  listPickupSpots(limit = 50) {
    return db.prepare(
      'SELECT * FROM pickup_spots WHERE active = 1 ORDER BY sort ASC, name ASC LIMIT ?',
    ).all(limit).map(mapSpot);
  },

  getPickupSpotById(id) {
    return mapSpot(db.prepare('SELECT * FROM pickup_spots WHERE id = ?').get(id));
  },

  createPickupSpot({ name, category, address, lat, lng, note, sort }) {
    const id = uid('spot');
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM pickup_spots').get().m;
    db.prepare(
      'INSERT INTO pickup_spots (id, name, category, address, lat, lng, note, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(id, name, category || 'spot', address || null, lat, lng, note || null, sort ?? maxSort + 1);
    return this.getPickupSpotById(id);
  },

  updatePickupSpot(id, fields) {
    const allowed = ['name', 'category', 'address', 'lat', 'lng', 'note', 'sort', 'active'];
    const updates = [];
    const vals = [];
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined && allowed.includes(key)) {
        updates.push(`${key} = ?`);
        vals.push(value);
      }
    }
    if (updates.length) {
      db.prepare(`UPDATE pickup_spots SET ${updates.join(', ')} WHERE id = ?`).run(...vals, id);
    }
    return this.getPickupSpotById(id);
  },

  deletePickupSpot(id) {
    db.prepare('DELETE FROM pickup_spots WHERE id = ?').run(id);
  },

  // ---------- Upcoming scheduled trips ----------
  getScheduledTripsForDriver(limit = 20) {
    return db.prepare(
      `SELECT * FROM trips
       WHERE status = 'scheduled' AND (scheduled_at IS NULL OR scheduled_at >= datetime('now', '-1 hour'))
       ORDER BY COALESCE(scheduled_at, requested_at) ASC LIMIT ?`,
    ).all(limit).map(mapTrip);
  },

  // ---------- Runtime settings (admin-editable, env-provided defaults) ----------
  getSetting(key) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  setSetting(key, value) {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(key, value == null ? null : String(value));
    return this.getSetting(key);
  },

  listSettings() {
    const rows = db.prepare('SELECT key, value, updated_at FROM settings ORDER BY key ASC').all();
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }));
  },
};
