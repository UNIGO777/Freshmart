const Order = require('../../order/models/Order.model');
const { ORDER_STATUS } = require('../../../shared/constants/orderStatus');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// ── GET /orders ───────────────────────────────────────────────────
// All orders with optional filters: status, paymentMethod, dateFrom, dateTo
const listOrders = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.status)        filter.status        = req.query.status;
    if (req.query.paymentMethod) filter.paymentMethod = req.query.paymentMethod;
    if (req.query.paymentStatus) filter.paymentStatus = req.query.paymentStatus;

    if (req.query.dateFrom || req.query.dateTo) {
      filter.createdAt = {};
      if (req.query.dateFrom) filter.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo)   filter.createdAt.$lte = new Date(req.query.dateTo);
    }

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .select('-routingMeta')
        .populate('customerId', 'name phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(filter),
    ]);

    return sendSuccess(res, 200, 'Orders fetched', { orders, total, page, limit });
  } catch (err) {
    logger.error('listOrders error:', err);
    return sendError(res, 500, 'Failed to fetch orders', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /orders/:id ───────────────────────────────────────────────
const getOrderDetail = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('customerId', 'name phone email')
      .populate('items.productId', 'name nameHi unit image')
      .populate('subOrders.vendorId', 'businessName phone location')
      .populate('subOrders.riderId', 'name phone vehicleType rating')
      .lean();

    if (!order) return sendError(res, 404, 'Order not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Order detail', order);
  } catch (err) {
    logger.error('getOrderDetail error:', err);
    return sendError(res, 500, 'Failed to fetch order', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /orders/:id/status ──────────────────────────────────────
// Admin manual override of order status (e.g. mark as failed after investigation)
const overrideOrderStatus = async (req, res) => {
  try {
    const { status, reason } = req.body;
    const validStatuses = Object.values(ORDER_STATUS);

    if (!status || !validStatuses.includes(status)) {
      return sendError(
        res, 400,
        `status must be one of: ${validStatuses.join(', ')}`,
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const order = await Order.findById(req.params.id);
    if (!order) return sendError(res, 404, 'Order not found', ERROR_CODES.NOT_FOUND);

    order.status = status;
    if (reason) order.cancelReason = reason;
    if (status === ORDER_STATUS.CANCELLED) order.cancelledAt = new Date();
    await order.save();

    return sendSuccess(res, 200, 'Order status updated', { orderId: order._id, status });
  } catch (err) {
    logger.error('overrideOrderStatus error:', err);
    return sendError(res, 500, 'Failed to update order status', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { listOrders, getOrderDetail, overrideOrderStatus };
