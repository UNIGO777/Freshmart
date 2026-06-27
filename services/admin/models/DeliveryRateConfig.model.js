const mongoose = require('mongoose');

const deliveryRateConfigSchema = new mongoose.Schema(
  {
    ratePerKm:              { type: Number, default: 11, min: 0 },
    surgeMultiplier:        { type: Number, default: 1.0, min: 1.0 },
    surgeActive:            { type: Boolean, default: false },
    surgeReason:            { type: String, default: '' },
    surgeStartedAt:         { type: Date, default: null },
    deliveryFee:            { type: Number, default: 69, min: 0 },
    freeDeliveryThreshold:  { type: Number, default: 99, min: 0 },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
  },
  { timestamps: true },
);

/**
 * Get the singleton config document, creating a default if none exists.
 */
deliveryRateConfigSchema.statics.getConfig = async function () {
  let config = await this.findOne();
  if (!config) {
    config = await this.create({});
  }
  return config;
};

module.exports = mongoose.model('DeliveryRateConfig', deliveryRateConfigSchema);
