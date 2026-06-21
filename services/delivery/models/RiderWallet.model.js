const mongoose = require('mongoose');

const riderWalletSchema = new mongoose.Schema(
  {
    riderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rider',
      required: true,
      unique: true,
      index: true,
    },
    balance:         { type: Number, default: 0 },
    totalEarned:     { type: Number, default: 0 },
    totalWithdrawn:  { type: Number, default: 0 },
    totalDeductions: { type: Number, default: 0 },
  },
  { timestamps: true },
);

module.exports = mongoose.model('RiderWallet', riderWalletSchema);
