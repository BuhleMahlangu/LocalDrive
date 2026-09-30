const http = require('http');
const config = require('./config');
const { createApp } = require('./app');
const { initSocket } = require('./socket');

// Create the HTTP server first so socket.io can attach before Express handles
// requests (WebSocket upgrades for /socket.io get picked up first).
const server = http.createServer();
const { notify } = initSocket(server, config.corsOrigins);
const app = createApp({ notify });
// engine.io owns /socket.io (its listener is prepended on the same server) and
// answers long-polling requests asynchronously. Forwarding those to Express too
// would race with engine.io's delayed writeHead and crash the worker, so only
// non-socket.io traffic goes to Express.
server.on('request', (req, res) => {
  if (String(req.url).startsWith('/socket.io')) return;
  app(req, res);
});

server.listen(config.port, () => {
  console.log(`DriveLocal backend listening on http://localhost:${config.port}`);
  console.log(`Currency: ${config.currency.toUpperCase()} | DB driver: ${config.dbDriver}`);

  // Auto-activate scheduled trips whose scheduled_at time has passed.
  // Runs every 30s; moves them into the live request flow so a driver can accept.
  const repo = require('./db/repository');
  const tripService = require('./services/trips');
  setInterval(() => {
    const now = new Date().toISOString();
    let rows = [];
    try {
      rows = repo.db.prepare(
        `SELECT id FROM trips WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`,
      ).all(now);
    } catch (e) {
      console.error('[scheduler] could not list due trips:', e.message);
      return;
    }

    for (const row of rows) {
      // Per-row guard: one bad trip must not abort the rest of the batch.
      try {
        const trip = tripService.releaseScheduledTrip(row.id);
        if (!trip) continue;
        // Fan out to every online approved driver, the same way an immediate
        // booking is dispatched — not to one representative driver.
        const representative = repo.getDriver();
        const driverPublic = representative ? tripService.publicDriver(representative) : {};
        for (const d of repo.listOnlineDrivers()) {
          notify.newTripToDriver(trip, d.id, driverPublic);
        }
        notify.tripUpdated(trip);
        console.log(`[scheduler] released scheduled trip ${trip.id} for dispatch`);
      } catch (e) {
        console.error(`[scheduler] error releasing trip ${row.id}:`, e.message);
      }
    }
  }, 30_000);
});