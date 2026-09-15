const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const authRoutes = require('./routes/auth');
const chatRoutes = require('./routes/chat');
const driverRoutesFactory = require('./routes/driver');
const customerRoutesFactory = require('./routes/customer');
const paymentsRoutes = require('./routes/payments');
const pushRoutes = require('./routes/push');
const spotsRoutes = require('./routes/spots');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const uploadsRoutes = require('./routes/uploads');
const paymentsService = require('./services/payments');
const { notFound, errorHandler } = require('./middleware');
const { attachRequestLogger } = require('./services/logger');

// Build the Express app. `notify` is the socket.io realtime helper set
// ({ tripUpdated, newTripToDriver, ... }); tests pass a no-op stub.
function createApp({ notify }) {
  const app = express();
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  app.use(attachRequestLogger);

  // Yoco webhook needs the raw request body for signature verification.
  app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      const result = await paymentsService.handleWebhook(req, notify || null);
      res.json(result);
    } catch (e) {
      res.status(e.status || 400).json({ error: e.message });
    }
  });

  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'drivelocal-backend', currency: config.currency, time: new Date().toISOString() });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/push', pushRoutes);
  app.use('/api/chat', chatRoutes({ notify }));
  app.use('/api/payments', paymentsRoutes);
  app.use('/api/pickup-spots', spotsRoutes());
  app.use('/api/public', publicRoutes());

  // API documentation: raw OpenAPI YAML + a self-contained browser viewer
  // (ReDoc via CDN, so no extra npm deps are needed).
  const OPENAPI_FILE = path.join(__dirname, '..', 'docs', 'openapi.yaml');
  const openapi = fs.readFileSync(OPENAPI_FILE, 'utf8');
  app.get('/api/docs', (_req, res) => res.type('application/yaml').send(openapi));
  app.get('/api/docs/ui', (_req, res) => res.type('text/html').send(`<!doctype html>
<html><head><title>DriveLocal API docs</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head><body style="margin:0">
<redoc spec-url="/api/docs"></redoc>
<script src="https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js"></script>
</body></html>`));

  app.use('/api/driver', driverRoutesFactory({ notify }));
  app.use('/api/customer', customerRoutesFactory({ notify }));
  app.use('/api/admin', adminRoutes);
  app.use('/api', uploadsRoutes); // serve vetted document uploads

  // Serve the built React app from the backend (single-server deploy). Hashed Vite
  // assets get immutable cache headers (CDN-friendly); index.html + the SW are
  // short-lived. In dev the frontend runs on Vite (port 5173), so nothing here
  // shadows it: we only mount when app/dist actually exists.
  const APP_DIST = path.join(__dirname, '..', '..', 'app', 'dist');
  if (fs.existsSync(path.join(APP_DIST, 'index.html'))) {
    app.use(express.static(APP_DIST, {
      setHeaders(res, filePath) {
        const name = path.basename(filePath);
        // Hashed bundles (index-<hash>.js/css) are content-addressed -> cache hard.
        if (/\.(js|css|png|svg|woff2?|ico)(\.map)?$/.test(name)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }));
    // SPA fallback for client-side routes (there are few, but be safe).
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
      res.sendFile(path.join(APP_DIST, 'index.html'));
    });
  }

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };