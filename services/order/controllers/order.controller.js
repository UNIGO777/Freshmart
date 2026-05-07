require('dotenv').config();
const { z } = require('zod');
const Order = require('../models/Order.model');
const Product = require('../../product/models/Product.model');
const { checkStock } = require('../logic/stockChecker');
const { validateCoupon, markCouponUsed } = require('../logic/couponEngine');
const {
  initiateRouting,
  handleVendorResponse,
  recordVendorAcceptance,
  clearRoutingState,
  emitToCustomer,
} = require('../logic/vendorRouter');
const { buildSubOrders } = require('../logic/orderSplitter');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const { ORDER_STATUS, SUB_ORDER_STATUS } = require('../../../shared/constants/orderStatus');
const ROLES = require('../../../shared/constants/roles');
const logger = require('../../../shared/utils/logger');

// ── POST /api/orders/check-stock ──────────────────────────────────
// Customer: pre-payment serviceability check. Returns payable if serviceable.
const checkStockController = async (req, res) => {
  try {
    const schema = z.object({
      items: z.array(z.object({ productId: z.string(), quantity: z.number().min(1) })).min(1),
      deliveryAddress: z.object({ lat: z.number(), lng: z.number(), fullAddress: z.string() }),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const { items, deliveryAddress } = parsed.data;
    const result = await checkStock({ lat: deliveryAddress.lat, lng: deliveryAddress.lng }, items);

    if (!result.serviceable) {
      return sendSuccess(res, 200, 'Order not serviceable in your area', {
        serviceable: false,
        reason: result.reason,
        missingCategories: result.missingCategories,
      });
    }

    return sendSuccess(res, 200, 'Order is serviceable', {
      serviceable: true,
      coveredCategories: result.coveredCategories,
      paymentMethods: ['upi', 'cod'],
    });
  } catch (err) {
    logger.error('checkStock error:', err);
    return sendError(res, 500, 'Stock check failed', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /api/orders ──────────────────────────────────────────────
// Customer: place an order (after verifying serviceability).
// Payment has NOT happened yet — order enters awaiting_payment or routing.
const placeOrder = async (req, res) => {
  try {
    const schema = z.object({
      items: z.array(z.object({ productId: z.string(), quantity: z.number().min(1) })).min(1),
      deliveryAddress: z.object({
        lat: z.number(),
        lng: z.number(),
        fullAddress: z.string(),
        label: z.string().optional(),
      }),
      paymentMethod: z.enum(['upi', 'cod']),
      couponCode: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const { items, deliveryAddress, paymentMethod, couponCode } = parsed.data;

    // ── Resolve products & snapshot prices ───────────────────────
    const productIds = items.map((i) => i.productId);
    const products = await Product.find({ _id: { $in: productIds }, isAvailableToday: true }).lean();

    if (products.length !== productIds.length) {
      return sendError(res, 400, 'Some products are not available today', ERROR_CODES.STOCK_UNAVAILABLE);
    }

    const productMap = Object.fromEntries(products.map((p) => [p._id.toString(), p]));

    // Build order items with price snapshot
    const orderItems = items.map((i) => {
      const p = productMap[i.productId];
      return {
        productId: i.productId,
        quantity: i.quantity,
        sellingPrice: p.sellingPrice,
        buyingPrice: p.buyingPrice,
        name: p.name,
        category: p.category,
      };
    });

    // ── Calculate totals ──────────────────────────────────────────
    const subtotal = orderItems.reduce((sum, i) => sum + i.sellingPrice * i.quantity, 0);

    // Basic delivery fee: flat ₹30 (distance-based logic goes in Phase 5)
    const deliveryFee = 30;

    // Coupon validation
    let discountAmount = 0;
    let validatedCoupon = null;
    if (couponCode) {
      const couponResult = await validateCoupon(couponCode, subtotal, req.user.id);
      if (!couponResult.valid) {
        return sendError(res, 400, couponResult.reason, ERROR_CODES.VALIDATION_ERROR);
      }
      discountAmount = couponResult.discountAmount;
      validatedCoupon = couponResult.coupon;
    }

    const totalAmount = subtotal + deliveryFee - discountAmount;

    // ── Re-run stock check ────────────────────────────────────────
    const stockResult = await checkStock(
      { lat: deliveryAddress.lat, lng: deliveryAddress.lng },
      items,
    );

    if (!stockResult.serviceable) {
      return sendError(res, 400, 'Order not serviceable in your area', ERROR_CODES.NO_VENDOR_FOUND);
    }

    // ── Create order ──────────────────────────────────────────────
    const order = await Order.create({
      customerId: req.user.id,
      items: orderItems,
      deliveryAddress,
      paymentMethod,
      couponCode,
      discountAmount,
      deliveryFee,
      totalAmount,
      status: ORDER_STATUS.AWAITING_PAYMENT,
      routingMeta: {
        batchIndex: 0,
        allVendorIds: [],
        offeredVendorIds: [],
        rejectedVendorIds: [],
      },
    });

    // ── Mark coupon used after order created ─────────────────────
    if (validatedCoupon) {
      markCouponUsed(validatedCoupon._id, req.user.id).catch((err) =>
        logger.error('markCouponUsed error:', err),
      );
    }

    // ── For COD: kick off vendor routing immediately ──────────────
    // For UPI: routing starts after payment confirmation (Phase 4 wires this)
    if (paymentMethod === 'cod') {
      const requiredCategories = [...new Set(orderItems.map((i) => i.category))];
      initiateRouting(order, deliveryAddress, productIds, requiredCategories).catch((err) =>
        logger.error(`Routing failed for order ${order._id}:`, err),
      );
      order.status = ORDER_STATUS.CONFIRMED;
      await order.save();
    }

    return sendSuccess(res, 201, 'Order placed', {
      orderId: order._id,
      totalAmount,
      deliveryFee,
      discountAmount,
      status: order.status,
      paymentMethod,
    });
  } catch (err) {
    logger.error('placeOrder error:', err);
    return sendError(res, 500, 'Failed to place order', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/orders ───────────────────────────────────────────────
// Customer: order history
const getOrders = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 10);
    const skip = (page - 1) * limit;

    const filter = { customerId: req.user.id };
    if (req.query.status) filter.status = req.query.status;

    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-routingMeta')
        .lean(),
      Order.countDocuments(filter),
    ]);

    return sendSuccess(res, 200, 'Orders fetched', { orders, total, page, limit });
  } catch (err) {
    logger.error('getOrders error:', err);
    return sendError(res, 500, 'Failed to fetch orders', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/orders/:id ───────────────────────────────────────────
const getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate('items.productId', 'name nameHi image unit')
      .populate('subOrders.vendorId', 'businessName phone location')
      .populate('subOrders.riderId', 'name phone currentLocation')
      .select('-routingMeta')
      .lean();

    if (!order) return sendError(res, 404, 'Order not found', ERROR_CODES.NOT_FOUND);

    // Customers can only view their own orders; vendors/riders see assigned orders only
    if (req.user.role === ROLES.CUSTOMER && order.customerId.toString() !== req.user.id) {
      return sendError(res, 403, 'Access denied', ERROR_CODES.FORBIDDEN);
    }

    return sendSuccess(res, 200, 'Order fetched', order);
  } catch (err) {
    logger.error('getOrderById error:', err);
    return sendError(res, 500, 'Failed to fetch order', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /api/orders/:id/cancel ─────────────────────────────────
const cancelOrder = async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, customerId: req.user.id });
    if (!order) return sendError(res, 404, 'Order not found', ERROR_CODES.NOT_FOUND);

    const cancellableStatuses = [ORDER_STATUS.STOCK_CHECK, ORDER_STATUS.AWAITING_PAYMENT, ORDER_STATUS.CONFIRMED];
    if (!cancellableStatuses.includes(order.status)) {
      return sendError(res, 400, 'Order cannot be cancelled at this stage', ERROR_CODES.ORDER_NOT_CANCELLABLE);
    }

    // Check no sub-order has been picked yet
    const isPicked = order.subOrders.some((so) =>
      [SUB_ORDER_STATUS.PICKED, SUB_ORDER_STATUS.DELIVERED].includes(so.status),
    );
    if (isPicked) {
      return sendError(res, 400, 'Order is already picked up and cannot be cancelled', ERROR_CODES.ORDER_NOT_CANCELLABLE);
    }

    order.status = ORDER_STATUS.CANCELLED;
    order.cancelledAt = new Date();
    order.cancelReason = req.body.reason || 'customer_cancelled';
    await order.save();

    await clearRoutingState(order._id);

    // TODO Phase 4: trigger refund if already paid

    return sendSuccess(res, 200, 'Order cancelled', { orderId: order._id });
  } catch (err) {
    logger.error('cancelOrder error:', err);
    return sendError(res, 500, 'Failed to cancel order', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /api/orders/:id/rate ─────────────────────────────────────
const rateOrder = async (req, res) => {
  try {
    const schema = z.object({
      product: z.number().min(1).max(5).optional(),
      rider: z.number().min(1).max(5).optional(),
      comment: z.string().max(500).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const order = await Order.findOne({ _id: req.params.id, customerId: req.user.id });
    if (!order) return sendError(res, 404, 'Order not found', ERROR_CODES.NOT_FOUND);
    if (order.status !== ORDER_STATUS.DELIVERED) {
      return sendError(res, 400, 'Can only rate delivered orders', ERROR_CODES.VALIDATION_ERROR);
    }
    if (order.ratings?.ratedAt) {
      return sendError(res, 409, 'Order already rated', ERROR_CODES.CONFLICT);
    }

    order.ratings = { ...parsed.data, ratedAt: new Date() };
    await order.save();

    // TODO Phase 8: update rider.rating aggregate
    return sendSuccess(res, 200, 'Rating submitted', order.ratings);
  } catch (err) {
    logger.error('rateOrder error:', err);
    return sendError(res, 500, 'Failed to submit rating', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/orders/vendor/incoming ──────────────────────────────
// Vendor: see orders currently offered to them
const getVendorIncoming = async (req, res) => {
  try {
    const orders = await Order.find({
      'routingMeta.offeredVendorIds': req.user.id,
      status: { $in: [ORDER_STATUS.CONFIRMED, ORDER_STATUS.AWAITING_PAYMENT] },
    })
      .select('items deliveryAddress totalAmount createdAt subOrders')
      .lean();

    return sendSuccess(res, 200, 'Incoming orders fetched', orders);
  } catch (err) {
    logger.error('getVendorIncoming error:', err);
    return sendError(res, 500, 'Failed to fetch incoming orders', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /api/orders/vendor/:id/accept ──────────────────────────
// Vendor: accept an order, specifying which items they will fulfil.
// Body: { acceptedItems: [{ productId, quantity }] }
const vendorAcceptOrder = async (req, res) => {
  try {
    const { acceptedItems } = req.body;
    if (!Array.isArray(acceptedItems) || acceptedItems.length === 0) {
      return sendError(res, 400, 'acceptedItems required', ERROR_CODES.MISSING_FIELDS);
    }

    const order = await Order.findById(req.params.id);
    if (!order) return sendError(res, 404, 'Order not found', ERROR_CODES.NOT_FOUND);

    const vendorId = req.user.id;

    // Verify vendor was offered this order
    const wasOffered = order.routingMeta.offeredVendorIds.some((v) => v.toString() === vendorId);
    if (!wasOffered) return sendError(res, 403, 'This order was not offered to you', ERROR_CODES.FORBIDDEN);

    // Record acceptance in Redis routing state
    const { allCovered, coverageState } = await recordVendorAcceptance(
      order._id.toString(),
      vendorId,
      acceptedItems,
    );

    // Move this vendor out of offered → mark sub-order created
    order.routingMeta.offeredVendorIds = order.routingMeta.offeredVendorIds.filter(
      (v) => v.toString() !== vendorId,
    );

    if (allCovered) {
      // Build sub-orders for all accepting vendors
      const subOrders = buildSubOrders(coverageState, order.deliveryAddress);
      order.subOrders = subOrders.map((so) => ({
        ...so,
        vendorId: so.vendorId,
        status: SUB_ORDER_STATUS.VENDOR_ACCEPTED,
        vendorAcceptedAt: new Date(),
        dropLocation: order.deliveryAddress,
      }));
      order.status = ORDER_STATUS.CONFIRMED;

      await order.save();
      await clearRoutingState(order._id);

      // Notify customer
      await emitToCustomer(order.customerId.toString(), 'order:confirmed', { orderId: order._id });

      // TODO Phase 5: trigger riderAssigner for each sub-order

      return sendSuccess(res, 200, 'Order accepted — all items covered', { orderId: order._id });
    }

    // Not all covered — mark vendor as responded, check cascade
    await order.save();
    await handleVendorResponse(order, vendorId);

    return sendSuccess(res, 200, 'Acceptance recorded — waiting for more vendors', { orderId: order._id });
  } catch (err) {
    logger.error('vendorAcceptOrder error:', err);
    return sendError(res, 500, 'Failed to accept order', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /api/orders/vendor/:id/reject ──────────────────────────
const vendorRejectOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return sendError(res, 404, 'Order not found', ERROR_CODES.NOT_FOUND);

    const vendorId = req.user.id;

    order.routingMeta.offeredVendorIds = order.routingMeta.offeredVendorIds.filter(
      (v) => v.toString() !== vendorId,
    );
    order.routingMeta.rejectedVendorIds.push(vendorId);
    await order.save();

    // Attempt cascade
    await handleVendorResponse(order, vendorId);

    return sendSuccess(res, 200, 'Order rejected');
  } catch (err) {
    logger.error('vendorRejectOrder error:', err);
    return sendError(res, 500, 'Failed to reject order', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /api/orders/validate-coupon ─────────────────────────────
// Customer: preview coupon discount before placing order (no side-effects)
const validateCouponController = async (req, res) => {
  try {
    const { code, orderSubtotal } = req.body;
    if (!code || !orderSubtotal) {
      return sendError(res, 400, 'code and orderSubtotal are required', ERROR_CODES.MISSING_FIELDS);
    }

    const result = await validateCoupon(code, Number(orderSubtotal), req.user.id);

    if (!result.valid) {
      return sendError(res, 400, result.reason, ERROR_CODES.VALIDATION_ERROR);
    }

    return sendSuccess(res, 200, 'Coupon is valid', {
      discountAmount: result.discountAmount,
      discountType: result.coupon.discountType,
      discountValue: result.coupon.discountValue,
      description: result.coupon.description,
    });
  } catch (err) {
    logger.error('validateCouponController error:', err);
    return sendError(res, 500, 'Coupon validation failed', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = {
  checkStockController,
  placeOrder,
  getOrders,
  getOrderById,
  cancelOrder,
  rateOrder,
  getVendorIncoming,
  vendorAcceptOrder,
  vendorRejectOrder,
  validateCouponController,
};
