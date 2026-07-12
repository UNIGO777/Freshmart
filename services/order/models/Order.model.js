const mongoose = require('mongoose');
const { ORDER_STATUS, SUB_ORDER_STATUS, PAYMENT_STATUS } = require('../../../shared/constants/orderStatus');

// ── Sub-order item ────────────────────────────────────────────────
const subOrderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 0 },
    buyingPrice: { type: Number, required: true },   // Vendor earns this
    sellingPrice: { type: Number, required: true },  // Customer pays this
  },
  { _id: false },
);

// ── Sub-order (one per vendor) ────────────────────────────────────
const subOrderSchema = new mongoose.Schema(
  {
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' },
    items: [subOrderItemSchema],
    riderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Rider' },
    status: {
      type: String,
      enum: Object.values(SUB_ORDER_STATUS),
      default: SUB_ORDER_STATUS.PENDING,
    },
    pickupLocation: {
      lat: Number,
      lng: Number,
      fullAddress: String,
    },
    dropLocation: {
      lat: Number,
      lng: Number,
      fullAddress: String,
    },
    // Timestamps for each sub-order status transition
    vendorAcceptedAt: Date,
    riderAssignedAt: Date,
    pickedAt: Date,
    deliveredAt: Date,
  },
  { timestamps: true },
);

// ── Top-level order item ──────────────────────────────────────────
const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true, min: 0 }, // kg (fractional: 0.25 = 250g); positivity enforced at the API
    sellingPrice: { type: Number, required: true },
    buyingPrice: { type: Number, required: true },
    name: String,        // Snapshot at time of order
    category: String,
  },
  { _id: false },
);

// ── Rating ────────────────────────────────────────────────────────
const ratingSchema = new mongoose.Schema(
  {
    product: { type: Number, min: 1, max: 5 },
    rider: { type: Number, min: 1, max: 5 },
    vendor: { type: Number, min: 1, max: 5 },
    comment: String,
    ratedAt: Date,
  },
  { _id: false },
);

// ── Main Order ────────────────────────────────────────────────────
const orderSchema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },

    items: [orderItemSchema],

    subOrders: [subOrderSchema],

    deliveryAddress: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
      fullAddress: { type: String, required: true },
      label: String,
    },

    paymentMethod: {
      type: String,
      enum: ['upi', 'cod'],
    },
    paymentStatus: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.PENDING,
    },

    deliveryInstructions: { type: String, maxlength: 500, default: '' },

    couponCode: String,
    discountAmount: { type: Number, default: 0 },
    deliveryFee: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true },    // After discount + delivery

    status: {
      type: String,
      enum: Object.values(ORDER_STATUS),
      default: ORDER_STATUS.STOCK_CHECK,
      index: true,
    },

    // Fulfillment sub-phase while the parent order is still being routed. Gives
    // the customer app an authoritative, persisted live status ("sending to a
    // store" → "finding a rider" → "assigned") that survives app restarts,
    // instead of inferring it. null once the order is picked up / terminal.
    stage: {
      type: String,
      enum: ['finding_vendor', 'finding_rider', 'assigned', null],
      default: null,
    },

    // When the current finding stage will time out — powers the countdown on
    // the customer "finding a store / rider" screen. null once past routing.
    stageDeadline: { type: Date, default: null },

    // Routing metadata — tracks cascade progress
    routingMeta: {
      batchIndex: { type: Number, default: 0 },          // Which batch of vendors we're on
      allVendorIds: [mongoose.Schema.Types.ObjectId],    // All vendors considered (sorted by distance)
      offeredVendorIds: [mongoose.Schema.Types.ObjectId],// Vendors currently offered the order
      rejectedVendorIds: [mongoose.Schema.Types.ObjectId],
      // Multi-vendor category split (M0). One entry per category-group; each is
      // offered to its category's vendors and claimed all-or-nothing by exactly
      // one of them (see logic/orderGrouping.js). Empty for legacy single-vendor.
      groups: [{
        groupKey: String,                                          // the category, e.g. 'veg'
        category: String,
        productIds: [mongoose.Schema.Types.ObjectId],              // items in this group
        offeredVendorIds: [mongoose.Schema.Types.ObjectId],        // eligible vendors for this group (≤3)
        claimedByVendorId: { type: mongoose.Schema.Types.ObjectId, default: null }, // null = open
        status: { type: String, enum: ['open', 'claimed', 'failed'], default: 'open' },
        deadline: Date,                                            // per-group TTL (M3)
      }],
      // MR once-only guard: the accept that COMPLETES coverage (all groups claimed)
      // flips this false→true atomically and is the sole trigger of rider assignment,
      // so a simultaneous last-two-accepts race assigns exactly one rider (never two, never zero).
      riderAssignmentTriggered: { type: Boolean, default: false },
    },

    ratings: ratingSchema,
    cancelDeadline: { type: Date, default: null }, // 1-minute window after vendor accept
    cancelledAt: Date,
    cancelReason: String,
  },
  { timestamps: true },
);

// Index for vendor queries (incoming, history, stats)
orderSchema.index({ 'subOrders.vendorId': 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
