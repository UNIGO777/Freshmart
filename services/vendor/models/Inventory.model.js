const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
      index: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
    quantityAvailable: {
      type: Number,
      min: 0,
      default: 0,
    },
    isAvailable: { type: Boolean, default: true },
  },
  { timestamps: true },
);

// One inventory record per vendor+product pair
inventorySchema.index({ vendorId: 1, productId: 1 }, { unique: true });

module.exports = mongoose.model('Inventory', inventorySchema);
