require('dotenv').config();
const axios = require('axios');
const Rider = require('../../user/models/Rider.model');
const DeliveryJob = require('../models/DeliveryJob.model');
const { DELIVERY_JOB_STATUS } = require('../models/DeliveryJob.model');
const DeliveryRateConfig = require('../../admin/models/DeliveryRateConfig.model');
const { findNearbyRiders, BATCH_SIZE } = require('./nearbyFinder');
const { redisClient } = require('../../../shared/db/redis');
const { triggerNotification } = require('../../../shared/utils/notify');
const logger = require('../../../shared/utils/logger');

// ── Haversine distance (km) ──────────────────────────────────────
const haversineKm = (lat1, lng1, lat2, lng2) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const ASSIGNMENT_TIMEOUT_SEC = Number(process.env.RIDER_ASSIGNMENT_TIMEOUT_SEC) || 30;

// ── Redis key helpers ─────────────────────────────────────────────
/** Tracks the current active batch for a job. TTL = ASSIGNMENT_TIMEOUT_SEC. */
const jobOfferKey = (jobId) => `delivery:offer:${jobId}`;

// ── Internal service calls ────────────────────────────────────────
const emitToRider = async (riderId, event, payload) => {
  try {
    await axios.post(
      `http://localhost:${process.env.PORT_SOCKET || 3010}/internal/emit`,
      { room: `rider:${riderId}`, event, payload },
      { timeout: 3000 },
    );
  } catch (err) {
    logger.warn(`Socket emit to rider ${riderId} failed: ${err.message}`);
  }
};

const emitToCustomer = async (customerId, event, payload) => {
  try {
    await axios.post(
      `http://localhost:${process.env.PORT_SOCKET || 3010}/internal/emit`,
      { room: `customer:${customerId}`, event, payload },
      { timeout: 3000 },
    );
  } catch (err) {
    logger.warn(`Socket emit to customer ${customerId} failed: ${err.message}`);
  }
};

/** Call Order Service to update sub-order status (riderId, timestamps, status). */
const syncSubOrderStatus = async (orderId, subOrderId, update) => {
  try {
    await axios.post(
      `http://localhost:${process.env.PORT_ORDER || 3004}/internal/update-suborder`,
      { orderId: orderId.toString(), subOrderId: subOrderId.toString(), update },
      { timeout: 5000 },
    );
  } catch (err) {
    logger.warn(`syncSubOrderStatus failed for order ${orderId}: ${err.message}`);
  }
};

// ── Core logic ────────────────────────────────────────────────────

/**
 * Create a DeliveryJob and start the rider assignment process.
 * Called by the Delivery Service's internal `/internal/assign-rider` endpoint
 * immediately after all sub-orders are confirmed.
 */
const initiateRiderAssignment = async ({
  orderId, subOrderId, vendorId, customerId,
  pickupLocation, dropLocation, deliveryFee,
}) => {
  // Fetch current rate config and lock it on this job
  const config = await DeliveryRateConfig.getConfig();
  const ratePerKm = config.ratePerKm;
  const surgeMultiplier = config.surgeActive ? config.surgeMultiplier : 1;

  // Calculate distance between pickup and drop
  const distanceKm = Math.round(
    haversineKm(pickupLocation.lat, pickupLocation.lng, dropLocation.lat, dropLocation.lng) * 100,
  ) / 100; // Round to 2 decimals

  // Earnings = distance × rate × surge (locked at assignment time)
  const riderEarnings = Math.round(distanceKm * ratePerKm * surgeMultiplier);

  const job = await DeliveryJob.create({
    orderId, subOrderId, vendorId, customerId,
    pickupLocation, dropLocation,
    deliveryFee: deliveryFee || 30,
    riderEarnings,
    ratePerKm,
    surgeMultiplier,
    distanceKm,
    status: DELIVERY_JOB_STATUS.PENDING,
    batchIndex: 0,
  });

  logger.info(`DeliveryJob ${job._id} created for order ${orderId}`);
  await tryNextBatch(job);
};

/**
 * Find the next batch of nearby riders and offer them the job.
 * If none found, mark the job as FAILED.
 */
const tryNextBatch = async (job) => {
  const alreadyOffered = job.offeredRiderIds.map((id) => id.toString());
  const riders = await findNearbyRiders(job.pickupLocation, alreadyOffered, BATCH_SIZE);

  if (riders.length === 0) {
    logger.warn(`No available riders for job ${job._id} — marking failed`);
    job.status = DELIVERY_JOB_STATUS.FAILED;
    await job.save();

    await emitToCustomer(job.customerId.toString(), 'order:status', {
      orderId: job.orderId,
      subOrderId: job.subOrderId,
      status: 'rider_assignment_failed',
      message: 'No rider is available nearby. We will keep trying.',
    });
    return;
  }

  await offerToRiderBatch(job, riders);
};

