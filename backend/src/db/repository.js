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
    driverStatus: row.driver_status,
    idNumber: row.id_number,
    rejectionReason: row.driver_rejection_reason,
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
  createUser({ phone, name, email, role, driverStatus }) {
    const id = uid('u');
    const status = driverStatus || (role === 'admin' ? 'approved' : role === 'driver' ? 'approved' : null);
    db.prepare(
      'INSERT INTO users (id, phone, name, email, role, driver_status) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, phone, name || null, email || null, role || 'customer', status);
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
    // Primary driver for the current single-driver dispatch: the admin owner by
    // phone, falling back to the oldest active (approved) driver account so
    // legacy databases and tests keep working.
    const owner = config.driverPhone
      ? db.prepare("SELECT * FROM users WHERE role = 'admin' AND phone = ?").get(config.driverPhone)
      : null;
    const row = owner || db.prepare(
      "SELECT * FROM users WHERE role IN ('admin','driver') AND COALESCE(driver_status,'approved') = 'approved' ORDER BY created_at LIMIT 1",
    ).get();
    return mapUser(row);
  },

  getAllOnlineDrivers() {
    return db
      .prepare(
        "SELECT * FROM users WHERE role IN ('admin','driver') AND COALESCE(driver_status,'approved') = 'approved' AND is_online = 1",
      )
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
    db.prepare(
      "UPDATE users SET role = 'driver', driver_status = 'approved', is_online = 0, updated_at = ? WHERE id = ?",
    ).run(now(), id);
    return this.getUserById(id);
  },

  // A customer who chooses "I'm the driver" applies to drive: keep the same row
  // (and history) but the role becomes a pending driver applicant.
  convertToDriverApplicant(id) {
    db.prepare(
      "UPDATE users SET role = 'driver', driver_status = 'pending', is_online = 0, updated_at = ? WHERE id = ?",
    ).run(now(), id);
    return this.getUserById(id);
  },

  // Promote an existing account (e.g. the owner's) to the admin role/driver.
  promoteToAdmin(id) {
    db.prepare(
      "UPDATE users SET role = 'admin', driver_status = 'approved', is_online = 0, updated_at = ? WHERE id = ?",
    ).run(now(), id);
    return this.getUserById(id);
  },

  addRating(id, stars) {
    db.prepare('UPDATE users SET rating_sum = rating_sum + ?, rating_count = rating_count + 1, updated_at = ? WHERE id = ?')
      .run(stars, now(), id);
  },

  // ---------- Driver applications & vetting ----------
  mapApplication(row) {
    if (!row) return null;
    return {
      driverId: row.driver_id,
      idNumber: row.id_number,
      idCopyUrl: row.id_copy_path ? `/api/uploads/${row.id_copy_path}` : null,
      selfieUrl: row.selfie_path ? `/api/uploads/${row.selfie_path}` : null,
      proofOfResidenceUrl: row.proof_of_residence_path ? `/api/uploads/${row.proof_of_residence_path}` : null,
      submittedAt: row.submitted_at,
      reviewedAt: row.reviewed_at,
      rejectionReason: row.rejection_reason,
    };
  },

  saveDriverApplication(driverId, { idNumber, idCopyPath, selfiePath, proofOfResidencePath }) {
    db.prepare(
      `INSERT INTO driver_documents (driver_id, id_number, id_copy_path, selfie_path, proof_of_residence_path, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(driver_id) DO UPDATE SET
         id_number = excluded.id_number,
         id_copy_path = COALESCE(excluded.id_copy_path, driver_documents.id_copy_path),
         selfie_path = COALESCE(excluded.selfie_path, driver_documents.selfie_path),
         proof_of_residence_path = COALESCE(excluded.proof_of_residence_path, driver_documents.proof_of_residence_path),
         updated_at = excluded.updated_at,
         reviewed_at = NULL,
         rejection_reason = NULL`,
    ).run(
      driverId,
      idNumber,
      idCopyPath || null,
      selfiePath || null,
      proofOfResidencePath || null,
      now(),
    );
    return this.getDriverApplication(driverId);
  },

  getDriverApplication(driverId) {
    return this.mapApplication(
      db.prepare('SELECT * FROM driver_documents WHERE driver_id = ?').get(driverId),
    );
  },

  listDriverApplications() {
    return db.prepare(
      'SELECT * FROM driver_documents ORDER BY submitted_at DESC',
    ).all().map((r) => this.mapApplication(r));
  },

  // Build the full admin-facing driver record: account + application + wallet.
  listDriversForAdmin() {
    const rows = db.prepare(
      `SELECT u.*, w.available_cents, w.owed_cents
       FROM users u
       LEFT JOIN driver_wallets w ON w.driver_id = u.id
       WHERE u.role IN ('admin','driver')
       ORDER BY CASE u.driver_status
         WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END ASC, u.created_at ASC`,
    ).all();
    return rows.map((row) => {
      const app = this.getDriverApplication(row.id);
      return {
        user: mapUser(row),
        application: app,
        wallet: {
          availableCents: row.available_cents || 0,
          owedCents: row.owed_cents || 0,
        },
      };
    });
  },

  setDriverStatus(id, status, rejectionReason) {
    db.prepare(
      `UPDATE users SET driver_status = ?, driver_rejection_reason = ?, updated_at = ? WHERE id = ?`,
    ).run(status || null, rejectionReason || null, now(), id);
    if (status === 'approved') this.createWalletIfMissing(id);
    return this.getUserById(id);
  },

  // ---------- Driver wallets ----------
  createWalletIfMissing(driverId) {
    db.prepare('INSERT OR IGNORE INTO driver_wallets (driver_id) VALUES (?)').run(driverId);
    return this.getWallet(driverId);
  },

  getWallet(driverId) {
    const row = db.prepare(
      'SELECT available_cents, owed_cents, updated_at FROM driver_wallets WHERE driver_id = ?',
    ).get(driverId);
    return row
      ? { availableCents: row.available_cents, owedCents: row.owed_cents, updatedAt: row.updated_at }
      : { availableCents: 0, owedCents: 0, updatedAt: null };
  },

  // Move given driver_id's wallet by deltas (cents, can be negative).
  adjustWallet(driverId, { availableCents = 0, owedCents = 0 }) {
    db.prepare(
      `UPDATE driver_wallets SET available_cents = available_cents + ?,
        owed_cents = owed_cents + ?, updated_at = ? WHERE driver_id = ?`,
    ).run(availableCents, owedCents, now(), driverId);
    return this.getWallet(driverId);
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

  // ---------- Fare disputes ----------
  createDispute({ tripId, userId, reason }) {
    const id = uid('disp');
    db.prepare('INSERT INTO fare_disputes (id, trip_id, user_id, reason) VALUES (?, ?, ?, ?)').run(id, tripId, userId, reason || null);
    return db.prepare('SELECT * FROM fare_disputes WHERE id = ?').get(id);
  },

  getDisputeByTrip(tripId) {
    return db.prepare('SELECT * FROM fare_disputes WHERE trip_id = ? ORDER BY created_at DESC LIMIT 1').get(tripId);
  },

  resolveDispute(id, resolution) {
    db.prepare("UPDATE fare_disputes SET status = 'resolved', resolution = ?, resolved_at = datetime('now') WHERE id = ?").run(resolution, id);
    return db.prepare('SELECT * FROM fare_disputes WHERE id = ?').get(id);
  },

  listOpenDisputes() {
    return db.prepare("SELECT * FROM fare_disputes WHERE status = 'open' ORDER BY created_at DESC").all();
  },

  // ---------- Promo codes ----------
  getPromoByCode(code) {
    return db.prepare("SELECT * FROM promo_codes WHERE code = ? AND active = 1").get(code);
  },

  usePromo(id) {
    db.prepare('UPDATE promo_codes SET used_count = used_count + 1 WHERE id = ?').run(id);
  },

  createPromo({ code, discountPercent, maxUses, validUntil }) {
    const id = uid('promo');
    db.prepare('INSERT INTO promo_codes (id, code, discount_percent, max_uses, valid_until) VALUES (?, ?, ?, ?, ?)').run(id, code, discountPercent || 10, maxUses || 50, validUntil || null);
    return db.prepare('SELECT * FROM promo_codes WHERE id = ?').get(id);
  },

  listPromos() {
    return db.prepare('SELECT * FROM promo_codes ORDER BY created_at DESC').all();
  },

  // ---------- Recent destinations ----------
  saveRecentDestination(userId, { destAddress, destLat, destLng, destNote, pickupAddress, pickupLat, pickupLng }) {
    // Try to update existing, otherwise insert
    const existing = db.prepare(
      'SELECT id FROM recent_destinations WHERE user_id = ? AND dest_lat = ? AND dest_lng = ?',
    ).get(userId, destLat, destLng);
    if (existing) {
      db.prepare("UPDATE recent_destinations SET used_count = used_count + 1, last_used = datetime('now') WHERE id = ?").run(existing.id);
    } else {
      const id = uid('rd');
      db.prepare(
        'INSERT INTO recent_destinations (id, user_id, dest_address, dest_lat, dest_lng, dest_note, pickup_address, pickup_lat, pickup_lng) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, userId, destAddress, destLat, destLng, destNote || null, pickupAddress || null, pickupLat || null, pickupLng || null);
    }
  },

  getRecentDestinations(userId, limit = 5) {
    return db.prepare(
      'SELECT * FROM recent_destinations WHERE user_id = ? ORDER BY used_count DESC, last_used DESC LIMIT ?',
    ).all(userId, limit).map((r) => ({
      id: r.id,
      destAddress: r.dest_address,
      destLat: r.dest_lat,
      destLng: r.dest_lng,
      destNote: r.dest_note,
      pickupAddress: r.pickup_address,
      pickupLat: r.pickup_lat,
      pickupLng: r.pickup_lng,
      usedCount: r.used_count,
      lastUsed: r.last_used,
    }));
  },

  deleteRecentDestination(id, userId) {
    db.prepare('DELETE FROM recent_destinations WHERE id = ? AND user_id = ?').run(id, userId);
  },

  // ---------- Driver analytics ----------
  getDriverAnalytics(driverId) {
    const trips = db.prepare('SELECT * FROM trips WHERE driver_id = ? ORDER BY requested_at DESC').all(driverId);
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);

    // Daily earnings for last 7 days
    const dailyEarnings = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dayStr = d.toISOString().slice(0, 10);
      const dayTrips = trips.filter((t) => t.status === 'completed' && (t.completed_at || '').startsWith(dayStr));
      dailyEarnings.push({
        date: dayStr,
        label: d.toLocaleDateString('en-ZA', { weekday: 'short' }),
        count: dayTrips.length,
        earnings: dayTrips.reduce((s, t) => s + (t.final_fare || 0), 0),
      });
    }

    // Hourly distribution (which hours are busiest)
    const hourlyCount = Array(24).fill(0);
    trips.forEach((t) => {
      if (t.requested_at) {
        const h = new Date(t.requested_at).getHours();
        hourlyCount[h] += 1;
      }
    });
    const busiestHours = hourlyCount.map((count, h) => ({ hour: h, count })).sort((a, b) => b.count - a.count).slice(0, 5);

    // Acceptance rate
    const requested = trips.filter((t) => ['requested', 'accepted', 'cancelled'].includes(t.status)).length;
    const accepted = trips.filter((t) => t.status !== 'requested' && t.driver_id).length;
    const acceptanceRate = requested ? Math.round((accepted / requested) * 100) : 100;

    // Cancellation stats
    const cancelledByDriver = trips.filter((t) => t.cancel_actor === 'driver').length;
    const cancelledByCustomer = trips.filter((t) => t.cancel_actor === 'customer').length;

    // Average wait time (time from request to acceptance)
    let totalWaitMs = 0;
    let waitCount = 0;
    trips.forEach((t) => {
      if (t.requested_at && t.accepted_at) {
        totalWaitMs += new Date(t.accepted_at) - new Date(t.requested_at);
        waitCount += 1;
      }
    });
    const avgWaitMin = waitCount ? Math.round(totalWaitMs / waitCount / 60000) : 0;

    return {
      dailyEarnings,
      busiestHours,
      acceptanceRate,
      cancelledByDriver,
      cancelledByCustomer,
      avgWaitMin,
      totalTrips: trips.length,
      completedTrips: trips.filter((t) => t.status === 'completed').length,
    };
  },
};
