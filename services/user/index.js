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
const userRoutes = require('./routes/user.routes');
const supportRoutes = require('./routes/support.routes');
const { authenticate } = require('../../gateway/middleware/auth.middleware');
const logger = require('../../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_USER || 3002;

app.use(helmet());
app.use(cors());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'user', timestamp: new Date().toISOString() });
});

// Public route — no auth needed (checked before app opens fully)
const { checkServiceability } = require('./controllers/user.controller');
app.get('/check-serviceability', checkServiceability);

// Internal endpoint — called by Socket Service when a vendor disconnects (no JWT, uses shared secret)
const Vendor = require('./models/Vendor.model');
app.patch('/set-offline', async (req, res) => {
  const secret = req.headers['x-internal-secret'];
  if (secret !== (process.env.INTERNAL_SECRET || 'internal')) {
    return res.status(403).json({ success: false, message: 'Forbidden' });
  }
  const { vendorId } = req.body;
  if (!vendorId) return res.status(400).json({ success: false, message: 'vendorId required' });
  try {
    const vendor = await Vendor.findOneAndUpdate(
      { _id: vendorId, isOnline: true },
      { isOnline: false },
      { new: true },
    );
    // Notify customers so product lists update in real time
    if (vendor) {
      const SOCKET_URL = process.env.SOCKET_URL || 'http://localhost:3010';
      const axios = require('axios');
      axios.post(`${SOCKET_URL}/internal/emit`, {
        room: 'serviceability:broadcast',
        event: 'vendor:availability',
        payload: {
          vendorId: vendor._id,
          isOnline: false,
          location: vendor.location,
          serviceRadiusKm: vendor.serviceRadiusKm,
          categories: vendor.categories,
        },
      }, { timeout: 3000 }).catch(() => {});
    }
    return res.json({ success: true });
  } catch (err) {
    logger.error('set-offline error:', err);
    return res.status(500).json({ success: false, message: 'Failed' });
  }
});

// All user routes require a valid JWT — the gateway forwards the Authorization header
app.use('/', authenticate, userRoutes);

// Support routes — gateway strips /api/support prefix, so paths arrive as /queries, /queries/:id/reply etc.
// Mounted at root so /queries routes are reachable directly.
app.use('/', supportRoutes);

app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found', errorCode: 'NOT_FOUND' }));

app.use((err, _req, res, _next) => {
  logger.error('Unhandled user service error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

connectDB().then(() => {
  app.listen(PORT, () => logger.info(`User Service running on port ${PORT}`));
});

module.exports = app;
