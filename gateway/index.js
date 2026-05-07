require('dotenv').config();
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
app.use(morgan('dev'));
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
  res.status(404).json({ success: false, message: 'Route not found' });
});

app.listen(PORT, () => {
  logger.info(`API Gateway running on port ${PORT}`);
});

module.exports = app;
