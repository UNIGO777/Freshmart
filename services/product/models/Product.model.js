const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    nameHi: { type: String, trim: true },   // Hindi name

    category: {
      type: String,
      required: true,
      enum: ['fruits', 'vegetables', 'spices', 'dairy', 'bakery', 'other'],
      index: true,
    },

    // Price unit is always kg — enforced at application level
    unit: { type: String, default: 'kg', enum: ['kg'] },

    description: { type: String, trim: true, default: '' },

    availableSeason: {
      type: String,
      enum: ['summer', 'winter', 'rain', 'all'],
      default: 'all',
    },

    images: [{ type: String }],
    coverImage: { type: String, default: '' },

    // Admin-managed pricing (all per kg)
    listedPrice: {
      type: Number,
      min: 0,
      default: 0,
      // MRP / market reference price shown to customers
    },
    buyingPrice: {
      type: Number,
      required: true,
      min: 0,
      // Vendor payout per kg
    },
    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
      // Customer-facing price per kg
    },
    active: { type: Boolean, default: true, index: true },

    // Admin toggles this daily; if not touched it carries forward from prior day
    isAvailableToday: { type: Boolean, default: true, index: true },

    // Tracks when price/availability was last explicitly changed
    lastPricedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    // updatedAt from timestamps acts as the carry-forward reference
  },
);

// Text index for search
productSchema.index({ name: 'text', nameHi: 'text' });

module.exports = mongoose.model('Product', productSchema);