/**
 * Send `job:request` to a batch of riders and arm the 30s Redis TTL.
 */
const offerToRiderBatch = async (job, riders) => {
  const jobId = job._id.toString();
  const riderIds = riders.map((r) => r._id.toString());

  const expiresAt = new Date(Date.now() + ASSIGNMENT_TIMEOUT_SEC * 1000);

  // Redis key lives for exactly the offer window — expiry drives cascade
  await redisClient.set(
    jobOfferKey(jobId),
    JSON.stringify({ riderIds, batchIndex: job.batchIndex }),
    { EX: ASSIGNMENT_TIMEOUT_SEC },
  );

  job.offeredRiderIds.push(...riders.map((r) => r._id));
  job.offerExpiresAt = expiresAt;
  job.status = DELIVERY_JOB_STATUS.OFFERED;
  await job.save();

  // Increment totalOffered for all riders in this batch
  await Rider.updateMany(
    { _id: { $in: riders.map((r) => r._id) } },
    { $inc: { 'performance.totalOffered': 1 } },
  );

  for (const rider of riders) {
    const riderId = rider._id.toString();
    await emitToRider(riderId, 'job:request', {
      jobId,
      orderId:         job.orderId,
      subOrderId:      job.subOrderId,
      pickupLocation:  job.pickupLocation,
      dropLocation:    job.dropLocation,
      earnings:        job.riderEarnings,
      distanceKm:      job.distanceKm,
      ratePerKm:       job.ratePerKm,
      surgeMultiplier: job.surgeMultiplier,
      expiresIn:       ASSIGNMENT_TIMEOUT_SEC,
    });
    // FCM push so rider is alerted even if the app is in the background
    triggerNotification('job:request', riderId, 'rider', { jobId, orderId: job.orderId.toString(), expiresIn: ASSIGNMENT_TIMEOUT_SEC });
    logger.info(`Job ${jobId} offered to rider ${riderId} (batch ${job.batchIndex})`);
  }
};

/**
 * Cascade to the next batch of riders, or fail the job if no more riders are available.
 * Called when the 30s offer window expires (by background sweep) or
 * when every rider in the current batch has explicitly rejected.
 */
const cascadeOrFail = async (job) => {
  // Re-fetch to get the freshest state — race condition guard
  job = await DeliveryJob.findById(job._id);
  if (!job || ![DELIVERY_JOB_STATUS.OFFERED, DELIVERY_JOB_STATUS.PENDING].includes(job.status)) return;

  // Notify the previous batch their window has closed
  const prevStart = job.batchIndex * BATCH_SIZE;
  const prevBatchIds = job.offeredRiderIds.slice(prevStart);
  for (const riderId of prevBatchIds) {
    await emitToRider(riderId.toString(), 'job:expired', { jobId: job._id.toString() });
  }

  job.batchIndex += 1;
  await job.save();

  await tryNextBatch(job);
};

// ── Public API ────────────────────────────────────────────────────

/**
 * Handle a rider accepting a delivery job.
 * Validates the 30s window, assigns the rider, cancels the rest of the batch.
 *
 * @returns {{ success: boolean, reason?: string, job?: DeliveryJob }}
 */
