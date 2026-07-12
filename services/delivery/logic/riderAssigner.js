require('dotenv').config();
const axios = require('axios');
const Rider = require('../../user/models/Rider.model');
const DeliveryJob = require('../models/DeliveryJob.model');
const { DELIVERY_JOB_STATUS } = require('../models/DeliveryJob.model');
const DeliveryOtp = require('../models/DeliveryOtp.model');
const DeliveryRateConfig = require('../../admin/models/DeliveryRateConfig.model');
const { findNearbyRiders, BATCH_SIZE } = require('./nearbyFinder');
const { redisClient } = require('../../../shared/db/redis');
const { calculateRouteDistance } = require('./distanceCalculator');
const { triggerNotification } = require('../../../shared/utils/notify');
const { notifyVendor } = require('../../../shared/utils/vendorNotify');
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
const PORT_ORDER = process.env.PORT_ORDER || 3004;

// ── MR multi-pickup route + earning ───────────────────────────────
/**
 * Greedy nearest-neighbour route for ONE rider:
 *   rider → nearest stop → next-nearest → … → last stop → customer.
 * Distance INCLUDES the rider→first-stop leg (the whole trip the rider signs up for).
 *
 * @param {{lat,lng}} riderLoc
 * @param {Array<{pickupLocation:{lat,lng}}>} stops  (deduped per vendor)
 * @param {{lat,lng}} dropLoc
 * @returns {{ ordered: Array, distanceKm: number }}  ordered = stops in visit order
 */
const computeRouteFrom = (riderLoc, stops, dropLoc) => {
  const remaining = stops.slice();
  const ordered = [];
  let cur = riderLoc;
  let distanceKm = 0;
  while (remaining.length) {
    let best = 0, bestD = Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const loc = remaining[k].pickupLocation;
      const d = haversineKm(cur.lat, cur.lng, loc.lat, loc.lng);
      if (d < bestD) { bestD = d; best = k; }
    }
    distanceKm += bestD;
    cur = remaining[best].pickupLocation;
    ordered.push(remaining[best]);
    remaining.splice(best, 1);
  }
  distanceKm += haversineKm(cur.lat, cur.lng, dropLoc.lat, dropLoc.lng);
  return { ordered, distanceKm: Math.round(distanceKm * 100) / 100 };
};

/** Per-km earning with the same config the single-pickup path uses. */
const earningsFor = (distanceKm, config) => {
  const ratePerKm = config.ratePerKm;
  const surge = config.surgeActive ? config.surgeMultiplier : 1;
  const minEarnings = config.minEarnings ?? 15;
  return Math.max(minEarnings, Math.round(Math.max(1, distanceKm) * ratePerKm * surge));
};

/** Rider GeoJSON currentLocation.coordinates [lng,lat] → {lat,lng} (0,0 if missing). */
const riderLatLng = (rider) => {
  const [lng = 0, lat = 0] = rider?.currentLocation?.coordinates || [];
  return { lat, lng };
};

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

const emitToVendor = async (vendorId, event, payload) => {
  try {
    await axios.post(
      `http://localhost:${process.env.PORT_SOCKET || 3010}/internal/emit`,
      { room: `vendor:${vendorId}`, event, payload },
      { timeout: 3000 },
    );
  } catch (err) {
    logger.warn(`Socket emit to vendor ${vendorId} failed: ${err.message}`);
  }
};

const emitToRoom = async (orderId, event, payload) => {
  try {
    await axios.post(
      `http://localhost:${process.env.PORT_SOCKET || 3010}/internal/emit`,
      { room: `order:tracking:${orderId}`, event, payload },
      { timeout: 3000 },
    );
  } catch (err) {
    logger.warn(`Socket emit to tracking room ${orderId} failed: ${err.message}`);
  }
};

/** Call Order Service to update sub-order status (riderId, timestamps, status). */
const syncSubOrderStatus = async (orderId, subOrderId, update) => {
  try {
    await axios.post(
      `http://localhost:${PORT_ORDER}/internal/update-suborder`,
      { orderId: orderId.toString(), subOrderId: subOrderId.toString(), update },
      { timeout: 5000 },
    );
  } catch (err) {
    logger.warn(`syncSubOrderStatus failed for order ${orderId}: ${err.message}`);
  }
};

