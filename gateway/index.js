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
const { generalLimiter } = require('./middleware/rateLimiter');
const proxyRoutes = require('./routes/proxy.routes');
const logger = require('../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_GATEWAY || 3000;

// ── Security & middleware ─────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  credentials: true,
}));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10kb' }));
app.use(generalLimiter);

// ── Health check ─────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ success: true, message: 'API Gateway is running', timestamp: new Date().toISOString() });
});

// ── Proxy routes ─────────────────────────────────────────────────
app.use(proxyRoutes);

// ── 404 ──────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Route not found', errorCode: 'ROUTE_NOT_FOUND' });
});

// ── Global error handler ──────────────────────────────────────────
// Catches PayloadTooLargeError (413), SyntaxError from bad JSON, and any
// other errors thrown by middleware — prevents Express from leaking stack traces.
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

app.listen(PORT, () => {
  logger.info(`API Gateway running on port ${PORT}`);
});

module.exports = app;
