// Unit tests for the persistence facade (src/db/query.js): placeholder
// rewriting for the Postgres seam, and the sqlite adapter shape + round-trip.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { rewritePlaceholders, createSqliteAdapter, createPostgresAdapter } = require('../src/db/query');

test('rewritePlaceholders maps ? to $n in order', () => {
  assert.equal(
    rewritePlaceholders('INSERT INTO t (a, b, c) VALUES (?, ?, ?)'),
    'INSERT INTO t (a, b, c) VALUES ($1, $2, $3)',
  );
  assert.equal(
    rewritePlaceholders('SELECT * FROM trips WHERE id = ? AND status = ?'),
    'SELECT * FROM trips WHERE id = $1 AND status = $2',
  );
});

test('rewritePlaceholders leaves quoted string literals untouched', () => {
  assert.equal(rewritePlaceholders("SELECT '?' as q, x = ?"), "SELECT '?' as q, x = $1");
  // '' escaped quotes are skipped too.
  assert.equal(rewritePlaceholders("SELECT 'it''s ?' WHERE a = ?"), "SELECT 'it''s ?' WHERE a = $1");
});

function memSqlite() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)');
  return db;
}

test('sqlite adapter round-trips run/get/all', () => {
  const raw = memSqlite();
  const adapter = createSqliteAdapter(raw);

  adapter.prepare('INSERT INTO t (id, n) VALUES (?, ?)').run('a', 1);
  adapter.prepare('INSERT INTO t (id, n) VALUES (?, ?)').run('b', 2);

  const one = adapter.prepare('SELECT * FROM t WHERE id = ?').get('a');
  assert.deepEqual(one, { id: 'a', n: 1 });

  const all = adapter.prepare('SELECT * FROM t ORDER BY n').all();
  assert.equal(all.length, 2);
  assert.equal(all[1].id, 'b');

  adapter.close();
});

test('sqlite adapter transaction rolls back on error', () => {
  const raw = memSqlite();
  const adapter = createSqliteAdapter(raw);

  assert.throws(() => {
    adapter.transaction(() => {
      adapter.prepare('INSERT INTO t (id, n) VALUES (?, ?)').run('x', 1);
      throw new Error('boom');
    })();
  });

  assert.equal(adapter.prepare('SELECT COUNT(*) AS c FROM t').get().c, 0);
  adapter.close();
});

test('postgres adapter without pg fails with a clear message', () => {
  // Environment has no `pg` installed, so the adapter must fail loudly with a
  // helpful pointer instead of a confusing crash later.
  assert.throws(
    () => createPostgresAdapter({ pool: null }),
    /DB_DRIVER=postgres requires the `pg` package/,
  );
});