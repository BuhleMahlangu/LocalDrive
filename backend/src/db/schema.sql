-- DriveLocal complete schema (PostgreSQL/PostGIS target).
-- The SQLite dev driver (src/db/connection.js) mirrors these tables so the
-- same queries work locally without PostGIS.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT,
  email         TEXT,
  pin_hash      TEXT,                                   -- salted scrypt hash of the login PIN; NULL until first set
  role          TEXT NOT NULL DEFAULT 'customer',       -- 'customer' | 'driver' | 'admin'
  driver_status TEXT,                                   -- NULL/'approved' | 'pending' | 'rejected' | 'suspended'
  driver_rejection_reason TEXT,
  id_number     TEXT,
  rating_sum    INTEGER NOT NULL DEFAULT 0,
  rating_count  INTEGER NOT NULL DEFAULT 0,
  is_online     BOOLEAN NOT NULL DEFAULT false,         -- driver only
  vehicle_type  TEXT,
  license_plate TEXT,
  photo_url     TEXT,
  service_radius_km NUMERIC NOT NULL DEFAULT 50,
  base_fare     NUMERIC NOT NULL DEFAULT 3.00,
  per_km_rate   NUMERIC NOT NULL DEFAULT 1.50,
  per_min_rate  NUMERIC NOT NULL DEFAULT 0.25,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Driver application / vetting documents (one row per driver)
CREATE TABLE IF NOT EXISTS driver_documents (
  driver_id            TEXT PRIMARY KEY REFERENCES users(id),
  id_number            TEXT NOT NULL,
  id_copy_path         TEXT,
  selfie_path          TEXT,
  proof_of_residence_path TEXT,
  submitted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at          TIMESTAMPTZ,
  rejection_reason     TEXT
);

