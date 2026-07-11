require('dotenv').config();
const Vendor = require('../../user/models/Vendor.model');
const Inventory = require('../../vendor/models/Inventory.model');
const { redisClient } = require('../../../shared/db/redis');
const { initCoverageState, getUncoveredItems } = require('./orderSplitter');
const { triggerNotification } = require('../../../shared/utils/notify');
const { notifyVendor } = require('../../../shared/utils/vendorNotify');
const { sendDataOnly } = require('../../../shared/utils/dataPush');
const logger = require('../../../shared/utils/logger');

const BATCH_SIZE = Number(process.env.MAX_VENDOR_ATTEMPTS) || 3;
// How long a vendor has to accept before the batch cascades (seconds)
const VENDOR_OFFER_TTL = Number(process.env.VENDOR_OFFER_TTL_SEC) || 90;

// ── Redis key helpers ─────────────────────────────────────────────
const routingKey = (orderId) => `order:routing:${orderId}`;
const offerKey = (orderId, vendorId) => `order:offer:${orderId}:${vendorId}`;

// ── Emit a socket event to a vendor (via Socket Server HTTP API) ──
const emitToVendor = async (vendorId, event, payload) => {
  try {
    const axios = require('axios');
    const socketUrl = `http://localhost:${process.env.PORT_SOCKET || 3010}`;
    await axios.post(`${socketUrl}/internal/emit`, { room: `vendor:${vendorId}`, event, payload });
  } catch (err) {
    // Non-fatal — vendor will see the order via polling fallback
    logger.warn(`Socket emit to vendor ${vendorId} failed: ${err.message}`);
  }
};

/**
 * Load all eligible vendors for an order, sorted by distance.
 * Filters to vendors who actually have inventory for at least one ordered item.
 *
 * @param {{ lat, lng }} customerLocation
 * @param {string[]} requiredCategories
 * @param {string[]} productIds
 * @returns {Promise<Array>} sorted vendor list
 */
const fetchSortedVendors = async (customerLocation, requiredCategories, productIds) => {
  const { lat, lng } = customerLocation;

  const SEARCH_RADIUS_KM = Number(process.env.VENDOR_SEARCH_RADIUS_KM) || 5;

  const vendors = await Vendor.find({
    isApproved: true,
    isActive: true,
    isOnline: true,
    categories: { $in: requiredCategories },
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: SEARCH_RADIUS_KM * 1000,
      },
    },
  })
    .select('_id businessName location categories fcmToken')
    .lean();

  // Filter: vendor must have live inventory for at least one required product
  const vendorIds = vendors.map((v) => v._id);
  const inventoryRecords = await Inventory.find({
    vendorId: { $in: vendorIds },
    productId: { $in: productIds },
    isAvailable: true,
  }).lean();

  const vendorsWithStock = new Set(inventoryRecords.map((r) => r.vendorId.toString()));
  return vendors.filter((v) => vendorsWithStock.has(v._id.toString()));
};

/**
 * Initialise routing for a newly placed order.
 * Stores routing state in Redis and sends offers to the first batch of vendors.
 *
 * @param {import('../models/Order.model')} order  Mongoose document (will be mutated + saved)
 * @param {{ lat, lng }} customerLocation
 * @param {string[]} productIds
 * @param {string[]} requiredCategories
 */
const initiateRouting = async (order, customerLocation, productIds, requiredCategories) => {
  const orderId = order._id.toString();

  // Fetch all eligible vendors sorted by distance
  const sortedVendors = await fetchSortedVendors(customerLocation, requiredCategories, productIds);

  if (sortedVendors.length === 0) {
    logger.warn(`No eligible vendors for order ${orderId}`);
    order.status = 'failed';
    order.cancelReason = 'no_vendors_available';
    await order.save();
    return { success: false, reason: 'no_vendors_available' };
  }

  // Persist full vendor list in routing metadata
  order.routingMeta.allVendorIds = sortedVendors.map((v) => v._id);
  order.routingMeta.batchIndex = 0;
  await order.save();

  // Store routing state in Redis
  const routingState = {
    orderId,
    batchIndex: 0,
    allVendorIds: sortedVendors.map((v) => v._id.toString()),
    coverageState: initCoverageState(
      order.items.map((i) => ({
        productId: i.productId.toString(),
        quantity: i.quantity,
        sellingPrice: i.sellingPrice,
        buyingPrice: i.buyingPrice || 0,
        category: i.category || '',
      })),
    ),
    respondedVendorIds: [],
  };

  await redisClient.set(routingKey(orderId), JSON.stringify(routingState), { EX: 3600 });

  // Offer to first batch
  await offerToBatch(order, sortedVendors, 0);

  return { success: true };
};

