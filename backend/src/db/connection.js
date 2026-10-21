const path = require('path');
const fs = require('fs');
const config = require('../config');
const { createAdapter } = require('./query');

const driver = config.dbDriver || 'sqlite';

// ---- Postgres/PostGIS driver (production target) ----
// Schema is applied out-of-band (backend/schema.sql contains the full DDL,
// including PostGIS geography columns).
//
// NOTE: the Postgres adapter in query.js executes async queries and returns
// promises, but repository.js still consumes its methods synchronously
// (better-sqlite3-style). Selecting postgres today would silently return
// promise-shaped objects through every repository call — truthy shells whose
// fields are all undefined — which corrupts auth, trips and payments without
// erroring. Block the switch until the repository is async-aware; see
// docs/postgres-migration.md for the porting guide.
if (driver === 'postgres') {
  throw new Error(
    'DB_DRIVER=postgres is not supported yet: the Postgres adapter returns awaited '
    + 'promises but src/db/repository.js still uses the synchronous better-sqlite3 '
    + 'surface. Follow docs/postgres-migration.md to make the repository async-aware '
    + 'before switching. Until then, keep DB_DRIVER=sqlite.',
  );
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
  pin_hash      TEXT,
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

-- Driver wallet ledger. available = money the driver can withdraw.
CREATE TABLE IF NOT EXISTS driver_wallets (
  driver_id       TEXT PRIMARY KEY,
  available_cents INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS driver_bank_accounts (
  driver_id      TEXT PRIMARY KEY,
  account_holder TEXT NOT NULL,
  bank_name      TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_type   TEXT NOT NULL DEFAULT 'current',
  branch_code    TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payout_requests (
  id            TEXT PRIMARY KEY,
  driver_id     TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at   TEXT,
  reviewed_by   TEXT,
  reference     TEXT
);
CREATE INDEX IF NOT EXISTS idx_payout_requests_driver ON payout_requests(driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payout_requests_status ON payout_requests(status);

CREATE TABLE IF NOT EXISTS rate_limit_counters (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL DEFAULT 0,
  reset_at  INTEGER NOT NULL
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
  promo_code     TEXT,
  promo_percent  REAL NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL DEFAULT 'cash',
  tip_amount     REAL NOT NULL DEFAULT 0,
  rating         INTEGER,
  feedback_tags  TEXT,
  cancel_reason  TEXT,
  cancel_actor   TEXT,
  scheduled_at   TEXT,
  passenger_name  TEXT,
  passenger_phone TEXT,
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

-- Kept for older databases; login no longer uses OTP codes (phone + PIN now).
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
  ensureColumn('trips', 'promo_code', 'TEXT');
  ensureColumn('trips', 'promo_percent', "REAL NOT NULL DEFAULT 0");
  ensureColumn('trips', 'passenger_name', 'TEXT');
  ensureColumn('trips', 'passenger_phone', 'TEXT');
  ensureColumn('payout_requests', 'provider_reference', 'TEXT');
  ensureColumn('payout_requests', 'provider_status', 'TEXT');
  ensureColumn('payout_requests', 'provider_paid_at', 'TEXT');
  ensureColumn('payout_requests', 'reconciliation_note', 'TEXT');

  // ---- Multi-driver platform migrations ----
  ensureColumn('users', 'driver_status', 'TEXT');
  ensureColumn('users', 'driver_rejection_reason', 'TEXT');
  ensureColumn('users', 'id_number', 'TEXT');
  ensureColumn('users', 'pin_hash', 'TEXT');

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
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- Driver subscription: freemium model. The owner (config.driverPhone) is
  -- 'free' forever; other drivers need an active paid period to receive
  -- bookings. period_end in the future = active; 'suspended' blocks dispatch.
  CREATE TABLE IF NOT EXISTS driver_subscriptions (
    driver_id        TEXT PRIMARY KEY,
    plan             TEXT NOT NULL DEFAULT 'unpaid',
    status           TEXT NOT NULL DEFAULT 'unpaid',
    price_cents      INTEGER NOT NULL DEFAULT 0,
    period_start     TEXT,
    period_end       TEXT,
    last_payment_ref TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS subscription_payments (
    id             TEXT PRIMARY KEY,
    driver_id      TEXT NOT NULL,
    amount_cents   INTEGER NOT NULL DEFAULT 0,
    method         TEXT NOT NULL DEFAULT 'manual',
    reference      TEXT,
    months         INTEGER NOT NULL DEFAULT 1,
    recorded_by    TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS customer_documents (
    customer_id    TEXT PRIMARY KEY,
    id_number      TEXT NOT NULL,
    id_copy_path   TEXT,
    selfie_path    TEXT,
    submitted_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS driver_bank_accounts (
    driver_id      TEXT PRIMARY KEY,
    account_holder TEXT NOT NULL,
    bank_name      TEXT NOT NULL,
    account_number TEXT NOT NULL,
    account_type   TEXT NOT NULL DEFAULT 'current',
    branch_code    TEXT,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS payout_requests (
    id            TEXT PRIMARY KEY,
    driver_id     TEXT NOT NULL,
    amount_cents  INTEGER NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    note          TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at   TEXT,
    reviewed_by   TEXT,
    reference     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_payout_requests_driver ON payout_requests(driver_id, created_at DESC);
  `);

  // Safety gate: a driver without an ID copy + selfie on file may not carry
  // riders. Clear the persisted online flag of any such legacy driver so they
  // drop out of the dispatch pool until they verify (the go-online and accept
  // routes block them regardless).
  sqliteDb.prepare(
    `UPDATE users SET is_online = 0, updated_at = datetime('now')
     WHERE role = 'driver' AND is_online = 1
       AND id NOT IN (
         SELECT driver_id FROM driver_documents
         WHERE id_copy_path IS NOT NULL AND selfie_path IS NOT NULL
       )`,
  ).run();

  // Give every approved driver (and the admin owner) a wallet row.
  {
    const approved = sqliteDb.prepare(
      "SELECT id FROM users WHERE role IN ('admin','driver') AND COALESCE(driver_status,'approved') = 'approved'",
    ).all();
    const ensureWallet = sqliteDb.prepare('INSERT OR IGNORE INTO driver_wallets (driver_id) VALUES (?)');
    const ensureSub = sqliteDb.prepare('INSERT OR IGNORE INTO driver_subscriptions (driver_id) VALUES (?)');
    for (const d of approved) {
      ensureWallet.run(d.id);
      ensureSub.run(d.id);
    }
  }

  // Freemium: the platform owner (role 'admin', i.e. config.driverPhone) never
  // pays. Backfill/repair that here so it holds on existing databases too.
  sqliteDb.prepare(
    `UPDATE driver_subscriptions SET plan = 'free', status = 'active', updated_at = datetime('now')
     WHERE driver_id IN (SELECT id FROM users WHERE role = 'admin') AND plan != 'free'`,
  ).run();

  // ---- Ensure new tables exist for older databases ----
  sqliteDb.exec(`
  CREATE TABLE IF NOT EXISTS driver_subscriptions (
    driver_id        TEXT PRIMARY KEY,
    plan             TEXT NOT NULL DEFAULT 'unpaid',
    status           TEXT NOT NULL DEFAULT 'unpaid',
    price_cents      INTEGER NOT NULL DEFAULT 0,
    period_start     TEXT,
    period_end       TEXT,
    last_payment_ref TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS subscription_payments (
    id             TEXT PRIMARY KEY,
    driver_id      TEXT NOT NULL,
    amount_cents   INTEGER NOT NULL DEFAULT 0,
    method         TEXT NOT NULL DEFAULT 'manual',
    reference      TEXT,
    months         INTEGER NOT NULL DEFAULT 1,
    recorded_by    TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
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

  // ---- Performance indices (mirror of the Postgres target schema) ----
  // Safe to re-run on every boot; missing indices are cheap to add even to an
  // existing database, and duplicate creation is a no-op.
  sqliteDb.exec(`
  CREATE INDEX IF NOT EXISTS idx_trips_customer ON trips(customer_id, requested_at DESC);
  CREATE INDEX IF NOT EXISTS idx_trips_driver   ON trips(driver_id, requested_at DESC);
  CREATE INDEX IF NOT EXISTS idx_trips_status   ON trips(status);
  CREATE INDEX IF NOT EXISTS idx_payments_trip  ON payments(trip_id);
  CREATE INDEX IF NOT EXISTS idx_saved_places_user ON saved_places(user_id);
  `);

  module.exports = createAdapter({ driver: 'sqlite', sqliteDb });
}