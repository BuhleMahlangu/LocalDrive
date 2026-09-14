// Persistence abstraction. Every SQL statement in the app flows through this
// db-shaped facade ({ prepare, exec, transaction }) so the driver can be swapped
// without touching services or routes. It deliberately mimics better-sqlite3's
// Statement surface (run/get/all) so existing callers keep working unchanged.
//
//   driver            module        params                 schema
//   ---------------   ------------  ---------------------  ------------------
//   sqlite (default)  better-sqlite3  ?                      src/db/connection.js
//   postgres          pg             $1..$n (auto-rewritten) backend/schema.sql
//
// The Postgres adapter executes async queries and returns { rows }. It is a
// working seam rather than a full port: callers that need it (repository.js)
// must become async-aware, which is the documented migration path.

const CACHE_LIMIT = 500; // guard against unbounded prepared-statement cache

// Rewrite SQLite `?` positional placeholders into Postgres `$1, $2, ...` while
// leaving string literals untouched (single-quoted, '' escapes).
function rewritePlaceholders(sql) {
  let out = '';
  let n = 0;
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inStr) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          out += sql[i + 1]; // '' is an escaped quote
          i += 1;
        } else {
          inStr = false;
        }
      }
    } else if (ch === "'") {
      inStr = true;
      out += ch;
    } else if (ch === '?') {
      out += `$${++n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function createSqliteAdapter(sqliteDb) {
  const cache = new Map();
  function stmt(sql) {
    let s = cache.get(sql);
    if (!s) {
      s = sqliteDb.prepare(sql);
      if (cache.size >= CACHE_LIMIT) cache.clear();
      cache.set(sql, s);
    }
    return s;
  }
  return {
    driver: 'sqlite',
    prepare(sql) {
      const s = stmt(sql);
      return {
        run: (...params) => s.run(...params),
        get: (...params) => s.get(...params),
        all: (...params) => s.all(...params),
      };
    },
    exec(sql) { return sqliteDb.exec(sql); },
    transaction(fn) { return sqliteDb.transaction(fn); },
    close() { sqliteDb.close(); },
  };
}

function createPostgresAdapter({ pool } = {}) {
  if (!pool) {
    let Pool;
    try {
      ({ Pool } = require('pg'));
    } catch {
      throw new Error(
        'DB_DRIVER=postgres requires the `pg` package. Run `npm install pg` in backend/ '
        + 'and set DATABASE_URL to your Postgres connection string.',
      );
    }
    const pgConfig = require('../config');
    if (!pgConfig.databaseUrl) {
      throw new Error('DB_DRIVER=postgres requires DATABASE_URL to be set.');
    }
    pool = new Pool({ connectionString: pgConfig.databaseUrl });
  }

  return {
    driver: 'postgres',
    prepare(sql) {
      const text = rewritePlaceholders(sql);
      return {
        run: (...params) => pool.query(text, params),
        get: async (...params) => {
          const { rows } = await pool.query(text, params);
          return rows[0] ?? null;
        },
        all: async (...params) => {
          const { rows } = await pool.query(text, params);
          return rows;
        },
      };
    },
    exec(sql) { return pool.query(rewritePlaceholders(sql)); },
    transaction(fn) { return fn(pool); }, // async seam; see repository migration path
    close() { return pool.end(); },
  };
}

// Build the right adapter for the configured driver.
function createAdapter({ driver, sqliteDb, pool } = {}) {
  if (driver === 'postgres') return createPostgresAdapter({ pool });
  if (!sqliteDb) {
    throw new Error('DB driver must be "sqlite" or "postgres"');
  }
  return createSqliteAdapter(sqliteDb);
}

module.exports = { createAdapter, createSqliteAdapter, createPostgresAdapter, rewritePlaceholders };