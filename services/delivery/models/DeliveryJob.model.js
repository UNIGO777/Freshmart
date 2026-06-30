const mongoose = require('mongoose');

const DELIVERY_JOB_STATUS = {
  PENDING:   'pending',    // Created — waiting for rider batch to be offered
  OFFERED:   'offered',    // Batch of riders offered, 30s window active
  ACCEPTED:  'accepted',   // A rider accepted — in transit to vendor
  PICKED:    'picked',     // Rider marked picked up from vendor
  DELIVERED: 'delivered',  // Rider marked delivered to customer
  FAILED:    'failed',     // All riders exhausted with no acceptance
  CANCELLED: 'cancelled',  // Order/sub-order was cancelled
};

const locationSchema = new mongoose.Schema(
  {
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    fullAddress: { type: String, default: '' },
  },
  { _id: false },
);

const deliveryJobSchema = new mongoose.Schema(
  {
    // ── References ─────────────────────────────────────────────────
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true,
    },
    subOrderId: {
      // The _id of the sub-order within Order.subOrders
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },

    // ── Assigned rider (null until accepted) ───────────────────────
    riderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rider',
      default: null,
      index: true,
    },

    // ── Locations ──────────────────────────────────────────────────
    pickupLocation: { type: locationSchema, required: true },  // Vendor location
    dropLocation:   { type: locationSchema, required: true },  // Customer address

    // ── Status ─────────────────────────────────────────────────────
    status: {
      type: String,
      enum: Object.values(DELIVERY_JOB_STATUS),
      default: DELIVERY_JOB_STATUS.PENDING,
      index: true,
    },

    // ── Rider offer tracking ───────────────────────────────────────
    offeredRiderIds:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'Rider' }],
    rejectedRiderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Rider' }],
    batchIndex: { type: Number, default: 0 },

    // When the current batch's 30s window expires (used by background sweep)
    offerExpiresAt: { type: Date },

    // ── Financials ─────────────────────────────────────────────────
    deliveryFee:     { type: Number, default: 0 }, // Total delivery fee charged to customer
    riderEarnings:   { type: Number, default: 0 }, // Rider's cut = distanceKm × ratePerKm × surgeMultiplier
    ratePerKm:       { type: Number, default: 0 }, // Locked at job creation time
    surgeMultiplier: { type: Number, default: 1 }, // Locked at job creation time
    distanceKm:      { type: Number, default: 0 }, // Haversine distance: pickup → drop

    // ── Per-leg distances (Google Maps road distance) ────────────────
    distanceRiderToVendor:    { type: Number, default: 0 },
    distanceVendorToCustomer: { type: Number, default: 0 },

    // ── OTP verification codes ────────────────────────────────────
    pickupOtp:   { type: String, default: null },  // 4-digit, generated on rider accept, verified at pickup
    deliveryOtp: { type: String, default: null },  // 4-digit, generated on pickup, verified at delivery
    returnOtp:   { type: String, default: null },  // 4-digit, generated on rider cancel request

    // ── Rider cancellation ────────────────────────────────────────
    cancelledByRider:   { type: Boolean, default: false },
    riderCancelReason:  { type: String, default: null },
    returnedAt:         { type: Date, default: null },

    // ── Delivery instructions from customer ─────────────────────────
    deliveryInstructions: { type: String, default: '' },

    // ── Status timestamps ──────────────────────────────────────────
    assignedAt:  { type: Date },
    pickedAt:    { type: Date },
    deliveredAt: { type: Date },
  },
  { timestamps: true },
);

const DeliveryJob = mongoose.model('DeliveryJob', deliveryJobSchema);

module.exports = DeliveryJob;
module.exports.DELIVERY_JOB_STATUS = DELIVERY_JOB_STATUS;
