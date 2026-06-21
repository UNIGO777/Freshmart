require('dotenv').config();
const { z } = require('zod');
const axios = require('axios');
const Rider = require('../../user/models/Rider.model');
const RiderLocation = require('../models/RiderLocation.model');
const RiderWallet = require('../models/RiderWallet.model');
const WalletTransaction = require('../models/WalletTransaction.model');
const RiderSession = require('../models/RiderSession.model');
const DeliveryJob = require('../models/DeliveryJob.model');
const { DELIVERY_JOB_STATUS } = require('../models/DeliveryJob.model');
const DeliveryRateConfig = require('../../admin/models/DeliveryRateConfig.model');
const { handleRiderAccept, handleRiderReject } = require('../logic/riderAssigner');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const { triggerNotification } = require('../../../shared/utils/notify');
const { notifyAdmin } = require('../../../shared/utils/notifyAdmin');
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
    const riderId = req.user.id;

    const rider = await Rider.findByIdAndUpdate(
      riderId,
      { isOnline },
      { new: true, select: 'isOnline isOnDelivery name phone vehicleType' },
    );
    if (!rider) return sendError(res, 404, 'Rider not found', ERROR_CODES.NOT_FOUND);

    // Track online sessions
    if (isOnline) {
      // Going online — create a new session
      await RiderSession.create({ riderId, startedAt: new Date() });
    } else {
      // Going offline — close the most recent open session
      const openSession = await RiderSession.findOne({ riderId, endedAt: null }).sort({ startedAt: -1 });
      if (openSession) {
        openSession.endedAt = new Date();
        openSession.durationMinutes = Math.round((openSession.endedAt - openSession.startedAt) / 60000);
        await openSession.save();
      }
    }

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

    const riderId = req.user.id;

    // Mark rider as available + update earnings counters + performance
    const riderDoc = await Rider.findByIdAndUpdate(riderId, {
      isOnDelivery: false,
      $inc: {
        'earnings.today':              job.riderEarnings,
        'earnings.thisWeek':           job.riderEarnings,
        'earnings.total':              job.riderEarnings,
        'performance.totalCompleted':  1,
      },
    }, { new: true, select: 'performance' });

    // Recalculate completion rate and on-time rate
    if (riderDoc?.performance) {
      const p = riderDoc.performance;
      const updates = {};
      if (p.totalAccepted > 0) {
        updates['performance.completionRate'] = Math.round((p.totalCompleted / p.totalAccepted) * 100);
      }
      // On-time: delivered within 45 minutes of assignment
      if (job.assignedAt && job.deliveredAt) {
        const deliveryMins = (job.deliveredAt - job.assignedAt) / 60000;
        const isOnTime = deliveryMins <= 45;
        // Incremental on-time calculation: track via completed count
        // Simple approach: if on-time, rate stays same or goes up
        if (isOnTime && p.totalCompleted > 0) {
          // Weighted update: onTimeRate = ((prevRate * (completed-1)) + 100) / completed
          updates['performance.onTimeRate'] = Math.round(
            ((p.onTimeRate * (p.totalCompleted - 1)) + 100) / p.totalCompleted,
          );
        } else if (p.totalCompleted > 0) {
          updates['performance.onTimeRate'] = Math.round(
            ((p.onTimeRate * (p.totalCompleted - 1)) + 0) / p.totalCompleted,
          );
        }
      }
      if (Object.keys(updates).length > 0) {
        await Rider.findByIdAndUpdate(riderId, updates);
      }
    }

    // Credit rider wallet
    const wallet = await RiderWallet.findOneAndUpdate(
      { riderId },
      {
        $inc: { balance: job.riderEarnings, totalEarned: job.riderEarnings },
        $setOnInsert: { riderId },
      },
      { upsert: true, new: true },
    );

    // Create wallet transaction
    await WalletTransaction.create({
      riderId,
      type: 'earning',
      amount: job.riderEarnings,
      balanceAfter: wallet.balance,
      jobId: job._id,
      description: `Delivery #${job._id.toString().slice(-6).toUpperCase()} — ${job.distanceKm} km × ₹${job.ratePerKm}/km${job.surgeMultiplier > 1 ? ` × ${job.surgeMultiplier}x surge` : ''}`,
      status: 'completed',
    });

    // Emit wallet update to rider via socket
    emitToRiderSocket(riderId, 'wallet:updated', {
      balance: wallet.balance,
      earned: job.riderEarnings,
      jobId: job._id,
    });

    // Sync Order Service (non-fatal)
    syncOrderService(job, 'delivered', { deliveredAt: job.deliveredAt });

    // Notify customer via socket + FCM push
    emitOrderStatus(job, 'delivered');
    triggerNotification('order:delivered', job.customerId.toString(), 'customer', {
      orderId: job.orderId.toString(),
    });

    notifyAdmin(
      'order_delivered',
      `Order Delivered — ₹${job.riderEarnings ?? 0}`,
      `Order #${job.orderId.toString().slice(-6).toUpperCase()} delivered successfully`,
      { jobId: job._id.toString(), orderId: job.orderId.toString() },
    );

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

