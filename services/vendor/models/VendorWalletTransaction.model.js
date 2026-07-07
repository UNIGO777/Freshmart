const mongoose = require('mongoose');

const TRANSACTION_TYPES = {
  EARNING:   'earning',
  PAYOUT:    'payout',
  DEDUCTION: 'deduction',
};

const vendorWalletTransactionSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: Object.values(TRANSACTION_TYPES),
      required: true,
      index: true,
    },
    amount:       { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    description:  { type: String, default: '' },
    reference:    { type: String, default: '' }, // UTR / UPI reference for payouts

    // Admin who processed the payout / deduction
    processedBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'Admin', default: null },
    processedByName: { type: String, default: '' },
  },
  { timestamps: true },
);

// Paginated history per vendor, newest first
vendorWalletTransactionSchema.index({ vendorId: 1, createdAt: -1 });

module.exports = mongoose.model('VendorWalletTransaction', vendorWalletTransactionSchema);
module.exports.TRANSACTION_TYPES = TRANSACTION_TYPES;
