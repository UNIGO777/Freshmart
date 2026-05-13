const mongoose = require('mongoose');

const payoutRecordSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
      index: true,
    },

    vendorName: { type: String, default: '' },

    amount: { type: Number, required: true },

    orderCount: { type: Number, default: 0 },

    // ISO week window this payout covers
    weekStart: { type: Date, required: true },
    weekEnd:   { type: Date, required: true },

    // Admin who approved
    approvedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', required: true },
    approvedByName: { type: String, default: '' },

    paidAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

payoutRecordSchema.index({ vendorId: 1, weekStart: 1 }, { unique: true });

module.exports = mongoose.model('PayoutRecord', payoutRecordSchema);
