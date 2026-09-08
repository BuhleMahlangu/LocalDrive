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
  feedback_tags  TEXT,
  cancel_reason  TEXT,
  cancel_actor   TEXT,
  scheduled_at   TEXT,
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

CREATE TABLE IF NOT EXISTS saved_places (
  id        TEXT PRIMARY KEY,
  user_id   TEXT NOT NULL,
  label     TEXT NOT NULL,
  kind      TEXT NOT NULL DEFAULT 'place',   -- 'home' | 'work' | 'place'
  address   TEXT,
  lat       REAL NOT NULL,
  lng       REAL NOT NULL,
  note      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pickup_spots (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  category  TEXT NOT NULL DEFAULT 'spot',
  address   TEXT,
  lat       REAL NOT NULL,
  lng       REAL NOT NULL,
  note      TEXT,
  sort      INTEGER NOT NULL DEFAULT 0,
  active    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
ensureColumn('trips', 'scheduled_at', 'TEXT');
ensureColumn('trips', 'feedback_tags', 'TEXT');
ensureColumn('payments', 'redirect_url', 'TEXT');

// ---- Default pickup spots for the Kriel / Thubelihle service area ----
// Insert-only (fixed IDs) so existing databases pick up the seed without
// duplicating. Coordinates are approximate service-area landmarks; the owner
// can adjust them or ask for a custom list.
const SPOT_SEED = [
  { id: 'spot_kriel_town', name: 'Kriel Town Centre', category: 'town', address: 'Main street, Kriel', lat: -26.2148, lng: 29.2913, sort: 1 },
  { id: 'spot_kriel_rank', name: 'Kriel Taxi Rank', category: 'rank', address: 'Taxi rank, Kriel', lat: -26.2162, lng: 29.2922, sort: 2 },
  { id: 'spot_kriel_mall', name: 'Kriel Mall', category: 'mall', address: 'Kriel', lat: -26.2125, lng: 29.2945, sort: 3 },
  { id: 'spot_thub_clinic', name: 'Thubelihle Clinic', category: 'clinic', address: 'Thubelihle, Kriel', lat: -26.219, lng: 29.2495, sort: 4 },
  { id: 'spot_thub_hall', name: 'Thubelihle Community Hall', category: 'hall', address: 'Thubelihle, Kriel', lat: -26.221, lng: 29.247, sort: 5 },
  { id: 'spot_thub_fourways', name: 'Thubelihle Four Ways', category: 'landmark', address: 'Four-ways junction, Thubelihle', lat: -26.2172, lng: 29.252, sort: 6 },
  { id: 'spot_thub_school', name: 'Thubelihle Primary School', category: 'school', address: 'Thubelihle, Kriel', lat: -26.2185, lng: 29.251, sort: 7 },
  { id: 'spot_kriel_power', name: 'Kriel Power Station Gate', category: 'landmark', address: 'Kriel Power Station Road', lat: -26.2295, lng: 29.177, sort: 8 },
];
const seedSpots = db.prepare(
  'INSERT OR IGNORE INTO pickup_spots (id, name, category, address, lat, lng, note, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
);
for (const s of SPOT_SEED) seedSpots.run(s.id, s.name, s.category, s.address, s.lat, s.lng, s.note || null, s.sort);

module.exports = db;