/**
 * Send order offers to a batch of vendors (up to BATCH_SIZE).
 *
 * @param {import('../models/Order.model')} order
 * @param {Array} sortedVendors
 * @param {number} batchIndex
 */
const offerToBatch = async (order, sortedVendors, batchIndex) => {
  const orderId = order._id.toString();
  const start = batchIndex * BATCH_SIZE;
  const batch = sortedVendors.slice(start, start + BATCH_SIZE);

  if (batch.length === 0) return;

  // Append new batch to offeredVendorIds (don't replace — vendors from previous
  // batches may still attempt a late accept, and the incoming-orders query
  // filters by this array so their ID must remain present).
  const newIds = batch.map((v) => v._id.toString());
  const existing = order.routingMeta.offeredVendorIds.map((id) => id.toString());
  const merged = [...new Set([...existing, ...newIds])];
  order.routingMeta.offeredVendorIds = merged;
  order.routingMeta.batchIndex = batchIndex;
  await order.save();

  // Build per-vendor inventory context
  const batchVendorIds = batch.map((v) => v._id);
  const productIds = order.items.map((i) => i.productId.toString());
  const inventoryRecords = await Inventory.find({
    vendorId: { $in: batchVendorIds },
    productId: { $in: productIds },
    isAvailable: true,
  }).lean();

  const invSet = {};
  for (const rec of inventoryRecords) {
    const vid = rec.vendorId.toString();
    if (!invSet[vid]) invSet[vid] = new Set();
    invSet[vid].add(rec.productId.toString());
  }

  for (const vendor of batch) {
    const vid = vendor._id.toString();

    const inventoryContext = order.items.map((item) => {
      const hasProduct = invSet[vid]?.has(item.productId.toString()) ?? false;
      return {
        productId: item.productId,
        name: item.name,
        orderedQty: item.quantity,
        availableQty: item.quantity,
        extraNeeded: 0,
        inStock: hasProduct,
      };
    });

    // Set per-vendor offer TTL in Redis
    await redisClient.set(offerKey(orderId, vid), '1', { EX: VENDOR_OFFER_TTL });

    // Emit socket event so vendor app receives the order in real-time
    await emitToVendor(vid, 'order:incoming', {
      orderId,
      items: order.items,
      deliveryAddress: order.deliveryAddress,
      deliveryInstructions: order.deliveryInstructions || '',
      inventoryContext,
      expiresIn: VENDOR_OFFER_TTL,
    });

    // DATA-ONLY high-priority FCM push — wakes a killed app so the phone-off siren
    // can fire. NO notification block (that would consume the message in the OS tray
    // and skip setBackgroundMessageHandler). Ring window = the offer TTL.
    const expiresAt = Date.now() + VENDOR_OFFER_TTL * 1000;
    sendDataOnly(vendor.fcmToken, { type: 'NEW_ORDER', orderId, expiresAt }, { ttlSec: VENDOR_OFFER_TTL });

    // In-app notification record (vendor notifications list) — not an FCM push.
    notifyVendor(vid, 'order:incoming', 'New Order Received',
      `New order #${orderId.slice(-4)} with ${order.items.length} item(s)`,
      orderId);

    logger.info(`Order ${orderId} offered to vendor ${vid} (batch ${batchIndex})`);
  }
};

/**
 * Handle a vendor's rejection (or TTL expiry).
 * If all vendors in the current batch have responded without covering items,
 * cascade to the next batch.
 *
 * @param {import('../models/Order.model')} order  Fetched fresh before calling.
 * @param {string} vendorId
 */
