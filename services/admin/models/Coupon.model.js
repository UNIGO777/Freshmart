const mongoose = require('mongoose');

const couponSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    discountType: {
      type: String,
      enum: ['flat', 'percent'],
      required: true,
    },

    discountValue: {
      type: Number,
      required: true,
      min: 0,
      // For 'percent': 0–100. For 'flat': rupee amount.
    },

    // Maximum rupee discount for percent coupons (optional cap)
    maxDiscountAmount: {
      type: Number,
      default: null,
    },

    minOrderValue: {
      type: Number,
      default: 0,
    },

    maxUses: {
      type: Number,
      default: null, // null = unlimited
    },

    usedCount: {
      type: Number,
      default: 0,
    },

    // Per-user usage limit (null = unlimited)
    maxUsesPerUser: {
      type: Number,
      default: 1,
    },

    // Track which customers have used this coupon
    usedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Customer' }],

    validFrom: { type: Date, required: true },
    validTo: { type: Date, required: true },

    isActive: { type: Boolean, default: true },

    description: { type: String },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Coupon', couponSchema);
