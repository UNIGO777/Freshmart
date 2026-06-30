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
const cron = require('node-cron');
const connectDB = require('../../shared/db/mongoose');
const { connectRedis } = require('../../shared/db/redis');
const deliveryRoutes = require('./routes/delivery.routes');
const RiderLocation = require('./models/RiderLocation.model');
const Rider = require('../user/models/Rider.model');
const { initiateRiderAssignment, sweepExpiredOffers } = require('./logic/riderAssigner');
const { authenticate } = require('../../gateway/middleware/auth.middleware');
const logger = require('../../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_DELIVERY || 3006;

app.use(helmet());
app.use(cors());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10kb' }));

// ── Health ────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'delivery', timestamp: new Date().toISOString() });
});

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
    const { orderId, subOrderId, vendorId, customerId, pickupLocation, dropLocation, deliveryFee, deliveryInstructions } = req.body;

    if (!orderId || !subOrderId || !pickupLocation || !dropLocation) {
      return res.status(400).json({ success: false, message: 'orderId, subOrderId, pickupLocation, dropLocation required' });
    }

    // Fire-and-forget — caller does not wait for rider assignment to complete
    initiateRiderAssignment({
      orderId, subOrderId, vendorId, customerId,
      pickupLocation, dropLocation,
      deliveryFee: deliveryFee || 0,
      deliveryInstructions: deliveryInstructions || '',
    }).catch((err) => logger.error(`assign-rider failed for order ${orderId}:`, err));

    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/assign-rider error:', err);
    return res.status(500).json({ success: false });
  }
});

// ── Internal: rider disconnect (auto-offline + close session) ────
// Called by Socket Server when a rider's socket disconnects.
const RiderSession = require('./models/RiderSession.model');
const DeliveryJob = require('./models/DeliveryJob.model');
const DeliveryOtp = require('./models/DeliveryOtp.model');

app.post('/internal/rider-disconnect', async (req, res) => {
  try {
    const { riderId } = req.body;
    if (!riderId) return res.status(400).json({ success: false, message: 'riderId required' });

    // Skip if rider has an active delivery — they should stay online/trackable
    const activeJob = await DeliveryJob.findOne({
      riderId,
      status: { $in: ['accepted', 'picked'] },
    });
    if (activeJob) {
      return res.json({ success: true, skipped: true, reason: 'rider has active delivery' });
    }

    // Set rider offline
    await Rider.findByIdAndUpdate(riderId, { isOnline: false });

    // Close any open session
    const openSession = await RiderSession.findOne({ riderId, endedAt: null }).sort({ startedAt: -1 });
    if (openSession) {
      openSession.endedAt = new Date();
      openSession.durationMinutes = Math.round((openSession.endedAt - openSession.startedAt) / 60000);
      await openSession.save();
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/rider-disconnect error:', err);
    return res.status(500).json({ success: false });
  }
});

// ── Internal: cancel delivery jobs for an order (called by Order Service) ─
app.post('/internal/cancel-jobs', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId required' });

    const jobs = await DeliveryJob.find({
      orderId,
      status: { $in: ['pending', 'offered', 'accepted'] },
    });

    for (const job of jobs) {
      // Free the rider if one was assigned
      if (job.riderId) {
        await Rider.findByIdAndUpdate(job.riderId, { isOnDelivery: false });
      }
      job.status = 'cancelled';
      await job.save();

      // Clean up any active OTPs for this job
      await DeliveryOtp.deleteMany({ jobId: job._id }).catch(() => {});
    }

    logger.info(`Cancelled ${jobs.length} delivery job(s) for order ${orderId}`);
    return res.json({ success: true, cancelledCount: jobs.length });
  } catch (err) {
    logger.error('internal/cancel-jobs error:', err);
    return res.status(500).json({ success: false });
  }
});

// ── Authenticated rider routes ───────────────────────────────────
app.use('/', authenticate, deliveryRoutes);

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

    // Reset earnings.today for all riders at midnight every day (IST = UTC+5:30)
    // Cron: 30 18 * * *  →  00:00 IST
    cron.schedule('30 18 * * *', async () => {
      try {
        const result = await Rider.updateMany({}, { $set: { 'earnings.today': 0 } });
        logger.info(`[cron] Reset earnings.today for ${result.modifiedCount} riders`);
      } catch (err) {
        logger.error('[cron] Reset earnings.today failed:', err);
      }
    });

    // Reset earnings.thisWeek for all riders every Monday midnight IST
    // Cron: 30 18 * * 0  →  00:00 IST on Sunday (UTC Sun = IST Mon)
    cron.schedule('30 18 * * 0', async () => {
      try {
        const result = await Rider.updateMany({}, { $set: { 'earnings.thisWeek': 0 } });
        logger.info(`[cron] Reset earnings.thisWeek for ${result.modifiedCount} riders`);
      } catch (err) {
        logger.error('[cron] Reset earnings.thisWeek failed:', err);
      }
    });
  });
});

module.exports = app;
