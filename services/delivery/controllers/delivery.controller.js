require('dotenv').config();
const { z } = require('zod');
const axios = require('axios');
const Rider = require('../../user/models/Rider.model');
const RiderLocation = require('../models/RiderLocation.model');
const DeliveryJob = require('../models/DeliveryJob.model');
const { DELIVERY_JOB_STATUS } = require('../models/DeliveryJob.model');
const { handleRiderAccept, handleRiderReject } = require('../logic/riderAssigner');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const { triggerNotification } = require('../../../shared/utils/notify');
const logger = require('../../../shared/utils/logger');

// ── PATCH /rider/status ───────────────────────────────────────────
// Rider toggles their online/offline availability.
const toggleStatusSchema = z.object({ isOnline: z.boolean() });

const toggleStatus = async (req, res) => {
  try {
    const parsed = toggleStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'isOnline (boolean) is required', ERROR_CODES.MISSING_FIELDS);
    }
    const { isOnline } = parsed.data;

    const rider = await Rider.findByIdAndUpdate(
      req.user.id,
      { isOnline: parsed.data.isOnline },
      { new: true, select: 'isOnline isOnDelivery name phone vehicleType' },
    );
    if (!rider) return sendError(res, 404, 'Rider not found', ERROR_CODES.NOT_FOUND);

    return sendSuccess(res, 200, `Rider is now ${isOnline ? 'online' : 'offline'}`, rider);
  } catch (err) {
    logger.error('toggleStatus error:', err);
    return sendError(res, 500, 'Failed to update status', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /rider/orders ─────────────────────────────────────────────
// Rider: active jobs (accepted / picked) and pending offers.
const getRiderJobs = async (req, res) => {
  try {
    const [active, offered] = await Promise.all([
      DeliveryJob.find({
        riderId: req.user.id,
        status: { $in: [DELIVERY_JOB_STATUS.ACCEPTED, DELIVERY_JOB_STATUS.PICKED] },
      })
        .sort({ createdAt: -1 })
        .lean(),

      DeliveryJob.find({
        offeredRiderIds: req.user.id,
        status: DELIVERY_JOB_STATUS.OFFERED,
        offerExpiresAt: { $gt: new Date() }, // Only show offers still within window
      })
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    return sendSuccess(res, 200, 'Jobs fetched', { active, offered });
  } catch (err) {
    logger.error('getRiderJobs error:', err);
    return sendError(res, 500, 'Failed to fetch jobs', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /rider/accept/:jobId ────────────────────────────────────
// Accept a delivery job within the 30s window.
const acceptJob = async (req, res) => {
  try {
    const result = await handleRiderAccept(req.params.jobId, req.user.id);
    if (!result.success) {
      return sendError(res, 400, result.reason, ERROR_CODES.VALIDATION_ERROR);
    }

    return sendSuccess(res, 200, 'Job accepted', {
      jobId:          req.params.jobId,
      pickupLocation: result.job.pickupLocation,
      dropLocation:   result.job.dropLocation,
      earnings:       result.job.riderEarnings,
    });
  } catch (err) {
    logger.error('acceptJob error:', err);
    return sendError(res, 500, 'Failed to accept job', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /rider/reject/:jobId ────────────────────────────────────
// Explicitly reject an offered job (optional — expiry handles it too).
const rejectJob = async (req, res) => {
  try {
    const result = await handleRiderReject(req.params.jobId, req.user.id);
    if (!result.success) {
      return sendError(res, 400, result.reason, ERROR_CODES.VALIDATION_ERROR);
    }

    return sendSuccess(res, 200, 'Job rejected');
  } catch (err) {
    logger.error('rejectJob error:', err);
    return sendError(res, 500, 'Failed to reject job', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /rider/pickup/:jobId ────────────────────────────────────
// Rider marks that they have picked up the order from the vendor.
const markPickedUp = async (req, res) => {
  try {
    const job = await DeliveryJob.findOne({ _id: req.params.jobId, riderId: req.user.id });
    if (!job) return sendError(res, 404, 'Job not found', ERROR_CODES.NOT_FOUND);
    if (job.status !== DELIVERY_JOB_STATUS.ACCEPTED) {
      return sendError(res, 400, 'Job must be in accepted state to mark pickup', ERROR_CODES.VALIDATION_ERROR);
    }

    job.status = DELIVERY_JOB_STATUS.PICKED;
    job.pickedAt = new Date();
    await job.save();

    // Sync Order Service (non-fatal)
    syncOrderService(job, 'picked', { pickedAt: job.pickedAt });

    // Notify customer via socket + FCM push
    emitOrderStatus(job, 'picked');
    triggerNotification('order:picked', job.customerId.toString(), 'customer', {
      orderId: job.orderId.toString(),
    });

    return sendSuccess(res, 200, 'Marked as picked up', { jobId: job._id });
  } catch (err) {
    logger.error('markPickedUp error:', err);
    return sendError(res, 500, 'Failed to mark pickup', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /rider/deliver/:jobId ───────────────────────────────────
// Rider marks the order as delivered to the customer.
const markDelivered = async (req, res) => {
  try {
    const job = await DeliveryJob.findOne({ _id: req.params.jobId, riderId: req.user.id });
    if (!job) return sendError(res, 404, 'Job not found', ERROR_CODES.NOT_FOUND);
    if (job.status !== DELIVERY_JOB_STATUS.PICKED) {
      return sendError(res, 400, 'Order must be picked up before marking delivered', ERROR_CODES.VALIDATION_ERROR);
    }

    job.status = DELIVERY_JOB_STATUS.DELIVERED;
    job.deliveredAt = new Date();
    await job.save();

    // Mark rider as available again
    await Rider.findByIdAndUpdate(req.user.id, {
      isOnDelivery: false,
      $inc: {
        'earnings.today':    job.riderEarnings,
        'earnings.thisWeek': job.riderEarnings,
        'earnings.total':    job.riderEarnings,
      },
    });

    // Sync Order Service (non-fatal)
    syncOrderService(job, 'delivered', { deliveredAt: job.deliveredAt });

    // Notify customer via socket + FCM push
    emitOrderStatus(job, 'delivered');
    triggerNotification('order:delivered', job.customerId.toString(), 'customer', {
      orderId: job.orderId.toString(),
    });

    return sendSuccess(res, 200, 'Delivery marked complete', {
      jobId:    job._id,
      earnings: job.riderEarnings,
    });
  } catch (err) {
    logger.error('markDelivered error:', err);
    return sendError(res, 500, 'Failed to mark delivery', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /rider/location ──────────────────────────────────────────
// Rider sends location every 5s via HTTP (REST fallback / polling mode).
// The Socket.io path also calls /internal/location-update directly.
const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

const updateLocation = async (req, res) => {
  try {
    const parsed = locationSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Valid lat and lng are required', ERROR_CODES.MISSING_FIELDS);
    }
    const { lat, lng } = parsed.data;

    const riderId = req.user.id;
    const coordinates = [lng, lat]; // already numbers, validated by Zod

    await Promise.all([
      // Upsert RiderLocation (high-frequency write)
      RiderLocation.findOneAndUpdate(
        { riderId },
        { riderId, location: { type: 'Point', coordinates } },
        { upsert: true, new: true, timestamps: true },
      ),
      // Keep Rider.currentLocation in sync for geo queries (nearby finder)
      Rider.findByIdAndUpdate(riderId, {
        currentLocation: { type: 'Point', coordinates },
      }),
    ]);

    // Broadcast to customer tracking any active delivery by this rider
    const activeJob = await DeliveryJob.findOne({
      riderId,
      status: { $in: [DELIVERY_JOB_STATUS.ACCEPTED, DELIVERY_JOB_STATUS.PICKED] },
    })
      .select('orderId customerId')
      .lean();

    if (activeJob) {
      axios
        .post(
          `http://localhost:${process.env.PORT_SOCKET || 3010}/internal/emit`,
          {
            room:    `order:tracking:${activeJob.orderId}`,
            event:   'rider:location',
            payload: { lat, lng, riderId, orderId: activeJob.orderId },
          },
          { timeout: 3000 },
        )
        .catch(() => {}); // Non-fatal
    }

    return sendSuccess(res, 200, 'Location updated');
  } catch (err) {
    logger.error('updateLocation error:', err);
    return sendError(res, 500, 'Failed to update location', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /rider/earnings ───────────────────────────────────────────
const getRiderEarnings = async (req, res) => {
  try {
    const rider = await Rider.findById(req.user.id).select('name earnings rating').lean();
    if (!rider) return sendError(res, 404, 'Rider not found', ERROR_CODES.NOT_FOUND);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [totalJobs, todayJobs] = await Promise.all([
      DeliveryJob.countDocuments({ riderId: req.user.id, status: DELIVERY_JOB_STATUS.DELIVERED }),
      DeliveryJob.countDocuments({
        riderId: req.user.id,
        status: DELIVERY_JOB_STATUS.DELIVERED,
        deliveredAt: { $gte: todayStart },
      }),
    ]);

    return sendSuccess(res, 200, 'Earnings fetched', {
      earnings:         rider.earnings,
      rating:           rider.rating,
      totalDeliveries:  totalJobs,
      todayDeliveries:  todayJobs,
    });
  } catch (err) {
    logger.error('getRiderEarnings error:', err);
    return sendError(res, 500, 'Failed to fetch earnings', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── Helpers ───────────────────────────────────────────────────────

const syncOrderService = (job, status, extra = {}) => {
  axios
    .post(
      `http://localhost:${process.env.PORT_ORDER || 3004}/internal/update-suborder`,
      {
        orderId:    job.orderId.toString(),
        subOrderId: job.subOrderId.toString(),
        update:     { status, ...extra },
      },
      { timeout: 5000 },
    )
    .catch((err) => logger.warn(`syncOrderService(${status}) failed: ${err.message}`));
};

const emitOrderStatus = (job, status) => {
  axios
    .post(
      `http://localhost:${process.env.PORT_SOCKET || 3010}/internal/emit`,
      {
        room:    `customer:${job.customerId}`,
        event:   'order:status',
        payload: { orderId: job.orderId, subOrderId: job.subOrderId, status },
      },
      { timeout: 3000 },
    )
    .catch((err) => logger.warn(`emitOrderStatus(${status}) failed: ${err.message}`));
};

module.exports = {
  toggleStatus,
  getRiderJobs,
  acceptJob,
  rejectJob,
  markPickedUp,
  markDelivered,
  updateLocation,
  getRiderEarnings,
};