const handleRiderAccept = async (jobId, riderId) => {
  const job = await DeliveryJob.findById(jobId);
  if (!job) return { success: false, reason: 'Job not found' };
  if (job.status !== DELIVERY_JOB_STATUS.OFFERED) {
    return { success: false, reason: `Job is not available (status: ${job.status})` };
  }

  // Validate 30s window via Redis
  const offerRaw = await redisClient.get(jobOfferKey(jobId));
  if (!offerRaw) {
    // TTL expired — cascade in background, reject this accept
    cascadeOrFail(job).catch((err) => logger.error(`cascade error for job ${jobId}:`, err));
    return { success: false, reason: 'Offer window has expired — you were too slow' };
  }

  const offer = JSON.parse(offerRaw);
  if (!offer.riderIds.includes(riderId)) {
    return { success: false, reason: 'This job was not offered to you' };
  }

  // ── Assign ────────────────────────────────────────────────────
  job.riderId = riderId;
  job.status = DELIVERY_JOB_STATUS.ACCEPTED;
  job.assignedAt = new Date();
  await job.save();

  await redisClient.del(jobOfferKey(jobId));

  // Mark rider as busy + update performance
  const riderUpdate = await Rider.findByIdAndUpdate(riderId, {
    isOnDelivery: true,
    $inc: { 'performance.totalAccepted': 1 },
  }, { new: true, select: 'performance' });

  // Recalculate acceptance rate
  if (riderUpdate?.performance?.totalOffered > 0) {
    const rate = Math.round((riderUpdate.performance.totalAccepted / riderUpdate.performance.totalOffered) * 100);
    await Rider.findByIdAndUpdate(riderId, { 'performance.acceptanceRate': rate });
  }

  // Dismiss other offered riders
  const otherRiderIds = offer.riderIds.filter((id) => id !== riderId);
  for (const otherRiderId of otherRiderIds) {
    await emitToRider(otherRiderId, 'job:cancelled', { jobId, reason: 'assigned_to_another_rider' });
  }

  // Get rider profile to share with customer
  const riderDoc = await Rider.findById(riderId).select('name phone vehicleType').lean();

  // Notify customer: rider is on the way to vendor (socket + FCM push)
  await emitToCustomer(job.customerId.toString(), 'order:status', {
    orderId:    job.orderId,
    subOrderId: job.subOrderId,
    status:     'rider_assigned',
    rider: {
      id:          riderId,
      name:        riderDoc?.name,
      phone:       riderDoc?.phone,
      vehicleType: riderDoc?.vehicleType,
    },
  });
  triggerNotification('rider:assigned', job.customerId.toString(), 'customer', {
    orderId:   job.orderId.toString(),
    riderName: riderDoc?.name,
  });

  // Sync Order Service sub-order
  await syncSubOrderStatus(job.orderId, job.subOrderId, {
    riderId,
    status: 'rider_assigned',
    riderAssignedAt: job.assignedAt,
  });

  logger.info(`Job ${jobId} assigned to rider ${riderId}`);
  return { success: true, job };
};

/**
 * Handle a rider explicitly rejecting a delivery job.
 * Cascades immediately if all riders in the current batch have now responded.
 *
 * @returns {{ success: boolean, reason?: string }}
 */
const handleRiderReject = async (jobId, riderId) => {
  const job = await DeliveryJob.findById(jobId);
  if (!job) return { success: false, reason: 'Job not found' };
  if (job.status !== DELIVERY_JOB_STATUS.OFFERED) return { success: false, reason: 'Job not active' };

  // Idempotent push
  const alreadyRejected = job.rejectedRiderIds.map((id) => id.toString());
  if (!alreadyRejected.includes(riderId)) {
    job.rejectedRiderIds.push(riderId);
    await job.save();

    // Update performance: increment totalRejected and recalculate acceptanceRate
    const riderDoc = await Rider.findByIdAndUpdate(
      riderId,
      { $inc: { 'performance.totalRejected': 1 } },
      { new: true, select: 'performance' },
    );
    if (riderDoc?.performance?.totalOffered > 0) {
      const rate = Math.round((riderDoc.performance.totalAccepted / riderDoc.performance.totalOffered) * 100);
      await Rider.findByIdAndUpdate(riderId, { 'performance.acceptanceRate': rate });
    }
  }

  // Check if entire batch has responded (all either rejected or offer expired)
  const offerRaw = await redisClient.get(jobOfferKey(jobId));
  if (!offerRaw) return { success: true }; // TTL expired — sweep will handle it

  const offer = JSON.parse(offerRaw);
  const updatedRejected = job.rejectedRiderIds.map((id) => id.toString());
  const allBatchResponded = offer.riderIds.every((id) => updatedRejected.includes(id));

  if (allBatchResponded) {
    await redisClient.del(jobOfferKey(jobId));
    await cascadeOrFail(job);
  }

  return { success: true };
};

/**
 * Background sweep: find jobs whose offer window expired in Redis (TTL gone)
 * but are still in OFFERED state in MongoDB — trigger cascade for each.
 *
 * Called every 15 seconds by a setInterval in delivery/index.js.
 */
const sweepExpiredOffers = async () => {
  const expired = await DeliveryJob.find({
    status: DELIVERY_JOB_STATUS.OFFERED,
    offerExpiresAt: { $lt: new Date() },
  }).lean();

  for (const jobDoc of expired) {
    const still = await redisClient.get(jobOfferKey(jobDoc._id.toString()));
    if (still) continue; // Redis key still alive — not truly expired yet

    logger.info(`[sweep] Expiring offer for job ${jobDoc._id}`);
    const job = await DeliveryJob.findById(jobDoc._id);
    if (job && job.status === DELIVERY_JOB_STATUS.OFFERED) {
      cascadeOrFail(job).catch((err) =>
        logger.error(`sweep cascade failed for job ${job._id}:`, err),
      );
    }
  }
};

module.exports = {
  initiateRiderAssignment,
  handleRiderAccept,
  handleRiderReject,
  sweepExpiredOffers,
};
