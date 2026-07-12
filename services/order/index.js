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
const { connectRedis } = require('../../shared/db/redis');
const orderRoutes = require('./routes/order.routes');
const { authenticate } = require('../../gateway/middleware/auth.middleware');
const Order         = require('./models/Order.model');
const VendorEarning = require('../vendor/models/VendorEarning.model');
const { initiateRouting } = require('./logic/vendorRouter');
const { SUB_ORDER_STATUS, ORDER_STATUS } = require('../../shared/constants/orderStatus');
const VendorWallet = require('../vendor/models/VendorWallet.model');
const { notifyVendor } = require('../../shared/utils/vendorNotify');
const logger = require('../../shared/utils/logger');
const axios  = require('axios');

const SOCKET_URL = `http://localhost:${process.env.PORT_SOCKET || 3010}`;

/** Emit a socket event to a room via the Socket Service */
const emitToRoom = (room, event, payload) => {
  axios
    .post(`${SOCKET_URL}/internal/emit`, { room, event, payload }, { timeout: 3000 })
    .catch((err) => logger.warn(`emitToRoom(${room}, ${event}) failed: ${err.message}`));
};

const app = express();
const PORT = process.env.PORT_ORDER || 3004;

// ── Helper: create VendorEarning for a sub-order ─────────────────
const createVendorEarning = async (order, subOrder) => {
  // Payout to vendor = sum of buyingPrice * qty for fulfilled items.
  const netAmount = subOrder.items.reduce(
    (sum, item) => sum + (item.buyingPrice ?? 0) * item.quantity,
    0,
  );
  const salesAmount = subOrder.items.reduce(
    (sum, item) => sum + (item.sellingPrice ?? 0) * item.quantity,
    0,
  );
  const marginAmount = Math.max(0, salesAmount - netAmount);

  // Idempotent: skip if already recorded for this sub-order
  const exists = await VendorEarning.exists({ subOrderId: subOrder._id });
  if (exists) return;

  await VendorEarning.create({
    vendorId:         subOrder.vendorId,
    orderId:          order._id,
    subOrderId:       subOrder._id,
    salesAmount,
    netAmount,
    marginAmount,
    status:           'pending',
    earningDate:      new Date(),
  });

  // Credit vendor wallet with the buying-price amount
  const updatedWallet = await VendorWallet.findOneAndUpdate(
    { vendorId: subOrder.vendorId },
    {
      $inc: { balance: netAmount, totalEarned: netAmount },
      $setOnInsert: { vendorId: subOrder.vendorId },
    },
    { upsert: true, new: true },
  );

  // Notify vendor in real-time
  emitToRoom(`vendor:${subOrder.vendorId}`, 'vendor:wallet-update', {
    balance: updatedWallet.balance,
    totalEarned: updatedWallet.totalEarned,
    totalDeductions: updatedWallet.totalDeductions,
    credited: netAmount,
    orderId: order._id.toString(),
  });

  notifyVendor(subOrder.vendorId.toString(), 'wallet:credited', 'Earning Added',
    `₹${netAmount} credited for order #${order._id.toString().slice(-4)}`,
    order._id.toString());

  logger.info(`VendorEarning created & wallet credited: vendor ${subOrder.vendorId} payout ₹${netAmount}, margin ₹${marginAmount} for subOrder ${subOrder._id}`);
};

app.use(helmet());
app.use(cors());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'order', timestamp: new Date().toISOString() });
});

// ── Internal: cancel order (called by Delivery Service when no rider) ─
const { internalCancelOrder } = require('./controllers/order.controller');
app.post('/internal/cancel-order', internalCancelOrder);

