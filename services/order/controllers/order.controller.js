require('dotenv').config();
const { z } = require('zod');
const axios = require('axios');
const Order = require('../models/Order.model');
const Product = require('../../product/models/Product.model');
const Vendor = require('../../user/models/Vendor.model');
const { checkStock } = require('../logic/stockChecker');
const { validateCoupon, markCouponUsed, releaseCouponByCode } = require('../logic/couponEngine');
const {
  initiateRouting,
  handleVendorResponse,
  recordVendorAcceptance,
  clearRoutingState,
  emitToCustomer,
} = require('../logic/vendorRouter');
const { buildSubOrders } = require('../logic/orderSplitter');
const Rider = require('../../user/models/Rider.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const { ORDER_STATUS, SUB_ORDER_STATUS } = require('../../../shared/constants/orderStatus');
const ROLES = require('../../../shared/constants/roles');
const { triggerNotification } = require('../../../shared/utils/notify');
const { notifyAdmin } = require('../../../shared/utils/notifyAdmin');
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
    const products = await Product.find({ _id: { $in: productIds }, active: true, isAvailableToday: true }).lean();

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

    // ── Coupon usage & routing ────────────────────────────────────
    // COD: the order is committed now, so mark the coupon used and route.
    // UPI: defer coupon usage to payment success (confirmUpiOrder) so an
    // abandoned or failed payment doesn't permanently burn the coupon.
    if (paymentMethod === 'cod') {
      if (validatedCoupon) {
        markCouponUsed(validatedCoupon._id, req.user.id).catch((err) =>
          logger.error('markCouponUsed error:', err),
        );
      }
      const requiredCategories = [...new Set(orderItems.map((i) => i.category))];
      // Persist CONFIRMED first, then fire routing as the sole subsequent
      // writer of this document — avoids a lost-update race on routingMeta
      // between two concurrent saves of the same Mongoose instance.
      order.status = ORDER_STATUS.CONFIRMED;
      await order.save();
      initiateRouting(order, deliveryAddress, productIds, requiredCategories).catch((err) =>
        logger.error(`Routing failed for order ${order._id}:`, err),
      );
    }

    notifyAdmin(
      'new_order',
      `New Order — ₹${totalAmount}`,
      `Order #${order._id.toString().slice(-6).toUpperCase()} placed via ${paymentMethod.toUpperCase()}`,
      { orderId: order._id.toString(), totalAmount },
    );

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

    // Role-based access: each role may only view orders they are part of
    if (req.user.role === ROLES.CUSTOMER && order.customerId.toString() !== req.user.id) {
      return sendError(res, 403, 'Access denied', ERROR_CODES.FORBIDDEN);
    }
    if (req.user.role === ROLES.VENDOR) {
      const isAssigned = order.subOrders.some((so) => so.vendorId?.toString() === req.user.id);
      if (!isAssigned) return sendError(res, 403, 'Access denied', ERROR_CODES.FORBIDDEN);
    }
    if (req.user.role === ROLES.RIDER) {
      const isAssigned = order.subOrders.some((so) => so.riderId?.toString() === req.user.id);
      if (!isAssigned) return sendError(res, 403, 'Access denied', ERROR_CODES.FORBIDDEN);
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

    // Release the coupon hold if it was actually counted: COD orders count it
    // at placement, and any paid order counted it on payment success.
    if (order.couponCode && (order.paymentMethod === 'cod' || order.paymentStatus === 'paid')) {
      releaseCouponByCode(order.couponCode, order.customerId).catch((err) =>
        logger.error('releaseCoupon error:', err),
      );
    }

    // Trigger refund if the order was already paid via UPI
    if (order.paymentStatus === 'paid') {
      const paymentServiceUrl = `http://localhost:${process.env.PORT_PAYMENT || 3007}`;
      axios
        .post(`${paymentServiceUrl}/internal/refund-by-order`, { orderId: order._id.toString() })
        .catch((err) => logger.error(`Refund trigger failed for order ${order._id}:`, err.message));
    }

    notifyAdmin(
      'order_cancelled',
      `Order Cancelled`,
      `Order #${order._id.toString().slice(-6).toUpperCase()} was cancelled (₹${order.totalAmount})`,
      { orderId: order._id.toString(), totalAmount: order.totalAmount },
    );

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

    // Update Rider.rating aggregate for all riders on this order.
    // Uses an aggregation-pipeline update for an atomic incremental average:
    //   newAverage = (oldAverage × oldCount + newScore) / (oldCount + 1)
    if (parsed.data.rider != null) {
      const riderIds = order.subOrders
        .filter((so) => so.riderId)
        .map((so) => so.riderId);

      if (riderIds.length > 0) {
        const score = parsed.data.rider;
        await Rider.updateMany(
          { _id: { $in: riderIds } },
          [
            {
              $set: {
                'rating.count':   { $add: ['$rating.count', 1] },
                'rating.average': {
                  $round: [
                    {
                      $divide: [
                        { $add: [{ $multiply: ['$rating.average', '$rating.count'] }, score] },
                        { $add: ['$rating.count', 1] },
                      ],
                    },
                    2,
                  ],
                },
              },
            },
          ],
        );
      }
    }

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
      .select('items deliveryAddress totalAmount createdAt subOrders customerId')
      .populate('customerId', 'name phone')
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

      // Fetch vendor locations to populate pickupLocation on each sub-order
      const vendorIds = subOrders.map((so) => so.vendorId);
      const vendors = await Vendor.find({ _id: { $in: vendorIds } })
        .select('location businessName')
        .lean();
      const vendorMap = Object.fromEntries(vendors.map((v) => [v._id.toString(), v]));

      order.subOrders = subOrders.map((so) => {
        const vendor = vendorMap[so.vendorId.toString()];
        const [vendorLng = 0, vendorLat = 0] = vendor?.location?.coordinates || [];
        return {
          ...so,
          vendorId: so.vendorId,
          status: SUB_ORDER_STATUS.VENDOR_ACCEPTED,
          vendorAcceptedAt: new Date(),
          dropLocation: order.deliveryAddress,
          pickupLocation: {
            lat: vendorLat,
            lng: vendorLng,
            fullAddress: vendor?.businessName || '',
          },
        };
      });
      order.status = ORDER_STATUS.CONFIRMED;

      await order.save();
      await clearRoutingState(order._id);

      // Notify customer via Socket and FCM push
      await emitToCustomer(order.customerId.toString(), 'order:confirmed', { orderId: order._id });
      triggerNotification('order:confirmed', order.customerId.toString(), 'customer', {
        orderId: order._id.toString(),
      });

      // Phase 5: trigger rider assignment for each sub-order (fire-and-forget)
      for (const subOrder of order.subOrders) {
        axios
          .post(
            `http://localhost:${process.env.PORT_DELIVERY || 3006}/internal/assign-rider`,
            {
              orderId:        order._id.toString(),
              subOrderId:     subOrder._id.toString(),
              vendorId:       subOrder.vendorId.toString(),
              customerId:     order.customerId.toString(),
              pickupLocation: subOrder.pickupLocation,
              dropLocation:   subOrder.dropLocation,
              deliveryFee:    order.deliveryFee,
            },
            { timeout: 5000 },
          )
          .catch((err) =>
            logger.warn(`assign-rider call failed for subOrder ${subOrder._id}: ${err.message}`),
          );
      }

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

// ── GET /api/orders/vendor/history ───────────────────────────────
// Vendor: see past orders (completed/delivered/cancelled) assigned to them
const getVendorHistory = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const vendorId = req.user.id;
    const vendorOid = new mongoose.Types.ObjectId(vendorId);
    const { page = 1, limit = 20, status } = req.query;
    const skip = (Math.max(1, +page) - 1) * Math.min(50, +limit || 20);
    const take = Math.min(50, +limit || 20);

    const matchFilter = { 'subOrders.vendorId': vendorOid };

    const terminalStatuses = [SUB_ORDER_STATUS.DELIVERED, SUB_ORDER_STATUS.FAILED];
    if (status && terminalStatuses.includes(status)) {
      matchFilter['subOrders.status'] = status;
    } else {
      matchFilter['subOrders.status'] = { $in: terminalStatuses };
    }

    // Fetch one extra to know if there are more pages (avoids separate count query)
    const orders = await Order.find(matchFilter)
      .select('items totalAmount status createdAt subOrders customerId')
      .populate('customerId', 'name')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(take + 1)
      .lean();

    const hasMore = orders.length > take;
    if (hasMore) orders.pop();

    const mapped = orders.map((o) => {
      const vendorSub = o.subOrders?.find((s) => s.vendorId?.toString() === vendorId);
      return {
        _id: o._id,
        status: o.status,
        subOrderStatus: vendorSub?.status,
        totalAmount: o.totalAmount,
        itemCount: o.items?.length || 0,
        customerName: o.customerId?.name || 'Customer',
        createdAt: o.createdAt,
        deliveredAt: vendorSub?.deliveredAt,
      };
    });

    return sendSuccess(res, 200, 'Vendor order history fetched', {
      orders: mapped,
      page: +page,
      limit: take,
      hasMore,
    });
  } catch (err) {
    logger.error('getVendorHistory error:', err);
    return sendError(res, 500, 'Failed to fetch vendor history', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/orders/vendor/stats ────────────────────────────────
// Vendor: dashboard stats (today's order count, yesterday comparison)
// Single aggregation pipeline for performance.
const getVendorStats = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const vendorId = new mongoose.Types.ObjectId(req.user.id);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    const result = await Order.aggregate([
      {
        $match: {
          'subOrders.vendorId': vendorId,
          createdAt: { $gte: yesterdayStart },
        },
      },
      {
        $group: {
          _id: {
            $cond: [{ $gte: ['$createdAt', todayStart] }, 'today', 'yesterday'],
          },
          count: { $sum: 1 },
          avgTotal: { $avg: '$totalAmount' },
        },
      },
    ]);

    const today = result.find((r) => r._id === 'today') || { count: 0, avgTotal: 0 };
    const yesterday = result.find((r) => r._id === 'yesterday') || { count: 0, avgTotal: 0 };

    const avgToday = Math.round(today.avgTotal || 0);
    const avgYesterday = Math.round(yesterday.avgTotal || 0);

    return sendSuccess(res, 200, 'Vendor stats fetched', {
      ordersToday: today.count,
      ordersYesterday: yesterday.count,
      ordersDelta: today.count - yesterday.count,
      avgOrderValue: avgToday,
      avgDelta: avgToday - avgYesterday,
    });
  } catch (err) {
    logger.error('getVendorStats error:', err);
    return sendError(res, 500, 'Failed to fetch vendor stats', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /api/orders/validate-coupon ─────────────────────────────
// Customer: preview coupon discount before placing order (no side-effects)
const validateCouponController = async (req, res) => {
  try {
    const couponPreviewSchema = z.object({
      code: z.string().min(1).max(50),
      orderSubtotal: z.number().positive().max(1_000_000),
    });
    const parsed = couponPreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }
    const { code, orderSubtotal } = parsed.data;

    const result = await validateCoupon(code, orderSubtotal, req.user.id);

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
  getVendorHistory,
  getVendorStats,
  vendorAcceptOrder,
  vendorRejectOrder,
  validateCouponController,
};
