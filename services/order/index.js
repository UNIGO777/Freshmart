require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const connectDB = require('../../shared/db/mongoose');
const { connectRedis } = require('../../shared/db/redis');
const orderRoutes = require('./routes/order.routes');
const Order         = require('./models/Order.model');
const Product       = require('../product/models/Product.model');
const Vendor        = require('../user/models/Vendor.model');
const VendorEarning = require('../vendor/models/VendorEarning.model');
const { initiateRouting } = require('./logic/vendorRouter');
const { SUB_ORDER_STATUS, ORDER_STATUS } = require('../../shared/constants/orderStatus');
const logger = require('../../shared/utils/logger');

const app = express();
const PORT = process.env.PORT_ORDER || 3004;

// ── Helper: create VendorEarning when sub-order is delivered ──────
const createVendorEarning = async (order, subOrder) => {
  const vendor = await Vendor.findById(subOrder.vendorId).select('commissionPercent').lean();
  const commissionPercent = vendor?.commissionPercent ?? 10;

  // Gross = sum of (buyingPrice * qty) for items this vendor fulfilled
  const grossAmount = subOrder.items.reduce(
    (sum, item) => sum + (item.buyingPrice ?? 0) * item.quantity,
    0,
  );
  const commissionAmount = Math.round((grossAmount * commissionPercent) / 100);
  const netAmount = grossAmount - commissionAmount;

  // Idempotent: skip if already recorded for this sub-order
  const exists = await VendorEarning.exists({ subOrderId: subOrder._id });
  if (exists) return;

  await VendorEarning.create({
    vendorId:         subOrder.vendorId,
    orderId:          order._id,
    subOrderId:       subOrder._id,
    grossAmount,
    commissionPercent,
    commissionAmount,
    netAmount,
    status:           'pending',
    earningDate:      new Date(),
  });

  logger.info(`VendorEarning created: vendor ${subOrder.vendorId} earned ₹${netAmount} (net) for subOrder ${subOrder._id}`);
};

app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10kb' }));

app.get('/health', (_req, res) => {
  res.json({ success: true, service: 'order', timestamp: new Date().toISOString() });
});

app.use('/', orderRoutes);

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
    const allDelivered  = order.subOrders.every((so) => so.status === SUB_ORDER_STATUS.DELIVERED);
    const someDelivered = order.subOrders.some((so)  => so.status === SUB_ORDER_STATUS.DELIVERED);

    if (allDelivered) {
      order.status = ORDER_STATUS.DELIVERED;
    } else if (someDelivered) {
      order.status = ORDER_STATUS.PARTIALLY_DELIVERED;
    }

    await order.save();

    // When a sub-order transitions to DELIVERED, record vendor earnings
    if (update.status === SUB_ORDER_STATUS.DELIVERED && subOrder.vendorId) {
      createVendorEarning(order, subOrder).catch((err) =>
        logger.error(`createVendorEarning failed for subOrder ${subOrderId}:`, err),
      );
    }

    return res.json({ success: true });
  } catch (err) {
    logger.error('internal/update-suborder error:', err);
    return res.status(500).json({ success: false });
  }
});

app.use((_req, res) => res.status(404).json({ success: false, message: 'Route not found', errorCode: 'NOT_FOUND' }));

app.use((err, _req, res, _next) => {
  logger.error('Unhandled order service error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

Promise.all([connectDB(), connectRedis()]).then(() => {
  app.listen(PORT, () => logger.info(`Order Service running on port ${PORT}`));
});

module.exports = app;
