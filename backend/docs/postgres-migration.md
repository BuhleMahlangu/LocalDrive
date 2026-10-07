# DriveLocal — SQLite → Postgres/PostGIS migration guide

SQLite is the correct choice for the single-driver launch (one file, no server,
trivial backups). Postgres/PostGIS is for **when you scale**: multiple drivers,
concurrent writers, geospatial queries against the whole fleet, or a managed
hosted DB. This document is the stepping-stone so that jump is mechanical, not
a rewrite.

## Current state

- `src/db/connection.js` opens SQLite and is the **only** place that does.
- `src/db/repository.js` is a synchronous, better-sqlite3-style data layer
  (`db.prepare(sql).run/get/all`) that the whole app depends on.
- `src/db/query.js` already contains a Postgres adapter: it rewrites `?`
  placeholders to `$1..$n` and returns **awaited results — i.e. Promises**.
- `src/db/schema.sql` is a full Postgres/PostGIS DDL kept in sync with the
  SQLite DDL (tables, columns, indices). Keep them mirrored side by side when
  you change either.

> **Blocked today by design:** `DB_DRIVER=postgres` makes `connection.js` throw
> a clear error instead of starting. This is deliberate — the sync repository
> calling an async adapter would return promise-shaped objects through every
> getter (`getUserById()` → truthy shell with `undefined` fields), corrupting
> auth, trips and payments with no error. Flip the switch **only** after step 3.

## The port (three steps)

### 1. Install the driver and provision the DB

```bash
cd backend
npm install pg
# Create the database and apply the schema (PostGIS enabled):
psql "$DATABASE_URL" -c 'CREATE EXTENSION IF NOT EXISTS postgis;'
psql "$DATABASE_URL" -f src/db/schema.sql
```

SQLite `INTEGER` booleans become PG `BOOLEAN`, `REAL` becomes `DOUBLE PRECISION`
/ `NUMERIC`, and `TEXT` timestamps become `TIMESTAMPTZ`. The schema.sql file is
the single source of truth for the target shape.

### 2. Make `repository.js` async

This is the real work. The facade keeps the same names, so the mechanical part
is small:

- Every method becomes `async`, calls become `await db.prepare(...).get()`.
- `mapTrip/mapUser/mapPayment` already deserialize rows; they must now also
  tolerate PG's column names (identical — both use the SQLite DDL names) and
  coerce PG types (booleans, `bigint` counts, `Date` objects for timestamps).
- SQLite-specific SQL in `repository.js` to port:
  - `datetime('now')` → `now()` (not used in queries, only DDL defaults).
  - `||` concatenation — fine in both.
  - Any `INSERT OR IGNORE` / `ON CONFLICT` → PG `ON CONFLICT` forms.
  - `PRAGMA` features — none used outside `connection.js`.
- `transaction(fn)`: SQLite passes a bound function; the PG adapter must wrap
  its pool in a real `BEGIN…COMMIT/ROLLBACK` so `repo.*` batched writes
  (e.g. `rateTrip`) stay atomic.
- The better-sqlite3 single-connection guarantee that makes
  `claimTrip`/`activateScheduledTripClaim` race-free is **not** automatic in
  PG pool concurrency. Keep the `WHERE status = 'requested'` guard (it is the
  atomic first-wins claim) — it's already correct.

Because this touches the whole data layer, do it as one focused PR with the
existing `test/*` suite run against SQLite (unchanged) and a PG variant.
The `pg` pool in tests: `DATABASE_URL=... npm test` once step 3 lands.

### 3. Unblock the switch

Now that `repository.js` awaits, change `src/db/connection.js` back to:

```js
if (driver === 'postgres') {
  module.exports = createAdapter({ driver });
}
```

and verify: `DB_DRIVER=postgres DATABASE_URL=... npm test`.

### 4. PostGIS-specific extras (when you need them)

PostGIS geography columns (`driver_locations.geom`, radius queries) are in
`schema.sql` already. Add the SQL:
- Nearest-driver queries: `ST_DWithin(loc.geom, ST_SetSRID(ST_MakePoint($lng,$lat),4326)::geography, radius_m)`.
- Retained-location history (the 60-minute window) is the same table + index.

## Gotchas

- **Timestamps**: SQLite stores ISO strings; PG returns `Date` objects. All
  reads in the app go through `mapTrip`/`mapUser`/`mapPayment`/`mapPlace` —
  normalise to ISO strings there so services and the JSON API never notice.
- **Case**: PG folds unquoted identifiers to lowercase — the DDL already uses
  lowercase names, so `repository.js` queries match.
- **Concurrency**: SQLite serialises writes; PG pools run them in parallel.
  The first-wins claim and per-trip payment updates are guarded by `WHERE`
  clauses on status — keep those guards.
- **Backups**: switch from `npm run backup` (SQLite VACUUM-style) to `pg_dump`
  (or a managed provider's snapshots). Update `deploy/*` and compose files
  when you do.

## Suggested order

1. Sync `schema.sql` (done — check it stays current).
2. Port `repository.js` to async (PR, tests green on SQLite first).
3. Enable PG + run the full test suite against a real instance.
4. Move cron/compose backups to `pg_dump`.