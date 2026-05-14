require('dotenv').config();

process.on('unhandledRejection', (reason) => {
  require('../../shared/utils/logger').error('Unhandled rejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  if (err.type === 'request.aborted' || err.message === 'request aborted') return;
  require('../../shared/utils/logger').error('Uncaught exception:', err);
  process.exit(1);
});
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('../../shared/db/mongoose');
const adminRoutes = require('./routes/admin.routes');
const logger = require('../../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_ADMIN || 3009;

app.use(helmet());
app.use(cors());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'admin', timestamp: new Date().toISOString() });
});

// Public banner endpoint (no auth) — must be before admin routes
const Banner = require('./models/Banner.model');
const { sendSuccess, sendError } = require('../../shared/utils/response.util');
app.get('/api/banners', async (_req, res) => {
  try {
    const banners = await Banner.find({ isActive: true }).sort({ position: 1, createdAt: 1 }).lean();
    return sendSuccess(res, 200, 'Banners fetched', banners);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch banners', 'INTERNAL_ERROR');
  }
});

// Public endpoint: active deal of the day (no auth required)
app.get('/api/deal-of-day', async (_req, res) => {
  try {
    const DealOfDay = require('./models/DealOfDay.model');
    const deal = await DealOfDay.findOne({ isActive: true }).sort({ updatedAt: -1 }).lean();
    return sendSuccess(res, 200, 'Active deal', deal);
  } catch (err) {
    return sendError(res, 500, 'Failed to fetch deal', 'INTERNAL_ERROR');
  }
});

app.use('/', adminRoutes);

app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found', errorCode: 'NOT_FOUND' }));

app.use((err, _req, res, _next) => {
  logger.error('Unhandled admin service error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

connectDB().then(() => {
  app.listen(PORT, () => logger.info(`Admin Service running on port ${PORT}`));
});

module.exports = app;
