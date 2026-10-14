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
const adminRoutesFactory = require('./routes/admin');
const sosRoutesFactory = require('./routes/sos');
const uploadsRoutes = require('./routes/uploads');
const paymentsService = require('./services/payments');
const { notFound, errorHandler } = require('./middleware');
const { attachRequestLogger } = require('./services/logger');

// Build the Express app. `notify` is the socket.io realtime helper set
// ({ tripUpdated, newTripToDriver, ... }); tests pass a no-op stub.
function createApp({ notify }) {
  const app = express();
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  // Lightweight security headers (no extra dependency). Keep these conservative:
  // they never inspect bodies or alter routing, so they can't break endpoints.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (config.nodeEnv === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      res.setHeader('Content-Security-Policy',
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss: https:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'");
    }
    next();
  });
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

  // Payout status webhook (bank/provider callbacks). Kept raw so the HMAC
  // signature over the original payload can be verified. Payload (JSON):
  // { "payoutId" | "providerReference" | "reference", "status", "note" }.
  const payoutRepo = require('./db/repository');
  const crypto = require('crypto');
  app.post('/api/payouts/webhook', express.raw({ type: 'application/json' }), (req, res) => {
    const secret = config.payoutWebhookSecret;
    if (secret) {
      const sig = String(req.headers['x-payout-webhook-signature'] || req.headers['x-webhook-signature'] || '');
      const digest = crypto.createHmac('sha256', secret).update(req.body || Buffer.from('')).digest('hex');
      let ok = false;
      try {
        ok = sig.length === digest.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(digest));
      } catch { ok = false; }
      if (!ok) return res.status(401).json({ error: 'Invalid webhook signature' });
    } else if (config.nodeEnv === 'production') {
      return res.status(503).json({ error: 'PAYOUT_WEBHOOK_SECRET not configured' });
    } else {
      console.warn('[payout-webhook] unsigned call accepted in non-production (secret unset)');
    }

    let event = {};
    try { event = JSON.parse((req.body || Buffer.from('[]')).toString('utf8') || '{}'); }
    catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

    const findByRef = (pr, ref) => {
      if (!ref) return null;
      try {
        const row = payoutRepo.db.prepare(
          'SELECT id FROM payout_requests WHERE provider_reference = ? OR reference = ? LIMIT 1',
        ).get(String(ref), String(ref));
        return row ? payoutRepo.getPayoutRequest(row.id) : null;
      } catch { return null; }
    };

    let payout = null;
    if (event.payoutId) payout = payoutRepo.getPayoutRequest(event.payoutId);
    else if (event.providerReference || event.reference) {
      payout = findByRef(null, event.providerReference || event.reference);
    }

    if (!payout) {
      return res.json({ received: true, warning: 'payout not found', providerReference: event.providerReference || null });
    }

    const rawStatus = String(event.status || event.event || '').toLowerCase();
    let newStatus = null;
    if (rawStatus.includes('paid') || rawStatus.includes('completed') || rawStatus.includes('success')) newStatus = 'paid';
    else if (rawStatus.includes('fail') || rawStatus.includes('reject')) newStatus = 'rejected';
    else if (rawStatus.includes('process')) newStatus = 'approved';
    else if (rawStatus) newStatus = null;

    const before = payout.status;
    payoutRepo.reconcilePayoutRequest(payout.id, {
      reference: event.reference || null,
      providerReference: event.providerReference || event.transactionId || null,
      providerStatus: event.status || event.providerStatus || rawStatus || null,
      reconciliationNote: event.note || event.message || null,
    });

    if (newStatus && newStatus !== before) {
      // mark paid should debit wallet.
      if (newStatus === 'paid') {
        payoutRepo.setPayoutRequestStatus(payout.id, 'paid', { reviewedBy: 'webhook', reference: event.reference || null });
        if (before !== 'paid') payoutRepo.adjustWallet(payout.driverId, { availableCents: -payout.amountCents });
      } else if (newStatus === 'rejected') {
        payoutRepo.setPayoutRequestStatus(payout.id, 'rejected', { reviewedBy: 'webhook', reference: event.reference || null });
      } else if (newStatus === 'approved') {
        payoutRepo.setPayoutRequestStatus(payout.id, 'approved', { reviewedBy: 'webhook', reference: event.reference || null });
      }
    }

    return res.json({ received: true, payoutId: payout.id, status: newStatus || payout.status });
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
  app.use('/api/admin', adminRoutesFactory({ notify }));
  app.use('/api/sos', sosRoutesFactory({ notify }));
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