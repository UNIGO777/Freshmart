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
    quantity: { type: Number, required: true, min: 1 },
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

    // Routing metadata — tracks cascade progress
    routingMeta: {
      batchIndex: { type: Number, default: 0 },          // Which batch of vendors we're on
      allVendorIds: [mongoose.Schema.Types.ObjectId],    // All vendors considered (sorted by distance)
      offeredVendorIds: [mongoose.Schema.Types.ObjectId],// Vendors currently offered the order
      rejectedVendorIds: [mongoose.Schema.Types.ObjectId],
    },

    ratings: ratingSchema,
    cancelledAt: Date,
    cancelReason: String,
  },
  { timestamps: true },
);

// Index for vendor queries (incoming, history, stats)
orderSchema.index({ 'subOrders.vendorId': 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
