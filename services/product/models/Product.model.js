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

    unit: {
      type: String,
      required: true,
      enum: ['kg', 'g', 'piece', 'dozen'],
    },

    availableSeason: { type: String, enum: ['summer', 'winter', 'rain', 'all'] },

    images: [{ type: String }],
    coverImage: { type: String, default: '' },

    // Admin-managed pricing
    buyingPrice: {
      type: Number,
      required: true,
      min: 0,
      // Visible to vendors — what they'll earn per unit
    },
    sellingPrice: {
      type: Number,
      required: true,
      min: 0,
      // Visible to customers — what they pay
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
