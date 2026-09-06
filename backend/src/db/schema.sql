-- DriveLocal complete schema (PostgreSQL/PostGIS target).
-- The SQLite dev driver (src/db/connection.js) mirrors these tables so the
-- same queries work locally without PostGIS.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT,
  email         TEXT,
  role          TEXT NOT NULL DEFAULT 'customer',       -- 'customer' | 'driver'
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
  payment_method TEXT NOT NULL DEFAULT 'cash',
  tip_amount     NUMERIC NOT NULL DEFAULT 0,
  rating         INTEGER,
  cancel_reason  TEXT,
  cancel_actor   TEXT,          -- 'customer' | 'driver' | 'system'
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

-- FCM push tokens per user
CREATE TABLE IF NOT EXISTS push_tokens (
  user_id    TEXT NOT NULL REFERENCES users(id),
  token      TEXT NOT NULL,
  platform   TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, token)
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
