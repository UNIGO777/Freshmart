require('dotenv').config();
const { z } = require('zod');
const axios = require('axios');
const Rider = require('../../user/models/Rider.model');
const RiderLocation = require('../models/RiderLocation.model');
const RiderWallet = require('../models/RiderWallet.model');
const RiderCreditWallet = require('../models/RiderCreditWallet.model');
const WalletTransaction = require('../models/WalletTransaction.model');
const RiderSession = require('../models/RiderSession.model');
const DeliveryJob = require('../models/DeliveryJob.model');
const { DELIVERY_JOB_STATUS } = require('../models/DeliveryJob.model');
const DeliveryOtp = require('../models/DeliveryOtp.model');
const DeliveryRateConfig = require('../../admin/models/DeliveryRateConfig.model');
const Vendor = require('../../user/models/Vendor.model');
const Customer = require('../../user/models/Customer.model');
const { handleRiderAccept, handleRiderReject } = require('../logic/riderAssigner');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const { triggerNotification } = require('../../../shared/utils/notify');
const { notifyAdmin } = require('../../../shared/utils/notifyAdmin');
const { notifyVendor } = require('../../../shared/utils/vendorNotify');
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

    // Allow going offline even with active delivery — rider can still complete
    // the delivery but won't receive new job offers while offline.

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
    // SECURITY: never send pickup/delivery OTPs to the rider — they must obtain
    // them from the vendor/customer in person. returnOtp is kept only because the
    // rider app uses its *presence* to restore the returning state on restart.
    const [active, offered] = await Promise.all([
      DeliveryJob.find({
        riderId: req.user.id,
        status: { $in: [DELIVERY_JOB_STATUS.ACCEPTED, DELIVERY_JOB_STATUS.PICKED] },
      })
        .select('-deliveryOtp -pickupOtp -pickups.pickupOtp') // never leak vendor pickup codes to the rider
        .sort({ createdAt: -1 })
        .lean(),

      DeliveryJob.find({
        offeredRiderIds: req.user.id,
        status: DELIVERY_JOB_STATUS.OFFERED,
        offerExpiresAt: { $gt: new Date() }, // Only show offers still within window
      })
        .select('-deliveryOtp -pickupOtp -pickups.pickupOtp') // never leak vendor pickup codes to the rider
        .sort({ createdAt: -1 })
        .lean(),
    ]);

    // Enrich active jobs with vendor/customer details for tracking screen
    const enriched = await Promise.all(active.map(async (job) => {
      const [vendor, customer] = await Promise.all([
        Vendor.findById(job.vendorId).select('businessName phone').lean(),
        Customer.findById(job.customerId).select('name phone').lean(),
      ]);
      return {
        ...job,
        vendorName: vendor?.businessName || '',
        vendorPhone: vendor?.phone || '',
        customerName: customer?.name || '',
        customerPhone: customer?.phone || '',
      };
    }));

    return sendSuccess(res, 200, 'Jobs fetched', { active: enriched, offered });
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

    // Fetch vendor & customer details for the rider tracking screen
    const [vendor, customer] = await Promise.all([
      Vendor.findById(result.job.vendorId).select('businessName phone').lean(),
      Customer.findById(result.job.customerId).select('name phone').lean(),
    ]);

    // MR multi-pickup: return the ordered stops WITH vendor names (never the OTPs).
    let pickupsOut = [];
    const stops = result.job.pickups || [];
    if (stops.length > 0) {
      const vids = [...new Set(stops.map((s) => s.vendorId.toString()))];
      const vdocs = await Vendor.find({ _id: { $in: vids } }).select('businessName phone').lean();
      const vmap = Object.fromEntries(vdocs.map((v) => [v._id.toString(), v]));
      pickupsOut = stops
        .slice()
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        .map((s) => ({
          _id:            s._id,
          vendorId:       s.vendorId,
          vendorName:     vmap[s.vendorId.toString()]?.businessName || '',
          vendorPhone:    vmap[s.vendorId.toString()]?.phone || '',
          pickupLocation: s.pickupLocation,
          status:         s.status,
          seq:            s.seq,
          // pickupOtp intentionally omitted — the vendor shows it, the rider enters it
        }));
    }

    return sendSuccess(res, 200, 'Job accepted', {
      jobId:          req.params.jobId,
      orderId:        result.job.orderId,
      pickupLocation: result.job.pickupLocation,
      dropLocation:   result.job.dropLocation,
      pickups:        pickupsOut, // [] for single-pickup jobs
      earnings:       result.job.riderEarnings,
      distanceKm:     result.job.distanceKm,
      distanceRiderToVendor:    result.job.distanceRiderToVendor,
      distanceVendorToCustomer: result.job.distanceVendorToCustomer,
      ratePerKm:       result.job.ratePerKm,
      surgeMultiplier: result.job.surgeMultiplier,
      vendorId:        result.job.vendorId,
      customerId:      result.job.customerId,
      vendorName:      vendor?.businessName || '',
      vendorPhone:     vendor?.phone || '',
      customerName:    customer?.name || '',
      customerPhone:   customer?.phone || '',
      status:          result.job.status,
      deliveryInstructions: result.job.deliveryInstructions || '',
      paymentMethod:   result.job.paymentMethod || 'cod',
      totalAmount:     result.job.totalAmount ?? 0,
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
// Requires { otp } in body — must match the pickupOtp given to vendor.
const markPickedUp = async (req, res) => {
  try {
    const { otp } = req.body;
    const job = await DeliveryJob.findOne({ _id: req.params.jobId, riderId: req.user.id });
    if (!job) return sendError(res, 404, 'Job not found', ERROR_CODES.NOT_FOUND);
    if (job.status !== DELIVERY_JOB_STATUS.ACCEPTED) {
      return sendError(res, 400, 'Job must be in accepted state to mark pickup', ERROR_CODES.VALIDATION_ERROR);
    }

    // ── MR multi-pickup: mark ONE vendor stop; the job only becomes PICKED (out for
    //    delivery) once EVERY stop is done. Single-pickup jobs (pickups empty) fall through
    //    to the unchanged path below. ──
    if ((job.pickups || []).length > 0) {
      const { stopId, vendorId: bodyVendorId } = req.body;
      const stop = stopId
        ? job.pickups.id(stopId)
        : bodyVendorId
          ? job.pickups.find((s) => s.vendorId.toString() === String(bodyVendorId) && s.status === 'pending')
          : job.pickups.find((s) => s.status === 'pending');
      if (!stop) return sendError(res, 400, 'No matching pending pickup stop', ERROR_CODES.VALIDATION_ERROR);
      if (stop.status === 'picked') return sendError(res, 400, 'This stop is already picked up', ERROR_CODES.VALIDATION_ERROR);
      if (!otp || String(otp) !== String(stop.pickupOtp)) {
        return sendError(res, 400, 'Invalid pickup OTP for this stop', ERROR_CODES.VALIDATION_ERROR);
      }

      stop.status = 'picked';
      stop.pickedAt = new Date();

      const riderDoc = await Rider.findById(req.user.id).select('name').lean();

      // Vendor earning for this stop's sub-orders (each vendor earns at its own pickup)
      for (const soId of stop.subOrderIds || []) {
        axios.post(
          `http://localhost:${process.env.PORT_ORDER || 3004}/internal/vendor-earning`,
          { orderId: job.orderId.toString(), subOrderId: soId.toString(), vendorId: stop.vendorId.toString() },
          { timeout: 5000 },
        ).catch((err) => logger.warn(`vendor-earning (stop) failed: ${err.message}`));
      }
      // Retire this stop's pickup OTP + tell the vendor
      await DeliveryOtp.deleteOne({ jobId: job._id, type: 'pickup', vendorId: stop.vendorId }).catch(() => {});
      emitToRoom(`vendor:${stop.vendorId}`, 'order:status', { orderId: job.orderId, status: 'picked' });
      notifyVendor(stop.vendorId.toString(), 'order:picked', 'Order Picked Up',
        `Rider ${riderDoc?.name || ''} picked up order #${job.orderId.toString().slice(-4)}`, job.orderId.toString());

      const pickedCount = job.pickups.filter((s) => s.status === 'picked').length;
      const allPicked = pickedCount === job.pickups.length;

      if (!allPicked) {
        await job.save();
        emitToRoom(`order:tracking:${job.orderId}`, 'order:status', {
          orderId: job.orderId, status: 'picking', pickedStops: pickedCount, totalStops: job.pickups.length,
        });
        return sendSuccess(res, 200, 'Stop picked up', {
          jobId: job._id, stopId: stop._id, allPicked: false, remaining: job.pickups.length - pickedCount,
        });
      }

      // Every stop done → order is on the way. Issue the single delivery OTP to the customer.
      job.status = DELIVERY_JOB_STATUS.PICKED;
      job.pickedAt = new Date();
      job.deliveryOtp = String(Math.floor(1000 + Math.random() * 9000));
      await job.save();
      try {
        await DeliveryOtp.create({
          orderId: job.orderId, jobId: job._id, vendorId: job.vendorId, customerId: job.customerId,
          riderId: req.user.id, type: 'delivery', code: job.deliveryOtp, recipientType: 'customer',
        });
      } catch (e) { logger.warn(`DeliveryOtp (delivery) failed job ${job._id}: ${e.message}`); }

      syncOrderService(job, 'picked', { pickedAt: job.pickedAt });
      emitOrderStatus(job, 'picked');
      emitToRoom(`customer:${job.customerId}`, 'order:status', { orderId: job.orderId, status: 'on_the_way' });
      emitToRoom(`order:tracking:${job.orderId}`, 'order:status', { orderId: job.orderId, status: 'on_the_way' });
      triggerNotification('order:picked', job.customerId.toString(), 'customer', { orderId: job.orderId.toString() });
      emitToRoom(`customer:${job.customerId}`, 'order:delivery-otp', { orderId: job.orderId, jobId: job._id, otp: job.deliveryOtp, riderName: riderDoc?.name });
      emitToRoom(`order:tracking:${job.orderId}`, 'order:delivery-otp', { orderId: job.orderId, jobId: job._id, otp: job.deliveryOtp, riderName: riderDoc?.name });
      triggerNotification('order:delivery-otp', job.customerId.toString(), 'customer', { orderId: job.orderId.toString(), otp: job.deliveryOtp, riderName: riderDoc?.name });

      return sendSuccess(res, 200, 'All pickups complete — out for delivery', { jobId: job._id, allPicked: true });
    }

    // Verify pickup OTP (coerce to string for type-safe comparison)
    if (!otp || String(otp) !== String(job.pickupOtp)) {
      return sendError(res, 400, 'Invalid pickup OTP', ERROR_CODES.VALIDATION_ERROR);
    }

    // Clear pickup OTP, generate delivery OTP (customer shares with rider at delivery)
    job.pickupOtp = null;
    job.deliveryOtp = String(Math.floor(1000 + Math.random() * 9000));

    job.status = DELIVERY_JOB_STATUS.PICKED;
    job.pickedAt = new Date();
    await job.save();

    // Remove pickup OTP from OTP model (used), create delivery OTP
    try {
      await DeliveryOtp.deleteOne({ jobId: job._id, type: 'pickup' });
      await DeliveryOtp.create({
        orderId: job.orderId,
        jobId: job._id,
        vendorId: job.vendorId,
        customerId: job.customerId,
        riderId: req.user.id,
        type: 'delivery',
        code: job.deliveryOtp,
        recipientType: 'customer',
      });
    } catch (otpErr) {
      logger.warn(`DeliveryOtp swap (pickup→delivery) failed for job ${job._id}: ${otpErr.message}`);
    }

    // Sync Order Service (non-fatal)
    syncOrderService(job, 'picked', { pickedAt: job.pickedAt });

    // Notify customer via socket + FCM push — send both sub-order and parent status
    emitOrderStatus(job, 'picked');
    // Parent order is now on_the_way (promoted by order service)
    emitToRoom(`customer:${job.customerId}`, 'order:status', {
      orderId: job.orderId, status: 'on_the_way',
    });
    // Also emit to the order tracking room so tracking screen gets instant phase update
    emitToRoom(`order:tracking:${job.orderId}`, 'order:status', {
      orderId: job.orderId, subOrderId: job.subOrderId, status: 'picked',
    });
    emitToRoom(`order:tracking:${job.orderId}`, 'order:status', {
      orderId: job.orderId, status: 'on_the_way',
    });
    triggerNotification('order:picked', job.customerId.toString(), 'customer', {
      orderId: job.orderId.toString(),
    });

    // Send delivery OTP to customer (in-app display)
    const riderDoc = await Rider.findById(req.user.id).select('name').lean();
    emitToRoom(`customer:${job.customerId}`, 'order:delivery-otp', {
      orderId: job.orderId,
      jobId:   job._id,
      otp:     job.deliveryOtp,
      riderName: riderDoc?.name,
    });
    // Also emit OTP to tracking room
    emitToRoom(`order:tracking:${job.orderId}`, 'order:delivery-otp', {
      orderId: job.orderId, jobId: job._id, otp: job.deliveryOtp, riderName: riderDoc?.name,
    });
    triggerNotification('order:delivery-otp', job.customerId.toString(), 'customer', {
      orderId:   job.orderId.toString(),
      otp:       job.deliveryOtp,
      riderName: riderDoc?.name,
    });

    // Create vendor earning BEFORE notifying vendor, so wallet-update socket
    // arrives before or with the order:status event (prevents stale re-fetch race)
    try {
      await axios.post(
        `http://localhost:${process.env.PORT_ORDER || 3004}/internal/vendor-earning`,
        { orderId: job.orderId.toString(), subOrderId: job.subOrderId.toString(), vendorId: job.vendorId.toString() },
        { timeout: 5000 },
      );
    } catch (err) {
      logger.warn(`vendor-earning trigger failed: ${err.message}`);
    }

    // Notify vendor that pickup is complete
    emitToRoom(`vendor:${job.vendorId}`, 'order:status', {
      orderId: job.orderId,
      status: 'picked',
    });
    triggerNotification('order:picked-vendor', job.vendorId.toString(), 'vendor', {
      orderId: job.orderId.toString(),
      riderName: riderDoc?.name,
    });
    notifyVendor(job.vendorId.toString(), 'order:picked', 'Order Picked Up',
      `Rider ${riderDoc?.name || ''} picked up order #${job.orderId.toString().slice(-4)}`,
      job.orderId.toString());

    return sendSuccess(res, 200, 'Marked as picked up', { jobId: job._id });
  } catch (err) {
    logger.error('markPickedUp error:', err);
    return sendError(res, 500, 'Failed to mark pickup', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /rider/deliver/:jobId ───────────────────────────────────
// Rider marks the order as delivered to the customer.
// Requires { otp } in body — must match the deliveryOtp given to customer.
const markDelivered = async (req, res) => {
  try {
    const { otp } = req.body;
    const job = await DeliveryJob.findOne({ _id: req.params.jobId, riderId: req.user.id });
    if (!job) return sendError(res, 404, 'Job not found', ERROR_CODES.NOT_FOUND);
    if (job.status !== DELIVERY_JOB_STATUS.PICKED) {
      return sendError(res, 400, 'Order must be picked up before marking delivered', ERROR_CODES.VALIDATION_ERROR);
    }

    // Verify delivery OTP (coerce to string for type-safe comparison)
    if (!otp || String(otp) !== String(job.deliveryOtp)) {
      return sendError(res, 400, 'Invalid delivery OTP', ERROR_CODES.VALIDATION_ERROR);
    }

    job.deliveryOtp = null;
    job.status = DELIVERY_JOB_STATUS.DELIVERED;
    job.deliveredAt = new Date();
    await job.save();

    // Remove delivery OTP from OTP model (used)
    try {
      await DeliveryOtp.deleteOne({ jobId: job._id, type: 'delivery' });
    } catch (otpErr) {
      logger.warn(`DeliveryOtp delete (delivery) failed for job ${job._id}: ${otpErr.message}`);
    }

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

    // COD collection: credit the rider's credit wallet with the total order amount
    const isCodCollected = job.paymentMethod === 'cod' && job.totalAmount > 0;
    if (isCodCollected) {
      const creditWallet = await RiderCreditWallet.findOneAndUpdate(
        { riderId },
        {
          $inc: { balance: job.totalAmount, totalCollected: job.totalAmount },
          $setOnInsert: { riderId },
        },
        { upsert: true, new: true },
      );

      await WalletTransaction.create({
        riderId,
        type: 'collection',
        walletType: 'credit',
        amount: job.totalAmount,
        balanceAfter: creditWallet.balance,
        jobId: job._id,
        description: `COD collected — Order #${job.orderId.toString().slice(-6).toUpperCase()} — ₹${job.totalAmount}`,
        status: 'completed',
      });
    }

    // Sync Order Service (non-fatal). Fold paymentStatus into this single write so
    // there is only ONE writer to the order document — a separate concurrent
    // mark-paid save would race with this one and could revert the delivered status.
    const deliveredExtra = { deliveredAt: job.deliveredAt };
    if (isCodCollected) deliveredExtra.paymentStatus = 'paid';
    syncOrderService(job, 'delivered', deliveredExtra);

    // Notify customer via socket + FCM push
    emitOrderStatus(job, 'delivered');
    emitToRoom(`order:tracking:${job.orderId}`, 'order:status', {
      orderId: job.orderId, subOrderId: job.subOrderId, status: 'delivered',
    });
    triggerNotification('order:delivered', job.customerId.toString(), 'customer', {
      orderId: job.orderId.toString(),
    });

    notifyVendor(job.vendorId.toString(), 'order:delivered', 'Order Delivered',
      `Order #${job.orderId.toString().slice(-4)} has been delivered to the customer`,
      job.orderId.toString());

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

const syncOrderService = async (job, status, extra = {}) => {
  // Multi-pickup: one rider/drop covers EVERY vendor sub-order, so sync them all (else the
  // other sub-orders never reach picked/delivered and the parent order never completes).
  // Single-pickup: just job.subOrderId, exactly as before.
  const subOrderIds = (job.pickups && job.pickups.length > 0)
    ? job.pickups.flatMap((s) => (s.subOrderIds || []).map((id) => id.toString()))
    : [job.subOrderId.toString()];
  // Run these SEQUENTIALLY, never in parallel: /internal/update-suborder does a
  // read-modify-write on the SAME order doc, so two concurrent calls race and the
  // second save clobbers the first's sub-order change — leaving one sub-order
  // never-delivered and the parent order stuck at 'partially_delivered'. Awaiting
  // each in turn means the order service sees the previous sub-order already
  // delivered when it promotes the parent status → the last one flips it to
  // 'delivered' and emits the realtime event.
  for (const subOrderId of subOrderIds) {
    try {
      await axios.post(
        `http://localhost:${process.env.PORT_ORDER || 3004}/internal/update-suborder`,
        {
          orderId:    job.orderId.toString(),
          subOrderId,
          update:     { status, ...extra },
        },
        { timeout: 5000 },
      );
    } catch (err) {
      logger.warn(`syncOrderService(${status}) failed for subOrder ${subOrderId}: ${err.message}`);
    }
  }
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

/** Emit arbitrary event to any socket room. */
const emitToRoom = (room, event, payload) => {
  axios
    .post(
      `http://localhost:${process.env.PORT_SOCKET || 3010}/internal/emit`,
      { room, event, payload },
      { timeout: 3000 },
    )
    .catch((err) => logger.warn(`emitToRoom(${room}, ${event}) failed: ${err.message}`));
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

    const recentTransactions = await WalletTransaction.find({ riderId, walletType: { $ne: 'credit' } })
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

    // Earnings wallet only — COD collections live in the separate credit wallet
    const filter = { riderId, walletType: { $ne: 'credit' } };
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
      .select('-deliveryOtp -pickupOtp -returnOtp')
      .sort({ deliveredAt: -1 })
      .lean();

    return sendSuccess(res, 200, 'Today completed fetched', { jobs });
  } catch (err) {
    logger.error('getTodayCompleted error:', err);
    return sendError(res, 500, 'Failed to fetch today completed', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /rider/cancel-request/:jobId ────────────────────────────
// Rider requests cancellation. Before pickup → direct cancel. After pickup → return flow.
const RIDER_CANCEL_REASONS = [
  'customer_unreachable',
  'customer_not_available',
  'wrong_address',
  'customer_refused',
  'emergency',
  'cannot_find_store',
  'store_closed',
  'too_far',
  'vehicle_issue',
];

const requestRiderCancel = async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !RIDER_CANCEL_REASONS.includes(reason)) {
      return sendError(res, 400, 'Valid cancellation reason required', ERROR_CODES.VALIDATION_ERROR);
    }

    const job = await DeliveryJob.findOne({ _id: req.params.jobId, riderId: req.user.id });
    if (!job) return sendError(res, 404, 'Job not found', ERROR_CODES.NOT_FOUND);

    if (![DELIVERY_JOB_STATUS.ACCEPTED, DELIVERY_JOB_STATUS.PICKED].includes(job.status)) {
      return sendError(res, 400, 'Cannot cancel in current status', ERROR_CODES.VALIDATION_ERROR);
    }

    const riderDoc = await Rider.findById(req.user.id).select('name').lean();

    // ── ACCEPTED (before pickup) — direct cancel, no return needed ──
    if (job.status === DELIVERY_JOB_STATUS.ACCEPTED) {
      job.status = DELIVERY_JOB_STATUS.CANCELLED;
      job.cancelledAt = new Date();
      job.riderCancelReason = reason;
      await job.save();

      // Remove pickup OTP from OTP model
      try {
        await DeliveryOtp.deleteMany({ jobId: job._id });
      } catch (otpErr) {
        logger.warn(`DeliveryOtp cleanup failed for cancelled job ${job._id}: ${otpErr.message}`);
      }

      // Free the rider
      await Rider.findByIdAndUpdate(req.user.id, { isOnDelivery: false });

      // Cancel the order (internalCancelOrder handles inventory restore, refund, and socket notifications)
      try {
        await axios.post(
          `http://localhost:${process.env.PORT_ORDER || 3004}/internal/cancel-order`,
          { orderId: job.orderId.toString(), reason: 'rider_cancelled_before_pickup' },
          { timeout: 5000 },
        );
      } catch (err) {
        logger.warn(`cancel-order failed for order ${job.orderId}: ${err.message}`);
      }

      // Push notification to customer
      triggerNotification('order:cancelled', job.customerId.toString(), 'customer', {
        orderId: job.orderId.toString(),
      });

      logger.info(`Job ${job._id} cancelled by rider ${req.user.id} before pickup: ${reason}`);
      return sendSuccess(res, 200, 'Order cancelled', { jobId: job._id });
    }

    // ── PICKED (after pickup) — return flow with OTP ──
    if (job.returnOtp) {
      return sendError(res, 400, 'Cancel request already pending — return package to vendor', ERROR_CODES.VALIDATION_ERROR);
    }

    const returnOtp = String(Math.floor(1000 + Math.random() * 9000));
    job.returnOtp = returnOtp;
    job.riderCancelReason = reason;
    await job.save();

    // Persist return OTP in OTP model (delete any delivery OTP first)
    try {
      await DeliveryOtp.deleteOne({ jobId: job._id, type: 'delivery' });
      await DeliveryOtp.create({
        orderId: job.orderId,
        jobId: job._id,
        vendorId: job.vendorId,
        customerId: job.customerId,
        riderId: req.user.id,
        type: 'return',
        code: returnOtp,
        recipientType: 'vendor',
      });
    } catch (otpErr) {
      logger.warn(`DeliveryOtp create (return) failed for job ${job._id}: ${otpErr.message}`);
    }

    // Emit return OTP to vendor
    emitToRoom(`vendor:${job.vendorId}`, 'order:return-otp', {
      orderId: job.orderId, otp: returnOtp, riderName: riderDoc?.name, jobId: job._id,
    });
    triggerNotification('order:return-otp', job.vendorId.toString(), 'vendor', {
      orderId: job.orderId.toString(), otp: returnOtp, riderName: riderDoc?.name,
    });
    notifyVendor(job.vendorId.toString(), 'order:returning', 'Order Being Returned',
      `Rider ${riderDoc?.name || ''} is returning order #${job.orderId.toString().slice(-4)} to your store`,
      job.orderId.toString());

    // Cancel the order for the customer immediately (inventory/earnings reversed when rider returns)
    try {
      await axios.post(
        `http://localhost:${process.env.PORT_ORDER || 3004}/internal/cancel-order-status`,
        { orderId: job.orderId.toString(), reason: 'rider_cancelled_after_pickup' },
        { timeout: 5000 },
      );
    } catch (err) {
      logger.warn(`cancel-order-status failed for order ${job.orderId}: ${err.message}`);
    }

    triggerNotification('order:cancelled', job.customerId.toString(), 'customer', {
      orderId: job.orderId.toString(),
    });

    return sendSuccess(res, 200, 'Cancel requested, return package to vendor', {
      jobId: job._id, vendorAddress: job.pickupLocation,
    });
  } catch (err) {
    logger.error('requestRiderCancel error:', err);
    return sendError(res, 500, 'Failed to request cancellation', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /rider/confirm-return/:jobId ───────────────────────────
// Rider confirms return to vendor with OTP. No wallet deduction — rider simply earns nothing.
const confirmReturn = async (req, res) => {
  try {
    const { otp } = req.body;
    const job = await DeliveryJob.findOne({ _id: req.params.jobId, riderId: req.user.id });
    if (!job) return sendError(res, 404, 'Job not found', ERROR_CODES.NOT_FOUND);
    if (!job.returnOtp) return sendError(res, 400, 'No return request pending', ERROR_CODES.VALIDATION_ERROR);
    if (!otp || String(otp) !== String(job.returnOtp)) return sendError(res, 400, 'Invalid return OTP', ERROR_CODES.VALIDATION_ERROR);

    // 1. Mark job as cancelled — rider earns NOTHING
    job.status = DELIVERY_JOB_STATUS.CANCELLED;
    job.cancelledByRider = true;
    job.returnOtp = null;
    job.returnedAt = new Date();
    job.riderEarnings = 0;
    await job.save();

    // Remove return OTP from OTP model (used)
    try {
      await DeliveryOtp.deleteOne({ jobId: job._id, type: 'return' });
    } catch (otpErr) {
      logger.warn(`DeliveryOtp delete (return) failed for job ${job._id}: ${otpErr.message}`);
    }

    // 2. Free rider for new deliveries
    await Rider.findByIdAndUpdate(req.user.id, { isOnDelivery: false });

    // 3. Reverse vendor earning (created at pickup — vendor gets package back)
    try {
      await axios.post(`http://localhost:${process.env.PORT_ORDER || 3004}/internal/reverse-vendor-earning`, {
        orderId: job.orderId.toString(),
        subOrderId: job.subOrderId.toString(),
        reason: 'rider_cancellation',
      });
    } catch (err) {
      logger.error(`CRITICAL: reverse-vendor-earning failed for order ${job.orderId}: ${err.message}`);
    }

    // 4. Restore inventory (vendor has the package back now)
    try {
      await axios.post(`http://localhost:${process.env.PORT_ORDER || 3004}/internal/restore-stock`, {
        orderId: job.orderId.toString(),
        vendorId: job.vendorId.toString(),
      });
    } catch (err) {
      logger.error(`CRITICAL: restore-stock failed for order ${job.orderId}: ${err.message}`);
    }

    // 5. Update sub-order to returned
    try {
      await axios.post(`http://localhost:${process.env.PORT_ORDER || 3004}/internal/update-suborder`, {
        orderId: job.orderId.toString(),
        subOrderId: job.subOrderId.toString(),
        update: { status: 'returned' },
      });
    } catch (err) {
      logger.error(`CRITICAL: update-suborder failed for order ${job.orderId}: ${err.message}`);
    }

    // 6. Notify vendor — return confirmed
    emitToRoom(`vendor:${job.vendorId}`, 'order:status', {
      orderId: job.orderId, status: 'returned',
      message: 'Rider has returned the package.',
    });
    notifyVendor(job.vendorId.toString(), 'order:returned', 'Order Returned',
      `Order #${job.orderId.toString().slice(-4)} has been returned to your store. Wallet has been adjusted.`,
      job.orderId.toString());

    return sendSuccess(res, 200, 'Return confirmed', { jobId: job._id });
  } catch (err) {
    logger.error('confirmReturn error:', err);
    return sendError(res, 500, 'Failed to confirm return', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /rider/reset-all-jobs (TEST MODE ONLY) ─────────────────
// Cancel all active/offered jobs for this rider and reset state.
const resetAllJobs = async (req, res) => {
  try {
    const riderId = req.user.id;

    // Find all non-terminal jobs for this rider
    const jobs = await DeliveryJob.find({
      riderId,
      status: { $in: [DELIVERY_JOB_STATUS.ACCEPTED, DELIVERY_JOB_STATUS.PICKED, DELIVERY_JOB_STATUS.OFFERED] },
    });

    for (const job of jobs) {
      job.status = DELIVERY_JOB_STATUS.CANCELLED;
      job.cancelledAt = new Date();
      job.cancelReason = 'test_reset';
      await job.save();

      // Clean up OTPs for this job
      try {
        await DeliveryOtp.deleteMany({ jobId: job._id });
      } catch (err) {
        logger.warn(`DeliveryOtp cleanup failed for job ${job._id}: ${err.message}`);
      }

      // Restore inventory
      try {
        await axios.post(
          `http://localhost:${process.env.PORT_ORDER || 3004}/internal/restore-stock`,
          { orderId: job.orderId.toString(), vendorId: job.vendorId.toString() },
          { timeout: 5000 },
        );
      } catch (err) {
        logger.warn(`restore-stock failed during reset for order ${job.orderId}: ${err.message}`);
      }

      // Cancel the order
      try {
        await axios.post(
          `http://localhost:${process.env.PORT_ORDER || 3004}/internal/cancel-order`,
          { orderId: job.orderId.toString(), reason: 'test_reset' },
          { timeout: 5000 },
        );
      } catch (err) {
        logger.warn(`cancel-order failed during reset for order ${job.orderId}: ${err.message}`);
      }
    }

    // Also cancel any offered jobs (not yet assigned to this rider but offered)
    const offeredJobs = await DeliveryJob.find({
      offeredRiderIds: riderId,
      status: DELIVERY_JOB_STATUS.OFFERED,
    });
    for (const job of offeredJobs) {
      job.status = DELIVERY_JOB_STATUS.FAILED;
      await job.save();
    }

    // Reset rider state
    await Rider.findByIdAndUpdate(riderId, {
      isOnDelivery: false,
    });

    logger.info(`[TEST] All jobs reset for rider ${riderId} — ${jobs.length} active, ${offeredJobs.length} offered`);
    return sendSuccess(res, 200, 'All jobs reset', {
      cancelledActive: jobs.length,
      cancelledOffered: offeredJobs.length,
    });
  } catch (err) {
    logger.error('resetAllJobs error:', err);
    return sendError(res, 500, 'Failed to reset jobs', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /vendor/active-otps ───────────────────────────────────────
// Vendor fetches all active OTPs for their orders (survives app restart).
const getVendorActiveOtps = async (req, res) => {
  try {
    const vendorId = req.user.id;
    const otps = await DeliveryOtp.find({
      vendorId,
      recipientType: 'vendor',
    }).lean();

    // Group by orderId for easy frontend consumption
    const otpMap = {};
    for (const otp of otps) {
      const key = otp.orderId.toString();
      if (!otpMap[key]) otpMap[key] = {};
      if (otp.type === 'pickup') otpMap[key].pickupOtp = otp.code;
      if (otp.type === 'return') otpMap[key].returnOtp = otp.code;
    }

    return sendSuccess(res, 200, 'Active OTPs fetched', { otps: otpMap });
  } catch (err) {
    logger.error('getVendorActiveOtps error:', err);
    return sendError(res, 500, 'Failed to fetch OTPs', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /customer/active-otps ────────────────────────────────────
// Customer fetches active delivery OTP for their orders (survives app restart).
const getCustomerActiveOtps = async (req, res) => {
  try {
    const customerId = req.user.id;
    const otps = await DeliveryOtp.find({
      customerId,
      recipientType: 'customer',
    }).lean();

    // Group by orderId
    const otpMap = {};
    for (const otp of otps) {
      const key = otp.orderId.toString();
      if (!otpMap[key]) otpMap[key] = {};
      if (otp.type === 'delivery') otpMap[key].deliveryOtp = otp.code;
    }

    return sendSuccess(res, 200, 'Active OTPs fetched', { otps: otpMap });
  } catch (err) {
    logger.error('getCustomerActiveOtps error:', err);
    return sendError(res, 500, 'Failed to fetch OTPs', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /rider/credit-wallet ─────────────────────────────────────
const getRiderCreditWallet = async (req, res) => {
  try {
    const riderId = req.user.id;
    let creditWallet = await RiderCreditWallet.findOne({ riderId }).lean();
    if (!creditWallet) {
      creditWallet = { riderId, balance: 0, totalCollected: 0, totalSettled: 0 };
    }

    const recentCollections = await WalletTransaction.find({
      riderId, walletType: 'credit',
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    return sendSuccess(res, 200, 'Credit wallet fetched', { creditWallet, recentCollections });
  } catch (err) {
    logger.error('getRiderCreditWallet error:', err);
    return sendError(res, 500, 'Failed to fetch credit wallet', ERROR_CODES.INTERNAL_ERROR);
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
  requestRiderCancel,
  confirmReturn,
  resetAllJobs,
  getVendorActiveOtps,
  getCustomerActiveOtps,
  getRiderCreditWallet,
};