-- Driver wallet ledger
CREATE TABLE IF NOT EXISTS driver_wallets (
  driver_id       TEXT PRIMARY KEY REFERENCES users(id),
  available_cents INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Customer identity documents (one row per customer). Booking is blocked
-- until both an ID copy and a selfie are on file — safety requirement.
CREATE TABLE IF NOT EXISTS customer_documents (
  customer_id    TEXT PRIMARY KEY REFERENCES users(id),
  id_number      TEXT NOT NULL,
  id_copy_path   TEXT,
  selfie_path    TEXT,
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ephemeral driver location (last known, retained 60 min for history)
CREATE TABLE IF NOT EXISTS driver_locations (
  id         SERIAL PRIMARY KEY,
  driver_id  TEXT NOT NULL REFERENCES users(id),
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  heading    DOUBLE PRECISION,
  accuracy   DOUBLE PRECISION,
  timestamp  TIMESTAMPTZ NOT NULL DEFAULT now(),
  geom       GEOGRAPHY(POINT, 4326) GENERATED ALWAYS AS
             (ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography) STORED
);
CREATE INDEX IF NOT EXISTS idx_driver_locations_driver_time
  ON driver_locations(driver_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS trips (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES users(id),
  driver_id      TEXT REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'requested',
                 -- requested | accepted | ongoing | completed | cancelled
  pickup_address TEXT,
  pickup_lat     DOUBLE PRECISION,
  pickup_lng     DOUBLE PRECISION,
  pickup_note    TEXT,
  dest_address   TEXT,
  dest_lat       DOUBLE PRECISION,
  dest_lng       DOUBLE PRECISION,
  dest_note      TEXT,
  route_polyline TEXT,
  distance_km    NUMERIC,
  duration_min   NUMERIC,
  fare_estimate  NUMERIC,
  final_fare     NUMERIC,
  price_model    TEXT NOT NULL DEFAULT 'distance_time',
  promo_code     TEXT,
  promo_percent  NUMERIC NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  tip_amount     NUMERIC NOT NULL DEFAULT 0,
  rating         INTEGER,
  feedback_tags  TEXT,
  cancel_reason  TEXT,
  cancel_actor   TEXT,          -- 'customer' | 'driver' | 'system'
  scheduled_at   TIMESTAMPTZ,
  passenger_name  TEXT,
  passenger_phone TEXT,
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at    TIMESTAMPTZ,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ,
  arrived_at     TIMESTAMPTZ,   -- driver reached the pickup (customer steps out)
  fare_confirmed_at TIMESTAMPTZ -- customer agreed the final fare
);
CREATE INDEX IF NOT EXISTS idx_trips_customer ON trips(customer_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_trips_driver   ON trips(driver_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_trips_status    ON trips(status);

CREATE TABLE IF NOT EXISTS payments (
  id                    TEXT PRIMARY KEY,
  trip_id               TEXT NOT NULL REFERENCES trips(id),
  amount_cents          INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
                        -- pending | succeeded | failed | refunded
  provider              TEXT NOT NULL DEFAULT 'cash',   -- 'yoco' | 'cash'
  payment_intent_id     TEXT,
  redirect_url          TEXT,
  driver_payout_cents   INTEGER,
  platform_fee_cents    INTEGER NOT NULL DEFAULT 0,
  currency              TEXT NOT NULL DEFAULT 'zar',      -- Rand (South Africa)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payments_trip ON payments(trip_id);

-- Login is phone + a 6-digit PIN (see services/auth.js). The PIN is stored only
-- as a salted scrypt hash in users.pin_hash; repeated wrong PINs are throttled
-- in memory/DB (services/rateLimit.js), not by a short-lived code row.

-- Web push (VAPID) subscriptions per user
CREATE TABLE IF NOT EXISTS push_subscriptions (
  user_id    TEXT NOT NULL REFERENCES users(id),
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint)
);

-- Saved places (frequent pickups/destinations) per customer
CREATE TABLE IF NOT EXISTS saved_places (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  label      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'place',   -- 'home' | 'work' | 'place'
  address    TEXT,
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saved_places_user ON saved_places(user_id);

-- Preset pickup spots for the service area (admin-managed; starts empty).
CREATE TABLE IF NOT EXISTS pickup_spots (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'spot',
  address    TEXT,
  lat        DOUBLE PRECISION NOT NULL,
  lng        DOUBLE PRECISION NOT NULL,
  note       TEXT,
  sort       INTEGER NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Runtime settings (auto-offline grace) editable from Admin.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Customer-opened fare disputes, resolved by the owner.
CREATE TABLE IF NOT EXISTS fare_disputes (
  id          TEXT PRIMARY KEY,
  trip_id     TEXT NOT NULL REFERENCES trips(id),
  user_id     TEXT NOT NULL REFERENCES users(id),
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'resolved' | 'rejected'
  resolution  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

-- Promo codes (discount coupons the owner creates).
CREATE TABLE IF NOT EXISTS promo_codes (
  id               TEXT PRIMARY KEY,
  code             TEXT UNIQUE NOT NULL,
  discount_percent INTEGER NOT NULL DEFAULT 10,
  max_uses         INTEGER NOT NULL DEFAULT 50,
  used_count       INTEGER NOT NULL DEFAULT 0,
  valid_from       TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until      TIMESTAMPTZ,
  active           BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Customer rebook shortcuts (frequent destinations, one-tap).
CREATE TABLE IF NOT EXISTS recent_destinations (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  dest_address   TEXT,
  dest_lat       DOUBLE PRECISION,
  dest_lng       DOUBLE PRECISION,
  dest_note      TEXT,
  pickup_address TEXT,
  pickup_lat     DOUBLE PRECISION,
  pickup_lng     DOUBLE PRECISION,
  used_count     INTEGER NOT NULL DEFAULT 1,
  last_used      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- In-trip chat between customer and driver (one thread per trip).
CREATE TABLE IF NOT EXISTS trip_messages (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL REFERENCES trips(id),
  sender_id  TEXT NOT NULL REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trip_messages_trip ON trip_messages(trip_id, created_at);

-- Safety/emergency alerts: every SOS press is recorded, linked to its trip, so
-- the audit trail ("who was with whom, when, where, what happened") survives.
CREATE TABLE IF NOT EXISTS sos_alerts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  trip_id    TEXT REFERENCES trips(id),
  role       TEXT,
  note       TEXT,
  lat        DOUBLE PRECISION,
  lng        DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sos_trip ON sos_alerts(trip_id, created_at);