const handleVendorResponse = async (order, vendorId) => {
  const orderId = order._id.toString();
  const rawState = await redisClient.get(routingKey(orderId));
  if (!rawState) {
    logger.warn(`No routing state for order ${orderId}`);
    return;
  }

  const routingState = JSON.parse(rawState);
  if (!routingState.respondedVendorIds.includes(vendorId)) {
    routingState.respondedVendorIds.push(vendorId);
  }

  const currentBatchStart = routingState.batchIndex * BATCH_SIZE;
  const currentBatch = routingState.allVendorIds.slice(currentBatchStart, currentBatchStart + BATCH_SIZE);

  // Check if all vendors in this batch have responded
  const allBatchResponded = currentBatch.every((vid) => routingState.respondedVendorIds.includes(vid));

  // Check if any items still uncovered
  const uncovered = getUncoveredItems(routingState.coverageState);

  if (uncovered.length === 0) {
    // All items covered — nothing to cascade
    await redisClient.set(routingKey(orderId), JSON.stringify(routingState), { EX: 3600 });
    return;
  }

  if (allBatchResponded) {
    // Cascade to next batch
    const nextBatchIndex = routingState.batchIndex + 1;
    const nextBatchStart = nextBatchIndex * BATCH_SIZE;

    if (nextBatchStart >= routingState.allVendorIds.length) {
      // No more vendors — mark order as failed
      logger.warn(`Order ${orderId} failed — no vendors could cover all items`);
      order.status = 'failed';
      order.cancelReason = 'no_vendor_coverage';
      await order.save();
      await redisClient.del(routingKey(orderId));

      await emitToCustomer(order.customerId.toString(), 'order:failed', {
        orderId,
        reason: 'No vendor could fulfil your order. Please try again.',
      });
      triggerNotification('order:failed', order.customerId.toString(), 'customer', {
        orderId,
        reason: 'No vendor could fulfil your order. Please try again.',
      });
      return;
    }

    // Fetch vendors for next batch
    const nextBatchVendorIds = routingState.allVendorIds.slice(nextBatchStart, nextBatchStart + BATCH_SIZE);
    const nextVendors = await Vendor.find({ _id: { $in: nextBatchVendorIds } })
      .select('_id businessName location categories fcmToken')
      .lean();

    routingState.batchIndex = nextBatchIndex;
    await redisClient.set(routingKey(orderId), JSON.stringify(routingState), { EX: 3600 });
    await offerToBatch(order, nextVendors, nextBatchIndex);
  } else {
    await redisClient.set(routingKey(orderId), JSON.stringify(routingState), { EX: 3600 });
  }
};

/**
 * Apply a vendor acceptance to the routing state and return updated coverage.
 *
 * @param {string} orderId
 * @param {string} vendorId
 * @param {Array<{ productId, quantity }>} acceptedItems
 * @returns {Promise<{ allCovered: boolean, coverageState: Object }>}
 */
const recordVendorAcceptance = async (orderId, vendorId, acceptedItems) => {
  const rawState = await redisClient.get(routingKey(orderId));
  if (!rawState) return { allCovered: false, coverageState: {} };

  const routingState = JSON.parse(rawState);
  const { applyVendorAcceptance } = require('./orderSplitter');
  const { allCovered, coverageState } = applyVendorAcceptance(
    routingState.coverageState,
    vendorId,
    acceptedItems,
  );

  routingState.coverageState = coverageState;
  if (!routingState.respondedVendorIds.includes(vendorId)) {
    routingState.respondedVendorIds.push(vendorId);
  }

  await redisClient.set(routingKey(orderId), JSON.stringify(routingState), { EX: 3600 });
  return { allCovered, coverageState };
};

/**
 * Clean up routing state from Redis once order is confirmed or failed.
 */
const clearRoutingState = async (orderId) => {
  await redisClient.del(routingKey(orderId.toString()));
};

// ── Emit socket event to customer ────────────────────────────────
const emitToCustomer = async (customerId, event, payload) => {
  try {
    const axios = require('axios');
    const socketUrl = `http://localhost:${process.env.PORT_SOCKET || 3010}`;
    await axios.post(`${socketUrl}/internal/emit`, { room: `customer:${customerId}`, event, payload });
  } catch (err) {
    logger.warn(`Socket emit to customer ${customerId} failed: ${err.message}`);
  }
};

