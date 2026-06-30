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
const Inventory = require('../vendor/models/Inventory.model');
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

  logger.info(`VendorEarning created: vendor ${subOrder.vendorId} payout ₹${netAmount}, margin ₹${marginAmount} for subOrder ${subOrder._id}`);
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
    if (update.pickedAt)         subOrder.pickedAt         = new Date(update.pickedAt);
    if (update.deliveredAt)      subOrder.deliveredAt      = new Date(update.deliveredAt);

    // Promote top-level order status based on sub-order states
    const prevStatus = order.status;
    const terminalStatuses = [SUB_ORDER_STATUS.DELIVERED, 'failed', 'cancelled'];
    const allDelivered  = order.subOrders.every((so) => so.status === SUB_ORDER_STATUS.DELIVERED);
    const someDelivered = order.subOrders.some((so)  => so.status === SUB_ORDER_STATUS.DELIVERED);
    const allTerminal   = order.subOrders.every((so) => terminalStatuses.includes(so.status));
    const allFailed     = order.subOrders.every((so) => so.status === 'failed' || so.status === 'cancelled');
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

    // If parent order status changed, notify customer + tracking room via socket
    if (order.status !== prevStatus) {
      const customerId = order.customerId?.toString();
      const oid = order._id.toString();

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

// ── Internal: deduct inventory (called by Delivery Service when rider accepts) ─
app.post('/internal/deduct-inventory', async (req, res) => {
  try {
    const { orderId, vendorId } = req.body;
    if (!orderId || !vendorId) {
      return res.status(400).json({ success: false, message: 'orderId, vendorId required' });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    const outOfStockItems = [];
    for (const item of order.items) {
      try {
        const inv = await Inventory.findOneAndUpdate(
          { vendorId, productId: item.productId, quantityAvailable: { $gte: item.quantity } },
          { $inc: { quantityAvailable: -item.quantity } },
          { new: true },
        );
        if (!inv) {
          outOfStockItems.push(item.productId);
          logger.warn(`Insufficient stock for product ${item.productId} (vendor ${vendorId})`);
        } else if (inv.quantityAvailable <= 0) {
          inv.isAvailable = false;
          await inv.save();
        }
      } catch (invErr) {
        logger.warn(`Inventory deduction failed for product ${item.productId}: ${invErr.message}`);
      }
    }
    if (outOfStockItems.length > 0) {
      logger.warn(`Order ${orderId}: ${outOfStockItems.length} item(s) had insufficient stock`);
    }

    logger.info(`Inventory deducted for order ${orderId}, vendor ${vendorId}`);
    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/deduct-inventory error:', err);
    return res.status(500).json({ success: false });
  }
});

// ── Internal: restore stock (called on order cancel / rider cancel) ─
app.post('/internal/restore-stock', async (req, res) => {
  try {
    const { orderId, vendorId } = req.body;
    if (!orderId || !vendorId) {
      return res.status(400).json({ success: false, message: 'orderId, vendorId required' });
    }

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    for (const item of order.items) {
      await Inventory.findOneAndUpdate(
        { vendorId, productId: item.productId },
        {
          $inc: { quantityAvailable: item.quantity },
          $set: { isAvailable: true },
        },
      );
    }

    logger.info(`Stock restored for order ${orderId}, vendor ${vendorId}`);
    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/restore-stock error:', err);
    return res.status(500).json({ success: false });
  }
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

    logger.info(`VendorEarning reversed for subOrder ${subOrderId}: ${reason}`);
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

Promise.all([connectDB(), connectRedis()]).then(() => {
  app.listen(PORT, () => {
    logger.info(`Order Service running on port ${PORT}`);
    resumeStuckOrders();
  });
});

module.exports = app;
