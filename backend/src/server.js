const http = require('http');
const config = require('./config');
const { createApp } = require('./app');
const { initSocket } = require('./socket');

// Create the HTTP server first so socket.io can attach before Express handles
// requests (WebSocket upgrades for /socket.io get picked up first).
const server = http.createServer();
const { notify } = initSocket(server, config.corsOrigins);
const app = createApp({ notify });
server.on('request', app);

server.listen(config.port, () => {
  console.log(`DriveLocal backend listening on http://localhost:${config.port}`);
  console.log(`Currency: ${config.currency.toUpperCase()} | DB driver: ${config.dbDriver}`);

  // Auto-activate scheduled trips whose scheduled_at time has passed.
  // Runs every 30s; moves them into the live request flow so the driver can accept.
  const repo = require('./db/repository');
  const tripService = require('./services/trips');
  setInterval(() => {
    try {
      const now = new Date().toISOString();
      const rows = repo.db.prepare(
        `SELECT id FROM trips WHERE status = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`,
      ).all(now);
      for (const row of rows) {
        const trip = tripService.activateScheduledTrip(row.id);
        const driver = repo.getDriver();
        if (driver) {
          notify.newTripToDriver(trip, driver.id, {});
          notify.tripUpdated(trip);
        }
      }
    } catch (e) {
      console.error('[scheduler] error activating scheduled trips:', e.message);
    }
  }, 30_000);
});