// ── Internal: cancel order status only (rider cancel after pickup) ─
// Only updates status + notifies customer. Inventory/earnings handled when rider returns.
app.post('/internal/cancel-order-status', async (req, res) => {
  try {
    const { orderId, reason } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId required' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if ([ORDER_STATUS.CANCELLED, ORDER_STATUS.DELIVERED].includes(order.status)) {
      return res.json({ success: true, message: 'Order already in terminal state' });
    }

    order.status = ORDER_STATUS.CANCELLED;
    order.cancelledAt = new Date();
    order.cancelReason = reason || 'rider_cancelled_after_pickup';
    await order.save();

    // Release coupon if used
    if (order.couponCode) {
      const { releaseCouponByCode } = require('./logic/couponEngine');
      releaseCouponByCode(order.couponCode, order.customerId).catch((err) =>
        logger.error('releaseCoupon error:', err),
      );
    }

    // Trigger refund
    if (order.paymentStatus === 'paid') {
      axios.post(
        `http://localhost:${process.env.PORT_PAYMENT || 3007}/internal/refund-by-order`,
        { orderId: order._id.toString() },
        { timeout: 5000 },
      ).catch((err) => logger.error(`Refund trigger failed for order ${orderId}: ${err.message}`));
    }

    // Notify customer via socket
    const cancelPayload = {
      orderId: order._id.toString(),
      status: 'cancelled',
      message: 'Your order has been cancelled. Refund will be processed shortly.',
    };
    emitToRoom(`customer:${order.customerId}`, 'order:status', cancelPayload);
    emitToRoom(`order:tracking:${order._id}`, 'order:status', cancelPayload);

    logger.info(`Order ${orderId} status cancelled (rider cancel after pickup): ${reason}`);
    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/cancel-order-status error:', err);
    return res.status(500).json({ success: false });
  }
});

// ── Internal: mark order as paid (COD collected by rider at delivery) ─
app.post('/internal/mark-paid', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId required' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    if (order.paymentStatus === 'paid') {
      return res.json({ success: true, message: 'Already paid' });
    }

    order.paymentStatus = 'paid';
    await order.save();

    emitToRoom(`customer:${order.customerId}`, 'order:payment-status', {
      orderId: order._id.toString(), paymentStatus: 'paid',
    });
    emitToRoom(`order:tracking:${order._id}`, 'order:payment-status', {
      orderId: order._id.toString(), paymentStatus: 'paid',
    });

    logger.info(`Order ${orderId} marked as paid (COD collected)`);
    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/mark-paid error:', err);
    return res.status(500).json({ success: false });
  }
});

// ── Internal endpoint — called by Payment Service after UPI success ─
// Not exposed through gateway; only reachable service-to-service.
app.post('/internal/start-routing', async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false });

    const productIds = order.items.map((i) => i.productId.toString());
    const requiredCategories = [...new Set(order.items.map((i) => i.category).filter(Boolean))];

    // Non-blocking — fire and forget; routing state tracked in Redis
    initiateRouting(order, order.deliveryAddress, productIds, requiredCategories).catch((err) =>
      logger.error(`start-routing failed for order ${orderId}:`, err),
    );

    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/start-routing error:', err);
    return res.status(500).json({ success: false });
  }
});

