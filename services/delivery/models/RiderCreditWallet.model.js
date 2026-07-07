const mongoose = require('mongoose');

const riderCreditWalletSchema = new mongoose.Schema(
  {
    riderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rider',
      required: true,
      unique: true,
      index: true,
    },
    balance:        { type: Number, default: 0 },
    totalCollected: { type: Number, default: 0 },
    totalSettled:   { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('RiderCreditWallet', riderCreditWalletSchema);