/** Cancel order in Order Service when no rider is available. */
const autoCancelOrder = async (job) => {
  try {
    await axios.post(
      `http://localhost:${PORT_ORDER}/internal/cancel-order`,
      { orderId: job.orderId.toString(), reason: 'no_rider_available' },
      { timeout: 5000 },
    );
  } catch (err) {
    logger.warn(`autoCancelOrder failed for order ${job.orderId}: ${err.message}`);
  }

  // Also notify customer via socket (in case the internal endpoint didn't)
  await emitToCustomer(job.customerId.toString(), 'order:status', {
    orderId: job.orderId,
    status: 'no_rider_available',
    message: 'No delivery partner was available in time. Please try again in a few minutes.',
  });
  // FCM push is sent by /internal/cancel-order (called above) — no duplicate here.
};

// ── Core logic ────────────────────────────────────────────────────

/**
 * Create a DeliveryJob and offer to nearby riders (single batch, no cascade).
 * Called by the Delivery Service's internal `/internal/assign-rider` endpoint
 * immediately after vendor acceptance.
 */
const initiateRiderAssignment = async ({
  orderId, subOrderId, vendorId, customerId,
  pickupLocation, dropLocation, deliveryFee,
  deliveryInstructions, paymentMethod, totalAmount,
}) => {
  // Fetch current rate config and lock it on this job
  const config = await DeliveryRateConfig.getConfig();
  const ratePerKm = config.ratePerKm;
  const surgeMultiplier = config.surgeActive ? config.surgeMultiplier : 1;

  // Calculate distance between pickup and drop
  const distanceKm = Math.round(
    haversineKm(pickupLocation.lat, pickupLocation.lng, dropLocation.lat, dropLocation.lng) * 100,
  ) / 100; // Round to 2 decimals

  // Earnings = distance × rate × surge, with a guaranteed minimum (locked at assignment time)
  // For distances under 1 km, charge at least 1 km worth (ratePerKm)
  const effectiveDistance = Math.max(1, distanceKm);
  const minEarnings = config.minEarnings ?? 15;
  const riderEarnings = Math.max(minEarnings, Math.round(effectiveDistance * ratePerKm * surgeMultiplier));

  const job = await DeliveryJob.create({
    orderId, subOrderId, vendorId, customerId,
    pickupLocation, dropLocation,
    deliveryFee: deliveryFee || 0,
    deliveryInstructions: deliveryInstructions || '',
    paymentMethod: paymentMethod || 'cod',
    totalAmount: totalAmount || 0,
    riderEarnings,
    ratePerKm,
    surgeMultiplier,
    distanceKm,
    status: DELIVERY_JOB_STATUS.PENDING,
    batchIndex: 0,
  });

  logger.info(`DeliveryJob ${job._id} created for order ${orderId}`);

  // Find up to 3 nearby riders — single batch, no cascade
  const riders = await findNearbyRiders(job.pickupLocation, [], BATCH_SIZE);

  if (riders.length === 0) {
    logger.warn(`No available riders for job ${job._id} — cancelling order`);
    job.status = DELIVERY_JOB_STATUS.FAILED;
    await job.save();
    await autoCancelOrder(job);
    return;
  }

  await offerToRiderBatch(job, riders);
};

/**
 * MR: assign ONE rider to a whole split order (multi-pickup).
 *
 * pickups = [{ vendorId, subOrderId, pickupLocation }], one per accepted sub-order.
 * Creates a single DeliveryJob carrying all stops, then offers it. The rider→first-vendor
 * leg, nearest-first ordering, and per-rider earning are added at offer/accept time in
 * MR-2; here the job's distance/earning is a provisional pickup-side route
 * (stop → stop → … → customer) so nothing is left at zero.
 */
