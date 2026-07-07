const mongoose = require('mongoose');

const TRANSACTION_TYPES = {
  EARNING:    'earning',
  WITHDRAWAL: 'withdrawal',
  DEDUCTION:  'deduction',
  COLLECTION: 'collection',
  SETTLEMENT: 'settlement',
};

const walletTransactionSchema = new mongoose.Schema(
  {
    riderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rider',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: Object.values(TRANSACTION_TYPES),
      required: true,
      index: true,
    },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },

    // Linked delivery job (for earnings)
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DeliveryJob',
      default: null,
    },

    walletType: {
      type: String,
      enum: ['earnings', 'credit'],
      default: 'earnings',
    },
    description: { type: String, default: '' },
    reason:      { type: String, default: '' }, // Admin reason for deductions

    // Admin who processed withdrawal/deduction
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
    processedByName: { type: String, default: '' },

    status: {
      type: String,
      enum: ['completed', 'pending'],
      default: 'completed',
    },
  },
  { timestamps: true },
);

// Index for paginated queries
walletTransactionSchema.index({ riderId: 1, createdAt: -1 });
walletTransactionSchema.index({ riderId: 1, type: 1, createdAt: -1 });

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
module.exports.TRANSACTION_TYPES = TRANSACTION_TYPES;
