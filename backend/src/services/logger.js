// Lightweight structured logging: every request and every error is appended as
// one JSON line to logs/requests.jsonl and logs/errors.jsonl (plus the console
// in non-production). Kept dependency-free and lazy so tests (DB_FILE=:memory:)
// stay hermetic and the process can still exit cleanly.

const fs = require('fs');
const path = require('path');
const config = require('../config');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');
const isTest = config.nodeEnv === 'test';

let requestStream = null;
let errorStream = null;

function streamFor(kind) {
  if (isTest) return null;
  if (kind === 'request' && !requestStream) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    requestStream = fs.createWriteStream(path.join(LOG_DIR, 'requests.jsonl'), { flags: 'a' });
  }
  if (kind === 'error' && !errorStream) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    errorStream = fs.createWriteStream(path.join(LOG_DIR, 'errors.jsonl'), { flags: 'a' });
  }
  return kind === 'request' ? requestStream : errorStream;
}

function write(kind, entry) {
  const stream = streamFor(kind);
  if (!stream) return;
  try {
    stream.write(`${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must never crash the app.
  }
}

// Attach to a response's 'finish' event to record the outcome once known.
function attachRequestLogger(req, res, next) {
  req._dlStart = Date.now();
  res.on('finish', () => {
    const entry = {
      ts: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      ms: Date.now() - req._dlStart,
      ip: req.ip || (req.socket && req.socket.remoteAddress) || null,
    };
    write('request', entry);
    if (config.nodeEnv === 'development') {
      console.log(`${req.method} ${req.path} -> ${res.statusCode} (${entry.ms}ms)`);
    }
  });
  next();
}

// 4xx errors (bad client input, stale polls, lockouts) are routine and would
// otherwise drown the error log in noise; they stay visible at warn level in
// dev and are captured for the audit trail by the request logger. 5xx errors
// (or unknown) go to the error log with a stack trace.
function logError(err, req) {
  const status = (err && err.status) || 500;
  const entry = {
    ts: new Date().toISOString(),
    status,
    name: (err && err.name) || 'Error',
    message: (err && err.message) || String(err),
    stack: config.nodeEnv === 'production' ? undefined : (err && err.stack),
    method: req && req.method,
    path: req && (req.originalUrl || req.url),
  };
  if (status >= 500) {
    write('error', entry);
    console.error('[error]', entry.message);
  } else if (config.nodeEnv === 'development') {
    console.warn(`[warn] ${status} ${req && req.method} ${req && (req.originalUrl || req.url)} — ${entry.message}`);
  }
}

module.exports = { attachRequestLogger, logError };