const initiateMultiPickupAssignment = async ({
  orderId, customerId, pickups, dropLocation, deliveryFee,
  deliveryInstructions, paymentMethod, totalAmount,
}) => {
  if (!Array.isArray(pickups) || pickups.length === 0) {
    logger.error(`assign-rider-multi: no pickups for order ${orderId}`);
    return;
  }

  // Dedupe by vendor: a vendor covering multiple categories has several sub-orders at
  // ONE location → ONE physical stop carrying all its subOrderIds (one visit, one OTP).
  const byVendor = new Map();
  for (const p of pickups) {
    const vid = p.vendorId.toString();
    if (!byVendor.has(vid)) byVendor.set(vid, { vendorId: p.vendorId, pickupLocation: p.pickupLocation, subOrderIds: [] });
    byVendor.get(vid).subOrderIds.push(p.subOrderId);
  }
  const stops = [...byVendor.values()];

  const config = await DeliveryRateConfig.getConfig();

  // Provisional distance/earning: stops in claim order → customer (pickup-side legs only;
  // the per-rider route incl. rider→first-stop is computed at offer time & locked on accept).
  let distanceKm = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    distanceKm += haversineKm(
      stops[i].pickupLocation.lat, stops[i].pickupLocation.lng,
      stops[i + 1].pickupLocation.lat, stops[i + 1].pickupLocation.lng,
    );
  }
  const last = stops[stops.length - 1].pickupLocation;
  distanceKm += haversineKm(last.lat, last.lng, dropLocation.lat, dropLocation.lng);
  distanceKm = Math.round(distanceKm * 100) / 100;
  const riderEarnings = earningsFor(distanceKm, config);
  const ratePerKm = config.ratePerKm;
  const surgeMultiplier = config.surgeActive ? config.surgeMultiplier : 1;

  const job = await DeliveryJob.create({
    orderId, customerId,
    // top-level single-pickup requireds satisfied by the first stop (kept for back-compat)
    subOrderId:     stops[0].subOrderIds[0],
    vendorId:       stops[0].vendorId,
    pickupLocation: stops[0].pickupLocation,
    dropLocation,
    pickups: stops.map((s, i) => ({
      vendorId:       s.vendorId,
      subOrderIds:    s.subOrderIds,
      pickupLocation: s.pickupLocation,
      status:         'pending',
      seq:            i,
    })),
    deliveryFee:          deliveryFee || 0,
    deliveryInstructions: deliveryInstructions || '',
    paymentMethod:        paymentMethod || 'cod',
    totalAmount:          totalAmount || 0,
    riderEarnings, ratePerKm, surgeMultiplier, distanceKm,
    status: DELIVERY_JOB_STATUS.PENDING,
    batchIndex: 0,
  });

  logger.info(`Multi-pickup DeliveryJob ${job._id} created for order ${orderId} (${pickups.length} stops)`);

  const riders = await findNearbyRiders(pickups[0].pickupLocation, [], BATCH_SIZE);
  if (riders.length === 0) {
    logger.warn(`No available riders for multi-pickup job ${job._id} — cancelling order`);
    job.status = DELIVERY_JOB_STATUS.FAILED;
    await job.save();
    await autoCancelOrder(job);
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

  // Redis key lives for exactly the offer window — expiry drives timeout
  await redisClient.set(
    jobOfferKey(jobId),
    JSON.stringify({ riderIds, batchIndex: 0 }),
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

  // Multi-pickup: each rider sees THEIR OWN route (nearest-first from where they are) and
  // the earning for that whole trip — so the number shown is what they'll actually get.
  const isMulti = (job.pickups || []).length > 0;
  const config = isMulti ? await DeliveryRateConfig.getConfig() : null;

  for (const rider of riders) {
    const riderId = rider._id.toString();

    let pickupsForRider = job.pickups || [];
    let earnings = job.riderEarnings;
    let distanceKm = job.distanceKm;
    if (isMulti) {
      const stops = job.pickups.map((s) => (s.toObject ? s.toObject() : s));
      const route = computeRouteFrom(riderLatLng(rider), stops, job.dropLocation);
      pickupsForRider = route.ordered.map((s, i) => ({ ...s, seq: i }));
      distanceKm = route.distanceKm;
      earnings = earningsFor(distanceKm, config);
    }

    await emitToRider(riderId, 'job:request', {
      jobId,
      orderId:              job.orderId,
      subOrderId:           job.subOrderId,
      pickupLocation:       job.pickupLocation,
      pickups:              pickupsForRider, // MR: this rider's ordered stops ([] for single-pickup)
      dropLocation:         job.dropLocation,
      earnings,                              // this rider's trip earning
      distanceKm,
      ratePerKm:            job.ratePerKm,
      surgeMultiplier:      job.surgeMultiplier,
      deliveryInstructions: job.deliveryInstructions,
      paymentMethod:        job.paymentMethod || 'cod',
      totalAmount:          job.totalAmount || 0,
      expiresIn:            ASSIGNMENT_TIMEOUT_SEC,
    });
    // FCM push so rider is alerted even if the app is in the background
    triggerNotification('job:request', riderId, 'rider', { jobId, orderId: job.orderId.toString(), expiresIn: ASSIGNMENT_TIMEOUT_SEC });
    logger.info(`Job ${jobId} offered to rider ${riderId}`);
  }
};

/**
 * When the offer window expires with no acceptance, fail the job and cancel order.
 * No cascade — single batch only.
 */
const handleOfferExpiry = async (job) => {
  // Re-fetch to get the freshest state
  job = await DeliveryJob.findById(job._id);
  if (!job || ![DELIVERY_JOB_STATUS.OFFERED, DELIVERY_JOB_STATUS.PENDING].includes(job.status)) return;

  // Notify all offered riders their window has closed
  for (const riderId of job.offeredRiderIds) {
    await emitToRider(riderId.toString(), 'job:expired', { jobId: job._id.toString() });
  }

  // No cascade — fail immediately
  job.status = DELIVERY_JOB_STATUS.FAILED;
  await job.save();

  await autoCancelOrder(job);
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
    // TTL expired — handle expiry in background, reject this accept
    handleOfferExpiry(job).catch((err) => logger.error(`expiry error for job ${jobId}:`, err));
    return { success: false, reason: 'Offer window has expired — you were too slow' };
  }

  const offer = JSON.parse(offerRaw);
  if (!offer.riderIds.includes(riderId)) {
    return { success: false, reason: 'This job was not offered to you' };
  }

  // ── Atomic claim — prevents two riders accepting the same job ──
  // Earnings & distance were locked when the job was created (assignment time).
  // Do NOT recalculate here — just persist the claim and reuse the stored values.
  const pickupOtp = String(Math.floor(1000 + Math.random() * 9000));
  const updateFields = {
    riderId,
    status: DELIVERY_JOB_STATUS.ACCEPTED,
    assignedAt: new Date(),
    pickupOtp,
  };

  const claimed = await DeliveryJob.findOneAndUpdate(
    { _id: jobId, status: DELIVERY_JOB_STATUS.OFFERED },
    { $set: updateFields },
    { new: true },
  );
  if (!claimed) return { success: false, reason: 'Job already taken by another rider' };
  Object.assign(job, claimed.toObject());

  // MR: for a multi-pickup job, LOCK this rider's actual route + earning. The route is the
  // nearest-first order FROM this rider, distance incl. the rider→first-stop leg — the exact
  // trip and pay shown in their offer. (Per-stop pickup OTPs are generated in MR-3.)
  if ((claimed.pickups || []).length > 0) {
    const riderDoc = await Rider.findById(riderId).select('currentLocation').lean();
    const stops = claimed.pickups.map((s) => (s.toObject ? s.toObject() : s));
    const route = computeRouteFrom(riderLatLng(riderDoc), stops, claimed.dropLocation);
    const config = await DeliveryRateConfig.getConfig();
    const distanceKm = route.distanceKm;
    const riderEarnings = earningsFor(distanceKm, config);
    // Order stops nearest-first AND give each its own pickup OTP (one code per vendor visit).
    const orderedPickups = route.ordered.map((s, i) => ({
      ...s, seq: i, status: 'pending', pickedAt: null,
      pickupOtp: String(Math.floor(1000 + Math.random() * 9000)),
    }));
    await DeliveryJob.updateOne({ _id: jobId }, { $set: { pickups: orderedPickups, distanceKm, riderEarnings } });
    Object.assign(job, { pickups: orderedPickups, distanceKm, riderEarnings });
    claimed.pickups = orderedPickups; claimed.distanceKm = distanceKm; claimed.riderEarnings = riderEarnings;

    // One pickup-OTP record per stop (recipientType vendor), so each vendor can show its code.
    for (const stop of orderedPickups) {
      try {
        await DeliveryOtp.create({
          orderId: claimed.orderId, jobId: claimed._id, vendorId: stop.vendorId,
          customerId: claimed.customerId, riderId, type: 'pickup', code: stop.pickupOtp, recipientType: 'vendor',
        });
      } catch (err) { logger.warn(`DeliveryOtp (stop) failed job ${jobId} vendor ${stop.vendorId}: ${err.message}`); }
    }
    logger.info(`Multi-pickup job ${jobId} locked to rider ${riderId}: ${orderedPickups.length} stops, ${distanceKm}km, ₹${riderEarnings}`);
  }

  await redisClient.del(jobOfferKey(jobId));

  // Persist pickup OTP in separate OTP model — SINGLE-pickup jobs only. Multi-pickup jobs
  // got one record per stop above; skip the single one so no bogus vendor OTP is created.
  if ((claimed.pickups || []).length === 0) {
    try {
      await DeliveryOtp.create({
        orderId: job.orderId,
        jobId: job._id,
        vendorId: job.vendorId,
        customerId: job.customerId,
        riderId,
        type: 'pickup',
        code: pickupOtp,
        recipientType: 'vendor',
      });
    } catch (err) {
      logger.warn(`DeliveryOtp create (pickup) failed for job ${jobId}: ${err.message}`);
    }
  }

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
  // Also emit to order tracking room
  await emitToRoom(job.orderId.toString(), 'order:status', {
    orderId: job.orderId, subOrderId: job.subOrderId, status: 'rider_assigned',
    rider: { id: riderId, name: riderDoc?.name, phone: riderDoc?.phone, vehicleType: riderDoc?.vehicleType },
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

  // Inventory is already deducted on vendor accept — no need to deduct again here.

  // Send pickup OTP to vendor (in-app display, not SMS/WhatsApp)
  await emitToVendor(job.vendorId.toString(), 'order:pickup-otp', {
    orderId: job.orderId,
    jobId:   job._id,
    otp:     job.pickupOtp,
    riderName: riderDoc?.name,
  });
  triggerNotification('order:pickup-otp', job.vendorId.toString(), 'vendor', {
    orderId:   job.orderId.toString(),
    otp:       job.pickupOtp,
    riderName: riderDoc?.name,
  });
  notifyVendor(job.vendorId.toString(), 'order:rider_assigned', 'Rider Assigned',
    `Rider ${riderDoc?.name || ''} is heading to pick up order #${job.orderId.toString().slice(-4)}`,
    job.orderId.toString());

  logger.info(`Job ${jobId} assigned to rider ${riderId}, pickup OTP sent to vendor`);
  return { success: true, job };
};

/**
 * Handle a rider explicitly rejecting a delivery job.
 * If all riders in the batch have rejected, fail job and cancel order.
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

  // Check if entire batch has responded (all rejected)
  const offerRaw = await redisClient.get(jobOfferKey(jobId));
  if (!offerRaw) return { success: true }; // TTL expired — sweep will handle it

  const offer = JSON.parse(offerRaw);
  const updatedRejected = job.rejectedRiderIds.map((id) => id.toString());
  const allBatchRejected = offer.riderIds.every((id) => updatedRejected.includes(id));

  if (allBatchRejected) {
    // All riders rejected — no cascade, fail immediately
    await redisClient.del(jobOfferKey(jobId));
    job.status = DELIVERY_JOB_STATUS.FAILED;
    await job.save();
    await autoCancelOrder(job);
  }

  return { success: true };
};

/**
 * Background sweep: find jobs whose offer window expired in Redis (TTL gone)
 * but are still in OFFERED state in MongoDB — fail and cancel for each.
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
      try {
        await handleOfferExpiry(job);
      } catch (err) {
        logger.error(`sweep expiry failed for job ${job._id}:`, err);
      }
    }
  }
};

module.exports = {
  initiateRiderAssignment,
  initiateMultiPickupAssignment,
  handleRiderAccept,
  handleRiderReject,
  sweepExpiredOffers,
  // exported for tests
  computeRouteFrom,
  earningsFor,
  riderLatLng,
};
