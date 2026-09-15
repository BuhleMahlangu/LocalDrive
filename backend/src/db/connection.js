const path = require('path');
const fs = require('fs');
const config = require('../config');
const { createAdapter } = require('./query');

const driver = config.dbDriver || 'sqlite';

// ---- Postgres/PostGIS driver (production target) ----
// Schema is applied out-of-band (backend/schema.sql contains the full DDL,
// including PostGIS geography columns). The async `pg` adapter is the seam;
// repository.js becomes async-aware for the migration. If `pg` or DATABASE_URL
// are missing we fail loudly rather than silently corrupting the app.
if (driver === 'postgres') {
  module.exports = createAdapter({ driver });
} else {
  const Database = require('better-sqlite3');

  const dataDir = path.join(__dirname, '..', '..', 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const dbFile = process.env.DB_FILE || path.join(dataDir, 'drivelocal.sqlite');
  const sqliteDb = new Database(dbFile);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');

  const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT,
  email         TEXT,
  role          TEXT NOT NULL DEFAULT 'customer',
  -- role: 'customer' | 'driver' | 'admin'  (admin = platform owner, also a driver)
  -- driver_status: NULL/approved = can drive; pending = awaiting vetting;
  -- rejected = application declined; suspended = removed from the platform.
  driver_status TEXT,
  driver_rejection_reason TEXT,
  id_number     TEXT,
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

-- Driver application / vetting documents (one row per driver).
CREATE TABLE IF NOT EXISTS driver_documents (
  driver_id            TEXT PRIMARY KEY,
  id_number            TEXT NOT NULL,
  id_copy_path         TEXT,
  selfie_path          TEXT,
  proof_of_residence_path TEXT,
  submitted_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at          TEXT,
  rejection_reason     TEXT
);

-- Driver wallet ledger. available = money the driver can withdraw; owed = the
-- platform's commission on cash trips, to be settled by the driver.
CREATE TABLE IF NOT EXISTS driver_wallets (
  driver_id       TEXT PRIMARY KEY,
  available_cents INTEGER NOT NULL DEFAULT 0,
  owed_cents      INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
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

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fare_disputes (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  reason     TEXT,
  status     TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS promo_codes (
  id         TEXT PRIMARY KEY,
  code       TEXT UNIQUE NOT NULL,
  discount_percent INTEGER NOT NULL DEFAULT 10,
  max_uses   INTEGER NOT NULL DEFAULT 50,
  used_count INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recent_destinations (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  dest_address TEXT,
  dest_lat   REAL,
  dest_lng   REAL,
  dest_note  TEXT,
  pickup_address TEXT,
  pickup_lat REAL,
  pickup_lng REAL,
  used_count INTEGER NOT NULL DEFAULT 1,
  last_used  TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- In-trip chat between customer and driver (one thread per trip).
CREATE TABLE IF NOT EXISTS trip_messages (
  id         TEXT PRIMARY KEY,
  trip_id    TEXT NOT NULL,
  sender_id  TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_trip_messages_trip ON trip_messages(trip_id, created_at);

CREATE TABLE IF NOT EXISTS sos_alerts (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  trip_id    TEXT,
  role       TEXT,
  note       TEXT,
  lat        REAL,
  lng        REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sos_trip ON sos_alerts(trip_id, created_at);
`;

  sqliteDb.exec(SCHEMA);

  // ---- Lightweight migrations for databases created before these columns ----
  function ensureColumn(table, column, ddl) {
    const cols = sqliteDb.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) {
      sqliteDb.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }
  ensureColumn('trips', 'payment_method', "TEXT NOT NULL DEFAULT 'cash'");
  ensureColumn('trips', 'pickup_note', 'TEXT');
  ensureColumn('trips', 'dest_note', 'TEXT');
  ensureColumn('trips', 'scheduled_at', 'TEXT');
  ensureColumn('trips', 'feedback_tags', 'TEXT');
  ensureColumn('trips', 'arrived_at', 'TEXT');
  ensureColumn('trips', 'fare_confirmed_at', 'TEXT');
  ensureColumn('payments', 'redirect_url', 'TEXT');

  // ---- Multi-driver platform migrations ----
  ensureColumn('users', 'driver_status', 'TEXT');
  ensureColumn('users', 'driver_rejection_reason', 'TEXT');
  ensureColumn('users', 'id_number', 'TEXT');

  // Legacy single-driver databases: the owner phone becomes the platform admin
  // (who also drives), and any pre-existing driver row counts as already vetted.
  if (config.driverPhone) {
    sqliteDb.prepare(
      `UPDATE users SET role = 'admin',
         driver_status = COALESCE(driver_status, 'approved'),
         updated_at = datetime('now')
       WHERE phone = ? AND role = 'driver'`,
    ).run(config.driverPhone);
  }
  sqliteDb.prepare(
    "UPDATE users SET driver_status = 'approved' WHERE role = 'driver' AND driver_status IS NULL",
  ).run();

  sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS driver_documents (
    driver_id            TEXT PRIMARY KEY,
    id_number            TEXT NOT NULL,
    id_copy_path         TEXT,
    selfie_path          TEXT,
    proof_of_residence_path TEXT,
    submitted_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at          TEXT,
    rejection_reason     TEXT
  );
  CREATE TABLE IF NOT EXISTS driver_wallets (
    driver_id       TEXT PRIMARY KEY,
    available_cents INTEGER NOT NULL DEFAULT 0,
    owed_cents      INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);

  // Give every approved driver (and the admin owner) a wallet row.
  {
    const approved = sqliteDb.prepare(
      "SELECT id FROM users WHERE role IN ('admin','driver') AND COALESCE(driver_status,'approved') = 'approved'",
    ).all();
    const ensureWallet = sqliteDb.prepare('INSERT OR IGNORE INTO driver_wallets (driver_id) VALUES (?)');
    for (const d of approved) ensureWallet.run(d.id);
  }

  // ---- Ensure new tables exist for older databases ----
  sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS fare_disputes (
    id         TEXT PRIMARY KEY,
    trip_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    reason     TEXT,
    status     TEXT NOT NULL DEFAULT 'open',
    resolution TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE TABLE IF NOT EXISTS promo_codes (
    id         TEXT PRIMARY KEY,
    code       TEXT UNIQUE NOT NULL,
    discount_percent INTEGER NOT NULL DEFAULT 10,
    max_uses   INTEGER NOT NULL DEFAULT 50,
    used_count INTEGER NOT NULL DEFAULT 0,
    valid_from TEXT NOT NULL DEFAULT (datetime('now')),
    valid_until TEXT,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS recent_destinations (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    dest_address TEXT,
    dest_lat   REAL,
    dest_lng   REAL,
    dest_note  TEXT,
    pickup_address TEXT,
    pickup_lat REAL,
    pickup_lng REAL,
    used_count INTEGER NOT NULL DEFAULT 1,
    last_used  TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS trip_messages (
    id         TEXT PRIMARY KEY,
    trip_id    TEXT NOT NULL,
    sender_id  TEXT NOT NULL,
    body       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    read_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_trip_messages_trip ON trip_messages(trip_id, created_at);
  CREATE TABLE IF NOT EXISTS sos_alerts (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    trip_id    TEXT,
    role       TEXT,
    note       TEXT,
    lat        REAL,
    lng        REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_sos_trip ON sos_alerts(trip_id, created_at);
`);

  // ---- Seed a demo promo code ----
  sqliteDb.prepare(`INSERT OR IGNORE INTO promo_codes (id, code, discount_percent, max_uses, valid_until)
  VALUES ('promo_welcome10', 'WELCOME10', 10, 100, datetime('now', '+1 year'))`).run();

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
  const seedSpots = sqliteDb.prepare(
    'INSERT OR IGNORE INTO pickup_spots (id, name, category, address, lat, lng, note, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const s of SPOT_SEED) seedSpots.run(s.id, s.name, s.category, s.address, s.lat, s.lng, s.note || null, s.sort);

  module.exports = createAdapter({ driver: 'sqlite', sqliteDb });
}