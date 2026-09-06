const http = require('http');
const express = require('express');
const cors = require('cors');
const config = require('./config');
const authRoutes = require('./routes/auth');
const driverRoutesFactory = require('./routes/driver');
const customerRoutesFactory = require('./routes/customer');
const paymentsRoutes = require('./routes/payments');
const pushRoutes = require('./routes/push');
const { initSocket } = require('./socket');
const { notFound, errorHandler } = require('./middleware');

const app = express();
app.use(cors({ origin: config.corsOrigins, credentials: true }));

// Yoco webhook needs the raw request body for signature verification.
const paymentsService = require('./services/payments');
let socketCtx = null; // filled by initSocket below; the handler runs after startup
app.post('/api/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const notify = socketCtx ? socketCtx.notify : null;
    const result = await paymentsService.handleWebhook(req, notify);
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ error: e.message });
  }
});

app.use(express.json());

// Simple request log in dev.
if (config.nodeEnv !== 'production') {
  app.use((req, _res, next) => {
    console.log(`${req.method} ${req.path}`);
    next();
  });
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'drivelocal-backend', currency: config.currency, time: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/payments', paymentsRoutes);

const server = http.createServer(app);
const { io, notify } = initSocket(server, config.corsOrigins);
socketCtx = { io, notify };

app.use('/api/driver', driverRoutesFactory({ notify }));
app.use('/api/customer', customerRoutesFactory({ notify }));

app.use(notFound);
app.use(errorHandler);

server.listen(config.port, () => {
  console.log(`DriveLocal backend listening on http://localhost:${config.port}`);
  console.log(`Currency: ${config.currency.toUpperCase()} | DB driver: ${config.dbDriver}`);
});