/**
 * Find closest online vendor with inventory for at least one ordered item.
 * Returns vendor(s) with inventoryContext for each item.
 *
 * @param {{ lat, lng }} customerLocation
 * @param {Array<{ productId, quantity, name }>} orderItems
 * @returns {Promise<Array>} vendors with inventoryContext
 */
const findEligibleVendor = async (customerLocation, orderItems) => {
  const { lat, lng } = customerLocation;
  const productIds = orderItems.map((i) => i.productId);

  const vendors = await Vendor.find({
    isApproved: true,
    isActive: true,
    isOnline: true,
    location: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: 5000,
      },
    },
  })
    .select('_id businessName location categories fcmToken')
    .lean();

  if (vendors.length === 0) return [];

  const vendorIds = vendors.map((v) => v._id);
  const inventory = await Inventory.find({
    vendorId: { $in: vendorIds },
    productId: { $in: productIds },
    isAvailable: true,
  }).lean();

  const invSet = {};
  for (const rec of inventory) {
    const vid = rec.vendorId.toString();
    if (!invSet[vid]) invSet[vid] = new Set();
    invSet[vid].add(rec.productId.toString());
  }

  return vendors
    .filter((v) => invSet[v._id.toString()] && invSet[v._id.toString()].size > 0)
    .map((v) => ({
      ...v,
      inventoryContext: orderItems.map((item) => {
        const hasProduct = invSet[v._id.toString()]?.has(item.productId.toString()) ?? false;
        return {
          productId: item.productId,
          name: item.name,
          orderedQty: item.quantity,
          availableQty: item.quantity,
          extraNeeded: 0,
          inStock: hasProduct,
        };
      }),
    }));
};

/**
 * Eligible vendors for ONE category-group (M0 multi-vendor split).
 *
 * A vendor qualifies only if ALL of these hold:
 *   - approved, active, ONLINE, within 5km ($nearSphere, nearest first),
 *   - declares the group's category,
 *   - stocks EVERY item in the group with a REAL quantity — quantityAvailable
 *     >= the ordered quantity (not the manual isAvailable flag, which a vendor
 *     can leave on with zero stock).
 * This "has the whole group" guarantee is what lets a vendor claim the group
 * all-or-nothing (see logic/orderGrouping.js claimGroup/markGroupClaimed).
 *
 * @param {{lat,lng}} customerLocation
 * @param {{ category, items:[{productId, quantity}] }} group
 * @param {number} cap  max vendors to offer per group (default 3)
 * @returns {Promise<Array>}  up to `cap` vendor docs (with fcmToken), nearest first
 */
const findEligibleVendorsForGroup = async (customerLocation, group, cap = 3) => {
  const { lat, lng } = customerLocation;
  const productIds = group.items.map((i) => i.productId);

  const vendors = await Vendor.find({
    isApproved: true,
    isActive: true,
    isOnline: true,
    categories: group.category,
    location: {
      $nearSphere: { $geometry: { type: 'Point', coordinates: [lng, lat] }, $maxDistance: 5000 },
    },
  })
    .select('_id businessName location categories fcmToken')
    .lean();

  if (vendors.length === 0) return [];

  const vendorIds = vendors.map((v) => v._id);
  const inventory = await Inventory.find({
    vendorId: { $in: vendorIds },
    productId: { $in: productIds },
    isAvailable: true,
    quantityAvailable: { $gt: 0 },
  }).lean();

  // vendorId -> { productId -> quantityAvailable }
  const invMap = {};
  for (const rec of inventory) {
    const vid = rec.vendorId.toString();
    (invMap[vid] = invMap[vid] || {})[rec.productId.toString()] = rec.quantityAvailable;
  }

  const eligible = vendors.filter((v) => {
    const vm = invMap[v._id.toString()];
    if (!vm) return false;
    // must have EVERY group item in enough quantity
    return group.items.every((it) => (vm[it.productId.toString()] || 0) >= it.quantity);
  });

  return eligible.slice(0, cap); // already sorted nearest-first by $nearSphere
};

module.exports = {
  initiateRouting,
  handleVendorResponse,
  recordVendorAcceptance,
  clearRoutingState,
  emitToCustomer,
  emitToVendor,
  findEligibleVendor,
  findEligibleVendorsForGroup,
};
