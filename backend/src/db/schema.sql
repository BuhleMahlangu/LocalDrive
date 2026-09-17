-- DriveLocal complete schema (PostgreSQL/PostGIS target).
-- The SQLite dev driver (src/db/connection.js) mirrors these tables so the
-- same queries work locally without PostGIS.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT,
  email         TEXT,
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
  owed_cents      INTEGER NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
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
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at    TIMESTAMPTZ,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  cancelled_at   TIMESTAMPTZ
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

-- Phone OTP verification
CREATE TABLE IF NOT EXISTS otps (
  phone      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
