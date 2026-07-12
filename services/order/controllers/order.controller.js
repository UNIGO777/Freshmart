require('dotenv').config();
const { z } = require('zod');
const axios = require('axios');
const mongoose = require('mongoose');
const Order = require('../models/Order.model');
const Product = require('../../product/models/Product.model');
const Vendor = require('../../user/models/Vendor.model');
const Customer = require('../../user/models/Customer.model');
const { checkStock } = require('../logic/stockChecker');
const { validateCoupon, markCouponUsed, releaseCouponByCode } = require('../logic/couponEngine');
const {
  initiateRouting,
  handleVendorResponse,
  recordVendorAcceptance,
  clearRoutingState,
  emitToCustomer,
  emitToVendor,
  findEligibleVendor,
  findEligibleVendorsForGroup,
} = require('../logic/vendorRouter');
const { buildSubOrders } = require('../logic/orderSplitter');
const { splitByCategory, claimGroup } = require('../logic/orderGrouping');
const Rider = require('../../user/models/Rider.model');
const DeliveryRateConfig = require('../../admin/models/DeliveryRateConfig.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const { ORDER_STATUS, SUB_ORDER_STATUS } = require('../../../shared/constants/orderStatus');
const ROLES = require('../../../shared/constants/roles');
const { triggerNotification } = require('../../../shared/utils/notify');
const { sendDataOnly } = require('../../../shared/utils/dataPush');
const { notifyAdmin } = require('../../../shared/utils/notifyAdmin');
const { notifyVendor } = require('../../../shared/utils/vendorNotify');
const logger = require('../../../shared/utils/logger');
const Inventory = require('../../vendor/models/Inventory.model');

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
// Customer: place an order. COD only. Backend checks inventory and
// finds closest vendor, sends request to vendor panel.
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
      paymentMethod: z.literal('cod'),
      couponCode: z.string().optional(),
      deliveryInstructions: z.string().max(500).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const { items, deliveryAddress, couponCode, deliveryInstructions } = parsed.data;

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

    // ── Delivery fee from admin config ────────────────────────────
    const deliveryConfig = await DeliveryRateConfig.getConfig();
    const subtotal = orderItems.reduce((sum, i) => sum + i.sellingPrice * i.quantity, 0);
    const deliveryFee = subtotal >= deliveryConfig.freeDeliveryThreshold ? 0 : deliveryConfig.deliveryFee;

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

    // ── Multi-vendor split (M0): divide by category, find eligible vendors PER group ──
    // Each category-group (veg-group, fruit-group, …) routes to its own vendors and is
    // claimed all-or-nothing by one of them. A single-category order = one group, so it
    // behaves exactly like the old single-vendor flow.
    const groups = splitByCategory(orderItems);
    const routingGroups = [];
    const offerMap = new Map(); // vendorId(str) -> { vendor, items:[] }  union across the groups a vendor is offered

    for (const g of groups) {
      // area + category + CARRIES all group items (no quantity gate — vendor decides on accept)
      const vendors = await findEligibleVendorsForGroup(deliveryAddress, g, 3); // cap 3 per category
      const offeredVendorIds = vendors.map((v) => v._id);
      routingGroups.push({
        groupKey: g.groupKey,
        category: g.category,
        productIds: g.productIds,
        offeredVendorIds,
        claimedByVendorId: null,
        status: offeredVendorIds.length ? 'open' : 'failed', // no vendor → flagged (M3 will fail the order)
      });
      if (offeredVendorIds.length === 0) {
        logger.warn(`placeOrder: category-group '${g.groupKey}' has NO eligible vendors — order will be un-fulfillable (all-or-nothing fail lands in M3)`);
        continue;
      }
      for (const v of vendors) {
        const vid = v._id.toString();
        if (!offerMap.has(vid)) offerMap.set(vid, { vendor: v, items: [] });
        offerMap.get(vid).items.push(...g.items);
      }
    }

    // If not a single group could be offered, this is the old "no vendors in your area".
    if (!routingGroups.some((rg) => rg.status === 'open')) {
      return sendError(res, 400, 'No vendors available in your area', ERROR_CODES.NO_VENDOR_FOUND);
    }

    const unionVendorIds = [...offerMap.keys()].map((id) => new mongoose.Types.ObjectId(id));

    // ── Create order ──────────────────────────────────────────────
    const order = await Order.create({
      customerId: req.user.id,
      items: orderItems,
      deliveryAddress,
      deliveryInstructions: deliveryInstructions || '',
      paymentMethod: 'cod',
      couponCode,
      discountAmount,
      deliveryFee,   // order-level: charged ONCE regardless of how many sub-orders the split produces
      totalAmount,
      status: ORDER_STATUS.CONFIRMED,
      stage: 'finding_vendor', // waiting for a store to accept
      stageDeadline: new Date(Date.now() + (Number(process.env.VENDOR_OFFER_TTL_SEC) || 90) * 1000),
      routingMeta: {
        batchIndex: 0,
        allVendorIds: unionVendorIds,     // union across groups — keeps getVendorIncoming working
        offeredVendorIds: unionVendorIds,
        rejectedVendorIds: [],
        groups: routingGroups,
      },
    });

    // Mark coupon used (COD — committed immediately)
    if (validatedCoupon) {
      markCouponUsed(validatedCoupon._id, req.user.id).catch((err) =>
        logger.error('markCouponUsed error:', err),
      );
    }

    // ── Offer to each eligible vendor (scoped to the items they can fulfil) ─────────
    // Customer FIRST name only — shows on the LOCK screen ("Order from Rahul"). Looked
    // up once, carried IN the siren push so the popup can label the order offline.
    let customerName = '';
    try {
      const cust = await Customer.findById(req.user.id).select('name').lean();
      customerName = (cust?.name || '').trim().split(/\s+/)[0] || '';
    } catch { /* name is optional — popup falls back to "New order" */ }
    const expiresIn = Number(process.env.VENDOR_OFFER_TTL_SEC) || 90;
    const orderIdStr = order._id.toString();

    for (const [vid, { vendor, items }] of offerMap) {
      const inventoryContext = items.map((it) => ({
        productId: it.productId, name: it.name, orderedQty: it.quantity,
        availableQty: it.quantity, extraNeeded: 0, inStock: true, // eligibility guaranteed full stock
      }));
      await emitToVendor(vid, 'order:incoming', {
        orderId: orderIdStr,
        items,                          // only THIS vendor's offered items
        deliveryAddress: order.deliveryAddress,
        deliveryInstructions: order.deliveryInstructions,
        inventoryContext,
        expiresIn,
      });
      triggerNotification('order:incoming', vid, 'vendor', { orderId: orderIdStr, expiresIn });
      notifyVendor(vid, 'order:incoming', 'New Order Received',
        `New order #${orderIdStr.slice(-4)} with ${items.length} item(s)`, orderIdStr);

      // Phase-2 phone-off siren — DATA-ONLY high-priority push wakes a killed/locked app
      // so the native siren + lock-screen popup fire. UNCHANGED shape (do not modify).
      if (vendor.fcmToken) {
        sendDataOnly(
          vendor.fcmToken,
          { type: 'NEW_ORDER', orderId: orderIdStr, expiresAt: Date.now() + expiresIn * 1000, customerName },
          { ttlSec: expiresIn },
        );
      }
    }

    // Notify customer: finding vendor
    await emitToCustomer(order.customerId.toString(), 'order:status', {
      orderId: order._id.toString(),
      status: 'finding_vendor',
    });

    notifyAdmin(
      'new_order',
      `New Order — ₹${totalAmount}`,
      `Order #${order._id.toString().slice(-6).toUpperCase()} placed via COD`,
      { orderId: order._id.toString(), totalAmount },
    );

    return sendSuccess(res, 201, 'Order placed', {
      orderId: order._id,
      totalAmount,
      deliveryFee,
      discountAmount,
      status: order.status,
      paymentMethod: 'cod',
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
    if (req.query.status === 'cancelled') {
      // The "Cancelled" tab should also surface orders that ended as `failed`
      // (e.g. no rider available) — they're terminal and cancellation-like.
      filter.status = { $in: ['cancelled', 'failed'] };
    } else if (req.query.status) {
      filter.status = req.query.status;
    }

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
      const isAssigned = order.subOrders.some((so) => (so.vendorId?._id ?? so.vendorId)?.toString() === req.user.id);
      if (!isAssigned) return sendError(res, 403, 'Access denied', ERROR_CODES.FORBIDDEN);
    }
    if (req.user.role === ROLES.RIDER) {
      const isAssigned = order.subOrders.some((so) => (so.riderId?._id ?? so.riderId)?.toString() === req.user.id);
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

    // Check no sub-order has been picked yet
    const isPicked = order.subOrders.some((so) =>
      [SUB_ORDER_STATUS.PICKED, SUB_ORDER_STATUS.DELIVERED].includes(so.status),
    );
    if (isPicked) {
      return sendError(res, 400, 'Order is already picked up and cannot be cancelled', ERROR_CODES.ORDER_NOT_CANCELLABLE);
    }

    // After vendor accept, only allow cancel within the 1-minute window
    const postAcceptStatuses = [SUB_ORDER_STATUS.VENDOR_ACCEPTED, SUB_ORDER_STATUS.VENDOR_CONFIRMED, SUB_ORDER_STATUS.RIDER_ASSIGNED, SUB_ORDER_STATUS.ON_THE_WAY];
    const hasVendorAccepted = order.subOrders.some((so) => postAcceptStatuses.includes(so.status) || so.riderId);
    if (hasVendorAccepted) {
      if (!order.cancelDeadline || new Date() > order.cancelDeadline) {
        return sendError(res, 400, 'Cancellation window has expired', ERROR_CODES.ORDER_NOT_CANCELLABLE);
      }
    } else if (!cancellableStatuses.includes(order.status)) {
      return sendError(res, 400, 'Order cannot be cancelled at this stage', ERROR_CODES.ORDER_NOT_CANCELLABLE);
    }

    order.status = ORDER_STATUS.CANCELLED;
    order.cancelledAt = new Date();
    order.cancelReason = req.body.reason || 'customer_cancelled';
    // Mark all non-terminal sub-orders as failed
    for (const sub of order.subOrders) {
      if (![SUB_ORDER_STATUS.DELIVERED, SUB_ORDER_STATUS.FAILED].includes(sub.status)) {
        sub.status = SUB_ORDER_STATUS.FAILED;
      }
    }
    await order.save();

    await clearRoutingState(order._id);

    // Restore stock for ALL sub-orders that had a vendor assigned
    for (const sub of order.subOrders) {
      const vendorId = (sub.vendorId?._id ?? sub.vendorId)?.toString();
      if (vendorId) {
        axios
          .post(`http://localhost:${process.env.PORT_ORDER || 3004}/internal/restore-stock`, {
            orderId: order._id.toString(),
            vendorId,
          })
          .catch((err) => logger.warn(`restore-stock failed for order ${order._id} vendor ${vendorId}: ${err.message}`));
      }
    }

    // Cancel any active delivery jobs and free riders
    if (order.subOrders.length > 0) {
      axios
        .post(`http://localhost:${process.env.PORT_DELIVERY || 3006}/internal/cancel-jobs`, {
          orderId: order._id.toString(),
        })
        .catch((err) => logger.warn(`cancel-jobs failed for order ${order._id}: ${err.message}`));
    }

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

    // Reverse vendor earning for each sub-order (if any was created at pickup)
    for (const sub of order.subOrders) {
      axios
        .post(`http://localhost:${process.env.PORT_ORDER || 3004}/internal/reverse-vendor-earning`, {
          orderId: order._id.toString(),
          subOrderId: sub._id.toString(),
          reason: 'customer_cancelled',
        })
        .catch((err) => logger.warn(`reverse-vendor-earning failed for subOrder ${sub._id}: ${err.message}`));
    }

    // Notify customer via socket (clears active order strip)
    emitToCustomer(order.customerId.toString(), 'order:status', {
      orderId: order._id.toString(),
      status: 'cancelled',
      message: 'Your order has been cancelled.',
    });

    // Notify vendor(s) via socket
    for (const sub of order.subOrders) {
      const vendorId = (sub.vendorId?._id ?? sub.vendorId)?.toString();
      if (vendorId) {
        emitToVendor(vendorId, 'order:status', {
          orderId: order._id.toString(),
          status: 'cancelled',
          message: 'Customer cancelled the order.',
        });
        notifyVendor(vendorId, 'order:cancelled', 'Order Cancelled',
          `Order #${order._id.toString().slice(-4)} was cancelled by the customer`,
          order._id.toString());
      }
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
      vendor: z.number().min(1).max(5).optional(),
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

    // Update Vendor.rating aggregate
    if (parsed.data.vendor != null) {
      const vendorIds = order.subOrders
        .filter((so) => so.vendorId)
        .map((so) => so.vendorId);

      if (vendorIds.length > 0) {
        const score = parsed.data.vendor;
        await Vendor.updateMany(
          { _id: { $in: vendorIds } },
          [
            {
              $set: {
                'rating.count':   { $add: [{ $ifNull: ['$rating.count', 0] }, 1] },
                'rating.average': {
                  $round: [
                    {
                      $divide: [
                        { $add: [{ $multiply: [{ $ifNull: ['$rating.average', 0] }, { $ifNull: ['$rating.count', 0] }] }, score] },
                        { $add: [{ $ifNull: ['$rating.count', 0] }, 1] },
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
    const mongoose = require('mongoose');
    const vendorOid = new mongoose.Types.ObjectId(req.user.id);
    const orders = await Order.find({
      'routingMeta.offeredVendorIds': vendorOid,
      status: { $in: [ORDER_STATUS.CONFIRMED, ORDER_STATUS.AWAITING_PAYMENT] },
    })
      .select('items deliveryAddress totalAmount createdAt subOrders customerId deliveryInstructions paymentMethod paymentStatus')
      .populate('customerId', 'name phone')
      .lean();

    // Add vendorAmount (buying price total) for each order
    const enriched = orders.map((o) => ({
      ...o,
      vendorAmount: (o.items || []).reduce(
        (sum, item) => sum + (item.buyingPrice ?? 0) * (item.quantity ?? 1), 0,
      ),
    }));

    return sendSuccess(res, 200, 'Incoming orders fetched', enriched);
  } catch (err) {
    logger.error('getVendorIncoming error:', err);
    return sendError(res, 500, 'Failed to fetch incoming orders', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /api/orders/vendor/:id/accept ──────────────────────────
// Vendor: accept entire order → build sub-order → trigger rider assignment.
const vendorAcceptOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return sendError(res, 404, 'Order not found', ERROR_CODES.NOT_FOUND);
    const acceptableStatuses = [ORDER_STATUS.CONFIRMED, ORDER_STATUS.AWAITING_PAYMENT, ORDER_STATUS.STOCK_CHECK];
    if (!acceptableStatuses.includes(order.status)) {
      return sendError(res, 400, `Order cannot be accepted (status: ${order.status})`, ERROR_CODES.VALIDATION_ERROR);
    }

    const vendorId = req.user.id;
    const vObjId = new mongoose.Types.ObjectId(vendorId);
    const cancelDeadline = new Date(Date.now() + 60 * 1000);
    const stageDeadline = new Date(Date.now() + (Number(process.env.RIDER_ASSIGNMENT_TIMEOUT_SEC) || 30) * 1000);

    // Vendor pickup location (both paths)
    const vendor = await Vendor.findById(vendorId).select('location businessName').lean();
    const [vendorLng = 0, vendorLat = 0] = vendor?.location?.coordinates || [];
    const pickupLocation = { lat: vendorLat, lng: vendorLng, fullAddress: vendor?.businessName || '' };
    const buildSub = (items) => ({
      vendorId,
      items: items.map((i) => ({ productId: i.productId, quantity: i.quantity, sellingPrice: i.sellingPrice, buyingPrice: i.buyingPrice })),
      status: SUB_ORDER_STATUS.VENDOR_ACCEPTED,
      vendorAcceptedAt: new Date(),
      pickupLocation,
      dropLocation: order.deliveryAddress,
    });

    const groups = order.routingMeta?.groups || [];
    let claimed;
    let acceptedSubOrder;

    if (groups.length === 0) {
      // ── LEGACY whole-order accept (orders placed before the split existed) ──
      // ATOMIC CLAIM — first vendor to match wins; matches only if still un-accepted,
      // acceptable status, and still offered to THIS vendor.
      claimed = await Order.findOneAndUpdate(
        {
          _id: order._id,
          status: { $in: acceptableStatuses },
          'subOrders.0': { $exists: false },
          'routingMeta.offeredVendorIds': vObjId,
        },
        { $set: { subOrders: [buildSub(order.items)], cancelDeadline, stage: 'finding_rider', stageDeadline } },
        { new: true },
      );
      if (!claimed) return sendError(res, 409, 'Order already taken by another store', ERROR_CODES.VALIDATION_ERROR);
      acceptedSubOrder = claimed.subOrders[claimed.subOrders.length - 1];
    } else {
      // ── GROUP model — claim this vendor's OPEN offered category-groups ──
      // A single-category order has ONE group, so this reduces to today's behaviour:
      // claim it → one sub-order → finding_rider; a losing double-accept → 409.
      const myOpenGroups = groups.filter(
        (g) => g.status === 'open' && g.offeredVendorIds.some((v) => v.toString() === vendorId),
      );
      if (myOpenGroups.length === 0) {
        return sendError(res, 409, 'Order already taken by another store', ERROR_CODES.VALIDATION_ERROR);
      }
      // Claim each won group with claimGroup: the group's status flip AND its sub-order
      // push are ONE atomic op. This is the key invariant for MR — "all groups claimed"
      // therefore always implies "all sub-orders present", so the rider-assignment trigger
      // below can never fire on a half-built order. A vendor covering multiple categories
      // gets one sub-order per group (co-located pickup stops merged in the route, MR-2).
      let lastClaimed = null;
      for (const g of myOpenGroups) {
        const groupItems = order.items.filter((it) => g.productIds.some((p) => p.toString() === it.productId.toString()));
        const won = await claimGroup(
          Order, order._id,
          { groupKey: g.groupKey, items: groupItems },
          vendorId,
          { pickupLocation, dropLocation: order.deliveryAddress },
        );
        if (won) lastClaimed = won;
      }
      if (!lastClaimed) {
        return sendError(res, 409, 'Order already taken by another store', ERROR_CODES.VALIDATION_ERROR);
      }
      // Order-level stage/deadlines (idempotent across a vendor's groups). NOTE (M0):
      // cancelDeadline resets on each vendor's accept — 2-vendor split restarts the
      // customer's cancel window on the 2nd accept. Acceptable for M0; refined in M4.
      claimed = await Order.findByIdAndUpdate(
        order._id,
        { $set: { stage: 'finding_rider', stageDeadline, cancelDeadline } },
        { new: true },
      );
      acceptedSubOrder = claimed.subOrders[claimed.subOrders.length - 1];
    }

    // ── Shared side-effects (both paths), scoped to the accepted sub-order ──
    // Deduct inventory (stub today — no-op)
    axios
      .post(
        `http://localhost:${process.env.PORT || 3004}/internal/deduct-inventory`,
        { orderId: claimed._id.toString(), vendorId },
        { timeout: 5000 },
      )
      .catch((err) => logger.warn(`deduct-inventory on vendor accept failed for order ${claimed._id}: ${err.message}`));

    // Clean up Redis routing state (no-op for the inline group model, harmless)
    await clearRoutingState(claimed._id);

    // Notify customer: vendor confirmed, now finding rider (include cancel deadline for countdown)
    await emitToCustomer(claimed.customerId.toString(), 'order:status', {
      orderId: claimed._id.toString(),
      status: 'vendor_confirmed',
      cancelDeadline: (claimed.cancelDeadline || cancelDeadline).toISOString(),
    });
    triggerNotification('order:confirmed', claimed.customerId.toString(), 'customer', {
      orderId: claimed._id.toString(),
    });

    // ── Rider assignment — ONE rider per order, fired EXACTLY ONCE when coverage completes ──
    // Legacy orders (no groups) assign immediately, as today. For the group model, only the
    // accept that atomically flips riderAssignmentTriggered false→true dispatches assignment —
    // so a last-two-accepts race dispatches exactly one rider (never two, never zero). Because
    // claimGroup makes claim+sub-order-push atomic, "every group claimed" guarantees every
    // sub-order is present before this fires.
    let assignOrder = null;
    if (groups.length === 0) {
      assignOrder = claimed; // legacy single sub-order, single pickup
    } else {
      assignOrder = await Order.findOneAndUpdate(
        {
          _id: order._id,
          'routingMeta.riderAssignmentTriggered': { $ne: true },
          'routingMeta.groups': { $not: { $elemMatch: { status: { $ne: 'claimed' } } } }, // all groups claimed
        },
        { $set: { 'routingMeta.riderAssignmentTriggered': true } },
        { new: true },
      );
      // null → coverage not complete yet, or another accept already dispatched → do nothing here
    }

    if (assignOrder) {
      const subs = assignOrder.subOrders;
      const dropLocation = subs[0].dropLocation;
      if (subs.length === 1) {
        // Single pickup — unchanged endpoint + payload (the live single-vendor path).
        axios
          .post(`http://localhost:${process.env.PORT_DELIVERY || 3006}/internal/assign-rider`, {
            orderId:              assignOrder._id.toString(),
            subOrderId:           subs[0]._id.toString(),
            vendorId:             subs[0].vendorId.toString(),
            customerId:           assignOrder.customerId.toString(),
            pickupLocation:       subs[0].pickupLocation,
            dropLocation,
            deliveryFee:          assignOrder.deliveryFee,
            deliveryInstructions: assignOrder.deliveryInstructions || '',
            paymentMethod:        assignOrder.paymentMethod || 'cod',
            totalAmount:          assignOrder.totalAmount || 0,
          }, { timeout: 5000 })
          .catch((err) => logger.warn(`assign-rider (single) failed for order ${assignOrder._id}: ${err.message}`));
      } else {
        // Multi-pickup — ONE rider visits every vendor, then the customer.
        axios
          .post(`http://localhost:${process.env.PORT_DELIVERY || 3006}/internal/assign-rider-multi`, {
            orderId:              assignOrder._id.toString(),
            customerId:           assignOrder.customerId.toString(),
            pickups:              subs.map((so) => ({
              vendorId:       so.vendorId.toString(),
              subOrderId:     so._id.toString(),
              pickupLocation: so.pickupLocation,
            })),
            dropLocation,
            deliveryFee:          assignOrder.deliveryFee,
            deliveryInstructions: assignOrder.deliveryInstructions || '',
            paymentMethod:        assignOrder.paymentMethod || 'cod',
            totalAmount:          assignOrder.totalAmount || 0,
          }, { timeout: 5000 })
          .catch((err) => logger.warn(`assign-rider-multi failed for order ${assignOrder._id}: ${err.message}`));
      }
    }

    return sendSuccess(res, 200, 'Order accepted', { orderId: claimed._id });
  } catch (err) {
    logger.error('vendorAcceptOrder error:', err);
    return sendError(res, 500, 'Failed to accept order', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /api/orders/vendor/:id/reject ──────────────────────────
// Vendor rejects → try next vendor via routing cascade. Only cancel if no vendors left.
const vendorRejectOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return sendError(res, 404, 'Order not found', ERROR_CODES.NOT_FOUND);
    if (order.status === ORDER_STATUS.CANCELLED) {
      return sendSuccess(res, 200, 'Order already cancelled');
    }

    const vendorId = req.user.id;

    // Verify vendor was offered this order
    const wasOffered = order.routingMeta?.currentVendorId?.toString() === vendorId
      || order.routingMeta?.offeredVendorIds?.map((id) => id.toString()).includes(vendorId);
    if (!wasOffered) {
      return sendError(res, 403, 'This order was not offered to you', ERROR_CODES.FORBIDDEN);
    }

    order.routingMeta.rejectedVendorIds.push(vendorId);
    await order.save();

    // Try to cascade to next vendor via routing logic
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

    const terminalStatuses = [SUB_ORDER_STATUS.DELIVERED, SUB_ORDER_STATUS.FAILED, SUB_ORDER_STATUS.RETURNED];
    if (status && terminalStatuses.includes(status)) {
      matchFilter['subOrders.status'] = status;
    } else {
      // Include delivered, failed, AND cancelled (parent-level) orders
      matchFilter.$or = [
        { 'subOrders.status': { $in: terminalStatuses } },
        { status: { $in: [ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED] } },
      ];
    }

    // Fetch one extra to know if there are more pages (avoids separate count query)
    const orders = await Order.find(matchFilter)
      .select('items totalAmount status createdAt subOrders customerId deliveryInstructions paymentMethod paymentStatus')
      .populate('customerId', 'name phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(take + 1)
      .lean();

    const hasMore = orders.length > take;
    if (hasMore) orders.pop();

    const mapped = orders.map((o) => {
      const vendorSub = o.subOrders?.find((s) => s.vendorId?.toString() === vendorId);
      // Calculate vendor amount from buying prices
      const vendorAmount = (vendorSub?.items || o.items || []).reduce(
        (sum, item) => sum + (item.buyingPrice ?? 0) * (item.quantity ?? 1), 0,
      );
      return {
        _id: o._id,
        status: o.status,
        subOrderStatus: vendorSub?.status,
        totalAmount: o.totalAmount,
        vendorAmount,
        itemCount: o.items?.length || 0,
        customerName: o.customerId?.name || 'Customer',
        createdAt: o.createdAt,
        deliveredAt: vendorSub?.deliveredAt,
        paymentMethod: o.paymentMethod || 'cod',
        paymentStatus: o.paymentStatus || 'pending',
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
        // Compute vendor amount (buying price) per order
        $addFields: {
          vendorAmount: {
            $sum: {
              $map: {
                input: '$items',
                as: 'item',
                in: { $multiply: [{ $ifNull: ['$$item.buyingPrice', 0] }, '$$item.quantity'] },
              },
            },
          },
        },
      },
      {
        $group: {
          _id: {
            $cond: [{ $gte: ['$createdAt', todayStart] }, 'today', 'yesterday'],
          },
          count: { $sum: 1 },
          avgTotal: { $avg: '$vendorAmount' },
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

// ── POST /internal/cancel-order ───────────────────────────────────
// Called by Delivery Service when no rider is available.
// ── GET /api/orders/active ────────────────────────────────────────
// Customer: get their currently active order (if any).
const getActiveOrder = async (req, res) => {
  try {
    const activeStatuses = [ORDER_STATUS.STOCK_CHECK, ORDER_STATUS.AWAITING_PAYMENT, ORDER_STATUS.CONFIRMED, ORDER_STATUS.PARTIALLY_DELIVERED];
    const order = await Order.findOne({
      customerId: req.user.id,
      status: { $in: activeStatuses },
    }).sort({ createdAt: -1 });

    return sendSuccess(res, 200, 'Active order', { order: order || null });
  } catch (err) {
    logger.error('getActiveOrder error:', err);
    return sendError(res, 500, 'Failed to fetch active order', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /api/orders/vendor/active ────────────────────────────────
// Vendor: get their currently active orders.
const getVendorActiveOrders = async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const vendorOid = new mongoose.Types.ObjectId(req.user.id);
    const activeSubStatuses = [SUB_ORDER_STATUS.VENDOR_ACCEPTED, SUB_ORDER_STATUS.RIDER_ASSIGNED, SUB_ORDER_STATUS.PICKED];
    const orders = await Order.find({
      status: { $nin: [ORDER_STATUS.CANCELLED, ORDER_STATUS.DELIVERED] },
      'subOrders.vendorId': vendorOid,
      'subOrders.status': { $in: activeSubStatuses },
    }).populate('customerId', 'name phone').sort({ createdAt: -1 }).lean();

    // Fetch OTPs from delivery service for these orders
    let otpMap = {};
    if (orders.length > 0) {
      try {
        const otpRes = await axios.post(
          `http://localhost:${process.env.PORT_DELIVERY || 3006}/internal/order-otps`,
          { orderIds: orders.map((o) => o._id.toString()) },
          { timeout: 3000 },
        );
        if (otpRes.data?.success) otpMap = otpRes.data.data || {};
      } catch { /* non-fatal — OTPs just won't show */ }
    }

    // Add vendorAmount and OTPs for each order
    const enriched = orders.map((o) => {
      const vendorSub = o.subOrders?.find((s) => s.vendorId?.toString() === req.user.id);
      const otps = otpMap[o._id.toString()] || {};
      return {
        ...o,
        vendorAmount: (vendorSub?.items || o.items || []).reduce(
          (sum, item) => sum + (item.buyingPrice ?? 0) * (item.quantity ?? 1), 0,
        ),
        pickupOtp: otps.pickupOtp || null,
        returnOtp: otps.returnOtp || null,
      };
    });

    return sendSuccess(res, 200, 'Active vendor orders', { orders: enriched });
  } catch (err) {
    logger.error('getVendorActiveOrders error:', err);
    return sendError(res, 500, 'Failed to fetch active orders', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /internal/cancel-order ───────────────────────────────────
const internalCancelOrder = async (req, res) => {
  try {
    const { orderId, reason } = req.body;
    if (!orderId) return res.status(400).json({ success: false, message: 'orderId required' });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    // Only cancel if not already in a terminal state
    if ([ORDER_STATUS.CANCELLED, ORDER_STATUS.DELIVERED].includes(order.status)) {
      return res.json({ success: true, message: 'Order already in terminal state' });
    }

    order.status = ORDER_STATUS.CANCELLED;
    order.cancelledAt = new Date();
    order.cancelReason = reason || 'no_rider_available';
    // Mark all non-terminal sub-orders as failed
    for (const sub of order.subOrders) {
      if (![SUB_ORDER_STATUS.DELIVERED, SUB_ORDER_STATUS.FAILED].includes(sub.status)) {
        sub.status = SUB_ORDER_STATUS.FAILED;
      }
    }
    await order.save();

    // Restore inventory for each vendor sub-order via /internal/restore-stock
    for (const sub of order.subOrders) {
      const vendorId = (sub.vendorId?._id ?? sub.vendorId)?.toString();
      if (vendorId) {
        try {
          await axios.post(
            `http://localhost:${process.env.PORT_ORDER || 3004}/internal/restore-stock`,
            { orderId: order._id.toString(), vendorId },
            { timeout: 5000 },
          );
        } catch (err) {
          logger.warn(`restore-stock failed for order ${orderId} vendor ${vendorId}: ${err.message}`);
        }
      }
    }

    // Release coupon if used
    if (order.couponCode) {
      releaseCouponByCode(order.couponCode, order.customerId).catch((err) =>
        logger.error('releaseCoupon error:', err),
      );
    }

    // Reverse vendor earning for each sub-order (if any was created)
    for (const sub of order.subOrders) {
      try {
        await axios.post(
          `http://localhost:${process.env.PORT_ORDER || 3004}/internal/reverse-vendor-earning`,
          { orderId: order._id.toString(), subOrderId: sub._id.toString(), reason: reason || 'order_cancelled' },
          { timeout: 5000 },
        );
      } catch (err) {
        logger.warn(`reverse-vendor-earning failed for subOrder ${sub._id}: ${err.message}`);
      }
    }

    // Trigger refund if the order was paid via UPI
    if (order.paymentStatus === 'paid') {
      try {
        await axios.post(
          `http://localhost:${process.env.PORT_PAYMENT || 3007}/internal/refund-by-order`,
          { orderId: order._id.toString() },
          { timeout: 5000 },
        );
      } catch (err) {
        logger.error(`Refund trigger failed for order ${orderId}: ${err.message}`);
      }
    }

    // Notify customer
    const friendlyMessage =
      reason === 'no_rider_available'
        ? 'No delivery partner was available in time. Your order was cancelled — please try again in a few minutes.'
        : reason === 'no_vendor_response'
        ? 'No store accepted your order in time. Your order was cancelled — please try again in a few minutes.'
        : 'Your order has been cancelled.';
    const cancelPayload = {
      orderId: order._id.toString(),
      status: 'cancelled',
      reason: reason || 'cancelled',
      message: friendlyMessage,
    };
    await emitToCustomer(order.customerId.toString(), 'order:status', cancelPayload);

    // Push notification so the customer is told even if the app is closed or the
    // phone is off (delivered when it next comes online).
    triggerNotification('order:cancelled', order.customerId.toString(), 'customer', {
      orderId: order._id.toString(),
      title: 'Order cancelled',
      body: friendlyMessage,
    });

    // Also emit to order tracking room so the tracking screen updates in real-time
    try {
      await axios.post(
        `http://localhost:${process.env.PORT_SOCKET || 3010}/internal/emit`,
        { room: `order:tracking:${order._id.toString()}`, event: 'order:status', payload: cancelPayload },
        { timeout: 3000 },
      );
    } catch (err) {
      logger.warn(`Tracking room emit failed for order ${orderId}: ${err.message}`);
    }

    // Notify vendor(s)
    for (const sub of order.subOrders) {
      const vendorId = (sub.vendorId?._id ?? sub.vendorId)?.toString();
      if (vendorId) {
        emitToVendor(vendorId, 'order:status', {
          orderId: order._id.toString(),
          status: 'cancelled',
          message: reason === 'no_rider_available'
            ? 'Order cancelled — no rider available.'
            : `Order cancelled: ${reason || 'cancelled'}`,
        });
        const msg = reason === 'no_rider_available'
          ? `Order #${order._id.toString().slice(-4)} cancelled — no rider available`
          : `Order #${order._id.toString().slice(-4)} cancelled`;
        notifyVendor(vendorId, 'order:cancelled', 'Order Cancelled', msg, order._id.toString());
      }
    }

    logger.info(`Order ${orderId} cancelled internally: ${reason}`);
    return res.json({ success: true });
  } catch (err) {
    logger.error('internalCancelOrder error:', err);
    return res.status(500).json({ success: false });
  }
};

// ── POST /api/orders/vendor/reset-all (TEST MODE ONLY) ─────────────
// Cancel all active orders for this vendor and reset state.
const vendorResetAllOrders = async (req, res) => {
  try {
    const vendorId = req.user.id;
    const mongoose = require('mongoose');
    const vendorOid = new mongoose.Types.ObjectId(vendorId);

    // Find all non-terminal orders that have a sub-order for this vendor
    const activeSubStatuses = [
      SUB_ORDER_STATUS.VENDOR_ACCEPTED,
      SUB_ORDER_STATUS.RIDER_ASSIGNED,
      SUB_ORDER_STATUS.PICKED,
    ];
    const orders = await Order.find({
      status: { $nin: [ORDER_STATUS.CANCELLED, ORDER_STATUS.DELIVERED] },
      'subOrders.vendorId': vendorOid,
      'subOrders.status': { $in: activeSubStatuses },
    });

    let cancelledCount = 0;

    for (const order of orders) {
      order.status = ORDER_STATUS.CANCELLED;
      order.cancelledAt = new Date();
      order.cancelReason = 'vendor_test_reset';
      // Also mark active sub-orders as failed
      for (const sub of order.subOrders) {
        if (activeSubStatuses.includes(sub.status)) {
          sub.status = SUB_ORDER_STATUS.FAILED;
        }
      }
      await order.save();

      // Restore stock
      for (const sub of order.subOrders) {
        const vid = (sub.vendorId?._id ?? sub.vendorId)?.toString();
        if (vid) {
          try {
            await axios.post(
              `http://localhost:${process.env.PORT_ORDER || 3004}/internal/restore-stock`,
              { orderId: order._id.toString(), vendorId: vid },
              { timeout: 5000 },
            );
          } catch (err) {
            logger.warn(`restore-stock failed during vendor reset for order ${order._id}: ${err.message}`);
          }
        }
      }

      // Reverse vendor earnings
      for (const sub of order.subOrders) {
        try {
          await axios.post(
            `http://localhost:${process.env.PORT_ORDER || 3004}/internal/reverse-vendor-earning`,
            { orderId: order._id.toString(), subOrderId: sub._id.toString(), reason: 'vendor_test_reset' },
            { timeout: 5000 },
          );
        } catch (err) {
          logger.warn(`reverse-vendor-earning failed during vendor reset: ${err.message}`);
        }
      }

      // Cancel delivery jobs and free riders
      try {
        await axios.post(
          `http://localhost:${process.env.PORT_DELIVERY || 3006}/internal/cancel-jobs`,
          { orderId: order._id.toString() },
          { timeout: 5000 },
        );
      } catch (err) {
        logger.warn(`cancel-jobs failed during vendor reset for order ${order._id}: ${err.message}`);
      }

      // Trigger refund if paid
      if (order.paymentStatus === 'paid') {
        try {
          await axios.post(
            `http://localhost:${process.env.PORT_PAYMENT || 3007}/internal/refund-by-order`,
            { orderId: order._id.toString() },
            { timeout: 5000 },
          );
        } catch (err) {
          logger.warn(`refund failed during vendor reset for order ${order._id}: ${err.message}`);
        }
      }

      // Notify customer
      emitToCustomer(order.customerId.toString(), 'order:status', {
        orderId: order._id.toString(),
        status: 'cancelled',
        message: 'Your order has been cancelled.',
      });

      cancelledCount++;
    }

    logger.info(`[TEST] Vendor ${vendorId} reset — ${cancelledCount} orders cancelled`);
    return sendSuccess(res, 200, 'All active orders cancelled', { cancelledCount });
  } catch (err) {
    logger.error('vendorResetAllOrders error:', err);
    return sendError(res, 500, 'Failed to reset orders', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = {
  checkStockController,
  placeOrder,
  getOrders,
  getOrderById,
  cancelOrder,
  rateOrder,
  getActiveOrder,
  getVendorIncoming,
  getVendorHistory,
  getVendorStats,
  getVendorActiveOrders,
  vendorAcceptOrder,
  vendorRejectOrder,
  validateCouponController,
  internalCancelOrder,
  vendorResetAllOrders,
};
