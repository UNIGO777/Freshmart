const mongoose = require('mongoose');

const bannerSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
      default: '',
    },

    imageUrl: {
      type: String,
      required: true,
      trim: true,
    },

    linkUrl: {
      type: String,
      trim: true,
      default: '',
    },

    position: {
      type: Number,
      default: 0,
    },

    isActive: {
      type: Boolean,
      default: false,
    },

    type: {
      type: String,
      enum: ['hero', 'deal_of_day'],
      default: 'hero',
    },
  },
  { timestamps: true },
);

bannerSchema.index({ type: 1, isActive: 1, position: 1 });

module.exports = mongoose.model('Banner', bannerSchema);
