const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const dataDir = path.join(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbFile = process.env.DB_FILE || path.join(dataDir, 'drivelocal.sqlite');
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT,
  email         TEXT,
  role          TEXT NOT NULL DEFAULT 'customer',
  rating_sum    INTEGER NOT NULL DEFAULT 0,
  rating_count  INTEGER NOT NULL DEFAULT 0,
  is_online     INTEGER NOT NULL DEFAULT 0,
  vehicle_type  TEXT,
  license_plate TEXT,
  photo_url     TEXT,
  service_radius_km REAL NOT NULL DEFAULT 50,
  base_fare     REAL NOT NULL DEFAULT 3.00,
  per_km_rate   REAL NOT NULL DEFAULT 1.50,
  per_min_rate  REAL NOT NULL DEFAULT 0.25,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS driver_locations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id  TEXT NOT NULL,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  heading    REAL,
  accuracy   REAL,
  timestamp  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trips (
  id             TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL,
  driver_id      TEXT,
  status         TEXT NOT NULL DEFAULT 'requested',
  pickup_address TEXT,
  pickup_lat     REAL,
  pickup_lng     REAL,
  pickup_note    TEXT,
  dest_address   TEXT,
  dest_lat       REAL,
  dest_lng       REAL,
  dest_note      TEXT,
  route_polyline TEXT,
  distance_km    REAL,
  duration_min   REAL,
  fare_estimate  REAL,
  final_fare     REAL,
  price_model    TEXT NOT NULL DEFAULT 'distance_time',
  payment_method TEXT NOT NULL DEFAULT 'cash',
  tip_amount     REAL NOT NULL DEFAULT 0,
  rating         INTEGER,
  cancel_reason  TEXT,
  cancel_actor   TEXT,
  requested_at   TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at    TEXT,
  started_at     TEXT,
  completed_at   TEXT,
  cancelled_at   TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id                 TEXT PRIMARY KEY,
  trip_id            TEXT NOT NULL,
  amount_cents       INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  provider           TEXT NOT NULL DEFAULT 'cash',
  payment_intent_id  TEXT,
  redirect_url       TEXT,
  driver_payout_cents INTEGER,
  platform_fee_cents INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'zar',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at            TEXT
);

CREATE TABLE IF NOT EXISTS otps (
  phone      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_tokens (
  user_id    TEXT NOT NULL,
  token      TEXT NOT NULL,
  platform   TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, token)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  user_id    TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, endpoint)
);
`;

db.exec(SCHEMA);

// ---- Lightweight migrations for databases created before these columns ----
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
ensureColumn('trips', 'payment_method', "TEXT NOT NULL DEFAULT 'cash'");
ensureColumn('trips', 'pickup_note', 'TEXT');
ensureColumn('trips', 'dest_note', 'TEXT');
ensureColumn('payments', 'redirect_url', 'TEXT');

module.exports = db;