// ── Internal: update sub-order status (called by Delivery Service) ─
// POST /internal/update-suborder
// Body: { orderId, subOrderId, update: { status, riderId?, riderAssignedAt?, pickedAt?, deliveredAt? } }
app.post('/internal/update-suborder', async (req, res) => {
  try {
    const { orderId, subOrderId, update } = req.body;
    if (!orderId || !subOrderId || !update) {
      return res.status(400).json({ success: false, message: 'orderId, subOrderId, update required' });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const subOrder = order.subOrders.id(subOrderId);
    if (!subOrder) return res.status(404).json({ success: false, message: 'Sub-order not found' });

    if (update.riderId)          subOrder.riderId          = update.riderId;
    if (update.status)           subOrder.status           = update.status;
    if (update.riderAssignedAt)  subOrder.riderAssignedAt  = new Date(update.riderAssignedAt);
    // Advance the fulfillment stage as the sub-order progresses.
    if (update.status === SUB_ORDER_STATUS.RIDER_ASSIGNED) { order.stage = 'assigned'; order.stageDeadline = null; }
    if ([SUB_ORDER_STATUS.PICKED, SUB_ORDER_STATUS.DELIVERED].includes(update.status)) { order.stage = null; order.stageDeadline = null; }
    if (update.pickedAt)         subOrder.pickedAt         = new Date(update.pickedAt);
    if (update.deliveredAt)      subOrder.deliveredAt      = new Date(update.deliveredAt);
    // Payment status (e.g. COD collected on delivery) — set on the parent order
    if (update.paymentStatus)    order.paymentStatus       = update.paymentStatus;

    // Promote top-level order status based on sub-order states
    const prevStatus = order.status;
    const terminalStatuses = [SUB_ORDER_STATUS.DELIVERED, 'failed', 'cancelled', 'returned'];
    const allDelivered  = order.subOrders.every((so) => so.status === SUB_ORDER_STATUS.DELIVERED);
    const someDelivered = order.subOrders.some((so)  => so.status === SUB_ORDER_STATUS.DELIVERED);
    const allTerminal   = order.subOrders.every((so) => terminalStatuses.includes(so.status));
    const allFailed     = order.subOrders.every((so) => ['failed', 'cancelled', 'returned'].includes(so.status));
    const anyPicked     = order.subOrders.some((so)  => so.status === SUB_ORDER_STATUS.PICKED);

    if (allDelivered) {
      order.status = ORDER_STATUS.DELIVERED;
    } else if (allFailed) {
      order.status = ORDER_STATUS.CANCELLED;
    } else if (someDelivered && allTerminal) {
      order.status = ORDER_STATUS.PARTIALLY_DELIVERED;
    } else if (someDelivered) {
      order.status = ORDER_STATUS.PARTIALLY_DELIVERED;
    } else if (anyPicked) {
      order.status = ORDER_STATUS.ON_THE_WAY;
    }

    await order.save();

    const customerId = order.customerId?.toString();
    const oid = order._id.toString();

    // Payment status flipped (e.g. COD collected on delivery) — flip the badge live.
    if (update.paymentStatus) {
      const payPayload = { orderId: oid, paymentStatus: order.paymentStatus };
      if (customerId) emitToRoom(`customer:${customerId}`, 'order:payment-status', payPayload);
      emitToRoom(`order:tracking:${oid}`, 'order:payment-status', payPayload);
    }

    // If parent order status changed, notify customer + tracking room via socket
    if (order.status !== prevStatus) {
      if (customerId) {
        emitToRoom(`customer:${customerId}`, 'order:status', {
          orderId: oid, status: order.status,
        });
      }
      emitToRoom(`order:tracking:${oid}`, 'order:status', {
        orderId: oid, status: order.status,
      });

      logger.info(`Parent order ${oid} promoted to ${order.status} — socket events emitted`);
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/update-suborder error:', err);
    return res.status(500).json({ success: false });
  }
});

// ── Internal: create vendor earning (called by Delivery Service at pickup) ─
app.post('/internal/vendor-earning', async (req, res) => {
  try {
    const { orderId, subOrderId, vendorId } = req.body;
    if (!orderId || !subOrderId || !vendorId) {
      return res.status(400).json({ success: false, message: 'orderId, subOrderId, vendorId required' });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const subOrder = order.subOrders.id(subOrderId);
    if (!subOrder) return res.status(404).json({ success: false, message: 'Sub-order not found' });

    await createVendorEarning(order, subOrder);
    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/vendor-earning error:', err);
    return res.status(500).json({ success: false });
  }
});

// ── Internal: deduct inventory (no-op — quantity tracking removed) ─
app.post('/internal/deduct-inventory', async (_req, res) => {
  return res.json({ success: true });
});

// ── Internal: restore stock (no-op — quantity tracking removed) ─
app.post('/internal/restore-stock', async (_req, res) => {
  return res.json({ success: true });
});

// ── Internal: reverse vendor earning (called on rider cancel after pickup) ─
app.post('/internal/reverse-vendor-earning', async (req, res) => {
  try {
    const { orderId, subOrderId, reason } = req.body;
    if (!orderId || !subOrderId) {
      return res.status(400).json({ success: false, message: 'orderId, subOrderId required' });
    }

    const earning = await VendorEarning.findOne({ orderId, subOrderId, status: 'pending' });
    if (!earning) return res.json({ success: true, message: 'No pending earning to reverse' });

    earning.status = 'reversed';
    earning.reversedAt = new Date();
    earning.reverseReason = reason || 'rider_cancelled';
    await earning.save();

    // Deduct the credited amount from vendor wallet (guard against going negative)
    let walletAfter = await VendorWallet.findOneAndUpdate(
      { vendorId: earning.vendorId, balance: { $gte: earning.netAmount } },
      { $inc: { balance: -earning.netAmount, totalDeductions: earning.netAmount } },
      { new: true },
    );
    if (!walletAfter) {
      // Balance too low — clamp to zero instead
      const wallet = await VendorWallet.findOne({ vendorId: earning.vendorId });
      if (wallet && wallet.balance > 0) {
        wallet.balance = 0;
        wallet.totalDeductions += earning.netAmount;
        await wallet.save();
        walletAfter = wallet;
      } else if (wallet) {
        walletAfter = wallet; // already zero — still emit for a consistent live view
      }
    }

    // Notify vendor in real-time (fires whether the atomic deduct or the clamp path ran)
    if (walletAfter) {
      emitToRoom(`vendor:${earning.vendorId}`, 'vendor:wallet-update', {
        balance: walletAfter.balance,
        totalEarned: walletAfter.totalEarned,
        totalDeductions: walletAfter.totalDeductions,
        debited: earning.netAmount,
        orderId,
        reason,
      });
    }

    notifyVendor(earning.vendorId.toString(), 'wallet:debited', 'Earning Reversed',
      `₹${earning.netAmount} deducted for order #${(orderId || '').slice(-4)} (${reason || 'returned'})`,
      orderId);

    logger.info(`VendorEarning reversed & wallet debited ₹${earning.netAmount} for vendor ${earning.vendorId}, subOrder ${subOrderId}: ${reason}`);
    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/reverse-vendor-earning error:', err);
    return res.status(500).json({ success: false });
  }
});

// ── Internal: check if vendor has active orders ─
app.get('/internal/vendor-has-active-orders/:vendorId', async (req, res) => {
  try {
    const { vendorId } = req.params;
    const activeSubStatuses = [SUB_ORDER_STATUS.VENDOR_ACCEPTED, SUB_ORDER_STATUS.RIDER_ASSIGNED, SUB_ORDER_STATUS.PICKED];
    const count = await Order.countDocuments({
      'subOrders.vendorId': vendorId,
      'subOrders.status': { $in: activeSubStatuses },
    });
    return res.json({ success: true, hasActive: count > 0, count });
  } catch (err) {
    logger.error('internal/vendor-has-active-orders error:', err);
    return res.status(500).json({ success: false });
  }
});

// Authenticated customer/vendor order routes (MUST be after /internal/* routes)
app.use('/', authenticate, orderRoutes);

app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found', errorCode: 'NOT_FOUND' }));

app.use((err, _req, res, _next) => {
  logger.error('Unhandled order service error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ── Startup recovery: resume routing for orders stuck mid-routing ─
// If the Order Service crashed while vendors were being offered a batch,
// Redis state is gone but the order is still in 'confirmed' with non-empty
// offeredVendorIds. Re-trigger routing for each such order.
const resumeStuckOrders = async () => {
  try {
    const stuckOrders = await Order.find({
      status: { $in: [ORDER_STATUS.CONFIRMED, ORDER_STATUS.AWAITING_PAYMENT] },
      'routingMeta.offeredVendorIds.0': { $exists: true },
    }).lean();

    if (stuckOrders.length === 0) return;

    logger.info(`[recovery] Found ${stuckOrders.length} orders stuck mid-routing — resuming`);
    for (const o of stuckOrders) {
      const order = await Order.findById(o._id);
      const productIds      = order.items.map((i) => i.productId.toString());
      const requiredCategories = [...new Set(order.items.map((i) => i.category).filter(Boolean))];
      initiateRouting(order, order.deliveryAddress, productIds, requiredCategories)
        .catch((err) => logger.error(`[recovery] Routing failed for order ${o._id}:`, err));
    }
  } catch (err) {
    logger.error('[recovery] resumeStuckOrders error:', err);
  }
};

// ── Auto-cancel orders that no vendor accepted in time ────────────
// The parent order stays in 'confirmed' with NO sub-orders until a vendor
// accepts. If none accepts within the offer window, the order would otherwise
// hang forever. Sweep every 15s and cancel any that have aged past the window,
// telling the customer to try again.
const VENDOR_OFFER_TTL_SEC = Number(process.env.VENDOR_OFFER_TTL_SEC) || 90;

const sweepUnacceptedOrders = async () => {
  try {
    const now = new Date();
    const legacyCutoff = new Date(Date.now() - VENDOR_OFFER_TTL_SEC * 1000);
    const stale = await Order.find({
      status: ORDER_STATUS.CONFIRMED,
      $or: [
        // Split model (all-or-nothing): ANY category-group still open past its deadline —
        // whether nobody accepted or only SOME parts did — fails the whole order.
        { 'routingMeta.groups': { $elemMatch: { status: 'open', deadline: { $lt: now } } } },
        // Legacy orders (no groups): no vendor accepted within the window.
        { 'routingMeta.groups': { $exists: false }, 'subOrders.0': { $exists: false }, createdAt: { $lt: legacyCutoff } },
        { 'routingMeta.groups': { $size: 0 },       'subOrders.0': { $exists: false }, createdAt: { $lt: legacyCutoff } },
      ],
    }).select('_id customerId routingMeta.groups').lean();

    for (const o of stale) {
      const orderId = o._id.toString();
      // "partial" = at least one part was accepted but another timed out (all-or-nothing fail).
      const partial = (o.routingMeta?.groups || []).some((g) => g.status === 'claimed');
      const reason = partial ? 'part_unfilled' : 'no_vendor_response';
      const status = partial ? 'failed' : 'no_vendor_response';
      const msg = partial
        ? 'Some items in your order were unavailable, so the whole order was cancelled. Please try again.'
        : 'No store accepted your order in time. Please try again in a few minutes.';
      logger.info(`[sweep] failing order ${orderId} (${reason}) — an unfilled part passed its window`);

      // Tell the customer first — drives the "please try again" popup before the cancel lands.
      emitToRoom(`customer:${o.customerId.toString()}`, 'order:status', { orderId, status, message: msg });
      emitToRoom(`order:tracking:${orderId}`, 'order:status', { orderId, status, message: msg });

      try {
        // internalCancelOrder cancels the order, marks every accepted sub-order FAILED,
        // restores that vendor's stock, releases the coupon, refunds, and notifies the customer.
        await axios.post(
          `http://localhost:${PORT}/internal/cancel-order`,
          { orderId, reason },
          { timeout: 5000 },
        );
      } catch (err) {
        logger.error(`[sweep] cancel-order failed for ${orderId}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error('[sweep] sweepUnacceptedOrders error:', err);
  }
};

Promise.all([connectDB(), connectRedis()]).then(() => {
  app.listen(PORT, () => {
    logger.info(`Order Service running on port ${PORT}`);
    resumeStuckOrders();
    setInterval(sweepUnacceptedOrders, 15000);
  });
});

module.exports = app;