const emitToRiderSocket = (riderId, event, payload) => {
  axios
    .post(
      `http://localhost:${process.env.PORT_SOCKET || 3010}/internal/emit`,
      { room: `rider:${riderId}`, event, payload },
      { timeout: 3000 },
    )
    .catch((err) => logger.warn(`emitToRiderSocket(${event}) failed: ${err.message}`));
};

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

// ── GET /rider/wallet ─────────────────────────────────────────────
const getRiderWallet = async (req, res) => {
  try {
    const riderId = req.user.id;
    let wallet = await RiderWallet.findOne({ riderId }).lean();
    if (!wallet) {
      wallet = await RiderWallet.create({ riderId });
      wallet = wallet.toObject();
    }

    const recentTransactions = await WalletTransaction.find({ riderId })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    return sendSuccess(res, 200, 'Wallet fetched', { wallet, recentTransactions });
  } catch (err) {
    logger.error('getRiderWallet error:', err);
    return sendError(res, 500, 'Failed to fetch wallet', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /rider/wallet/transactions ───────────────────────────────
const getWalletTransactions = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { type, page = 1, limit = 20 } = req.query;

    const filter = { riderId };
    if (type && ['earning', 'withdrawal', 'deduction'].includes(type)) {
      filter.type = type;
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [transactions, total] = await Promise.all([
      WalletTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      WalletTransaction.countDocuments(filter),
    ]);

    return sendSuccess(res, 200, 'Transactions fetched', {
      transactions,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) {
    logger.error('getWalletTransactions error:', err);
    return sendError(res, 500, 'Failed to fetch transactions', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /rider/wallet/withdrawals ────────────────────────────────
const getWalletWithdrawals = async (req, res) => {
  try {
    const riderId = req.user.id;
    const { page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const filter = { riderId, type: { $in: ['withdrawal', 'deduction'] } };
    const [transactions, total] = await Promise.all([
      WalletTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      WalletTransaction.countDocuments(filter),
    ]);

    return sendSuccess(res, 200, 'Withdrawals fetched', {
      transactions,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) {
    logger.error('getWalletWithdrawals error:', err);
    return sendError(res, 500, 'Failed to fetch withdrawals', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /rider/earnings/daily ────────────────────────────────────
const getDailyEarnings = async (req, res) => {
  try {
    const riderId = req.user.id;
    const days = parseInt(req.query.days) || 7;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const dailyData = await DeliveryJob.aggregate([
      {
        $match: {
          riderId: new (require('mongoose').Types.ObjectId)(riderId),
          status: DELIVERY_JOB_STATUS.DELIVERED,
          deliveredAt: { $gte: startDate },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$deliveredAt' },
          },
          totalEarnings: { $sum: '$riderEarnings' },
          baseEarnings: {
            $sum: {
              $multiply: ['$distanceKm', '$ratePerKm'],
            },
          },
          surgeEarnings: {
            $sum: {
              $subtract: [
                '$riderEarnings',
                { $multiply: ['$distanceKm', '$ratePerKm'] },
              ],
            },
          },
          deliveryCount: { $sum: 1 },
          totalDistanceKm: { $sum: '$distanceKm' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return sendSuccess(res, 200, 'Daily earnings fetched', { dailyData, days });
  } catch (err) {
    logger.error('getDailyEarnings error:', err);
    return sendError(res, 500, 'Failed to fetch daily earnings', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /rider/performance ───────────────────────────────────────
const getRiderPerformance = async (req, res) => {
  try {
    const rider = await Rider.findById(req.user.id)
      .select('performance rating')
      .lean();
    if (!rider) return sendError(res, 404, 'Rider not found', ERROR_CODES.NOT_FOUND);

    return sendSuccess(res, 200, 'Performance fetched', {
      ...rider.performance,
      rating: rider.rating?.average ?? 0,
      ratingCount: rider.rating?.count ?? 0,
    });
  } catch (err) {
    logger.error('getRiderPerformance error:', err);
    return sendError(res, 500, 'Failed to fetch performance', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /rider/surge-status ──────────────────────────────────────
const getSurgeStatus = async (req, res) => {
  try {
    const config = await DeliveryRateConfig.getConfig();
    return sendSuccess(res, 200, 'Surge status fetched', {
      surgeActive: config.surgeActive,
      surgeMultiplier: config.surgeMultiplier,
      surgeReason: config.surgeReason,
      ratePerKm: config.ratePerKm,
    });
  } catch (err) {
    logger.error('getSurgeStatus error:', err);
    return sendError(res, 500, 'Failed to fetch surge status', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /rider/online-hours ──────────────────────────────────────
const getOnlineHours = async (req, res) => {
  try {
    const riderId = req.user.id;

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Sunday
    weekStart.setHours(0, 0, 0, 0);

    const [todaySessions, weekSessions, currentSession] = await Promise.all([
      RiderSession.aggregate([
        { $match: { riderId: new (require('mongoose').Types.ObjectId)(riderId), startedAt: { $gte: todayStart }, endedAt: { $ne: null } } },
        { $group: { _id: null, totalMinutes: { $sum: '$durationMinutes' } } },
      ]),
      RiderSession.aggregate([
        { $match: { riderId: new (require('mongoose').Types.ObjectId)(riderId), startedAt: { $gte: weekStart }, endedAt: { $ne: null } } },
        { $group: { _id: null, totalMinutes: { $sum: '$durationMinutes' } } },
      ]),
      RiderSession.findOne({ riderId, endedAt: null }).sort({ startedAt: -1 }).lean(),
    ]);

    // If currently online, add current session duration to today's total
    let currentSessionMinutes = 0;
    if (currentSession) {
      currentSessionMinutes = Math.round((Date.now() - currentSession.startedAt.getTime()) / 60000);
    }

    const todayMinutes = (todaySessions[0]?.totalMinutes ?? 0) + currentSessionMinutes;
    const weekMinutes = (weekSessions[0]?.totalMinutes ?? 0) + currentSessionMinutes;

    return sendSuccess(res, 200, 'Online hours fetched', {
      today: { minutes: todayMinutes, hours: Math.round(todayMinutes / 6) / 10 },
      thisWeek: { minutes: weekMinutes, hours: Math.round(weekMinutes / 6) / 10 },
      currentlyOnline: !!currentSession,
      currentSessionStartedAt: currentSession?.startedAt ?? null,
    });
  } catch (err) {
    logger.error('getOnlineHours error:', err);
    return sendError(res, 500, 'Failed to fetch online hours', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /rider/today-completed ───────────────────────────────────
const getTodayCompleted = async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const jobs = await DeliveryJob.find({
      riderId: req.user.id,
      status: DELIVERY_JOB_STATUS.DELIVERED,
      deliveredAt: { $gte: todayStart },
    })
      .sort({ deliveredAt: -1 })
      .lean();

    return sendSuccess(res, 200, 'Today completed fetched', { jobs });
  } catch (err) {
    logger.error('getTodayCompleted error:', err);
    return sendError(res, 500, 'Failed to fetch today completed', ERROR_CODES.INTERNAL_ERROR);
  }
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
  getRiderWallet,
  getWalletTransactions,
  getWalletWithdrawals,
  getDailyEarnings,
  getRiderPerformance,
  getSurgeStatus,
  getOnlineHours,
  getTodayCompleted,
};
