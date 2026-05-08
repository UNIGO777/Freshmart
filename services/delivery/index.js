require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('../../shared/db/mongoose');
const { connectRedis } = require('../../shared/db/redis');
const deliveryRoutes = require('./routes/delivery.routes');
const RiderLocation = require('./models/RiderLocation.model');
const Rider = require('../user/models/Rider.model');
const { initiateRiderAssignment, sweepExpiredOffers } = require('./logic/riderAssigner');
const logger = require('../../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_DELIVERY || 3006;

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'delivery', timestamp: new Date().toISOString() });
});

// ── Public routes (through gateway auth) ─────────────────────────
app.use('/', deliveryRoutes);

// ── Internal: location ping from Socket Server ────────────────────
// POST /internal/location-update  { riderId, lat, lng, orderId? }
// Called by the Socket Server's riderLocation handler to persist location
// without introducing a circular socket dependency.
app.post('/internal/location-update', async (req, res) => {
  try {
    const { riderId, lat, lng } = req.body;
    if (!riderId || lat == null || lng == null) {
      return res.status(400).json({ success: false, message: 'riderId, lat, lng required' });
    }

    const coordinates = [parseFloat(lng), parseFloat(lat)];

    await Promise.all([
      RiderLocation.findOneAndUpdate(
        { riderId },
        { riderId, location: { type: 'Point', coordinates } },
        { upsert: true, timestamps: true },
      ),
      Rider.findByIdAndUpdate(riderId, {
        currentLocation: { type: 'Point', coordinates },
      }),
    ]);

    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/location-update error:', err);
    return res.status(500).json({ success: false });
  }
});

// ── Internal: trigger rider assignment after sub-orders are built ─
// POST /internal/assign-rider
// Called by Order Service once vendor acceptance is complete.
// Body: { orderId, subOrderId, vendorId, customerId, pickupLocation, dropLocation, deliveryFee }
app.post('/internal/assign-rider', async (req, res) => {
  try {
    const { orderId, subOrderId, vendorId, customerId, pickupLocation, dropLocation, deliveryFee } = req.body;

    if (!orderId || !subOrderId || !pickupLocation || !dropLocation) {
      return res.status(400).json({ success: false, message: 'orderId, subOrderId, pickupLocation, dropLocation required' });
    }

    // Fire-and-forget — caller does not wait for rider assignment to complete
    initiateRiderAssignment({
      orderId, subOrderId, vendorId, customerId,
      pickupLocation, dropLocation,
      deliveryFee: deliveryFee || 30,
    }).catch((err) => logger.error(`assign-rider failed for order ${orderId}:`, err));

    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/assign-rider error:', err);
    return res.status(500).json({ success: false });
  }
});

// ── Global error handler ──────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found', errorCode: 'NOT_FOUND' }));

app.use((err, _req, res, _next) => {
  logger.error('Unhandled delivery service error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ── Bootstrap ─────────────────────────────────────────────────────
Promise.all([connectDB(), connectRedis()]).then(() => {
  app.listen(PORT, () => {
    logger.info(`Delivery Service running on port ${PORT}`);

    // Background sweep: cascade expired 30s offer windows every 15 seconds.
    // This catches cases where riders simply ignore the job:request notification.
    setInterval(() => {
      sweepExpiredOffers().catch((err) =>
        logger.error('sweepExpiredOffers error:', err),
      );
    }, 15_000);
  });
});

module.exports = app;
