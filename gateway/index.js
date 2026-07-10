require('dotenv').config();

process.on('unhandledRejection', (reason) => {
  require('../shared/utils/logger').error('Unhandled rejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  require('../shared/utils/logger').error('Uncaught exception:', err);
  process.exit(1);
});

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const logger = require('../shared/utils/logger');
const { connectRedis } = require('../shared/db/redis');

const app = express();
const PORT = process.env.PORT_GATEWAY || 3000;

// Behind a reverse proxy / load balancer, req.ip must come from X-Forwarded-For,
// otherwise every client looks like the proxy's IP and shares one rate-limit
// bucket. TRUST_PROXY = number of proxy hops (default 1 in prod). Set to 0 to
// disable (direct exposure) or a higher number for chained proxies.
const trustProxy = process.env.TRUST_PROXY !== undefined
  ? Number(process.env.TRUST_PROXY)
  : (process.env.NODE_ENV === 'production' ? 1 : 0);
app.set('trust proxy', trustProxy);

(async () => {
  // ── 1. Connect Redis before requiring rate limiter ────────────────
  // rateLimiter.js reads redisClient.isReady at require-time to decide
  // whether to use a Redis store or fall back to in-memory.
  try {
    await connectRedis();
    logger.info('Redis connected — rate limiter will use Redis store');
  } catch (err) {
    logger.warn(`Redis unavailable (${err.message}) — rate limiter falling back to in-memory store`);
  }

  // authLimiter is applied inside proxy.routes (on /api/auth), not here.
  const { generalLimiter } = require('./middleware/rateLimiter');

  // ── 2. Global middleware ──────────────────────────────────────────
  app.use(helmet());
  app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    credentials: true,
  }));
  app.use(compression());
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
  // NOTE: No express.json() here — the gateway only proxies requests.
  // Parsing the body here would consume the stream before http-proxy-middleware
  // can pipe it to the upstream service, causing the proxy to hang.
  app.use(generalLimiter);

  // ── 3. Health check ───────────────────────────────────────────────
  app.get('/health', (_req, res) => {
    res.json({ success: true, message: 'API Gateway is running', timestamp: new Date().toISOString() });
  });

  // ── 4. Proxy routes ───────────────────────────────────────────────
  app.use(require('./routes/proxy.routes'));

  // ── 5. 404 ───────────────────────────────────────────────────────
  app.use((_req, res) => {
    res.status(404).json({ success: false, message: 'Route not found', errorCode: 'ROUTE_NOT_FOUND' });
  });

  // ── 6. Global error handler ───────────────────────────────────────
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ success: false, message: 'Request body too large', errorCode: 'PAYLOAD_TOO_LARGE' });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ success: false, message: 'Invalid JSON body', errorCode: 'VALIDATION_ERROR' });
    }
    logger.error('Gateway unhandled error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error', errorCode: 'INTERNAL_ERROR' });
  });

  // ── 7. Start server ───────────────────────────────────────────────
  app.listen(PORT, () => {
    logger.info(`API Gateway running on port ${PORT}`);
  });
})();

module.exports = app;
