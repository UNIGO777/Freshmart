const mongoose = require('mongoose');

const vendorEarningSchema = new mongoose.Schema(
  {
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
      required: true,
      index: true,
    },
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
    },
    subOrderId: {
      // Sub-order within the parent order
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },

    // Gross earning = sum of (buyingPrice * qty) for items vendor fulfilled
    grossAmount: { type: Number, required: true },

    // Platform commission deducted
    commissionPercent: { type: Number, required: true },
    commissionAmount: { type: Number, required: true },

    // Net payout = grossAmount - commissionAmount
    netAmount: { type: Number, required: true },

    status: {
      type: String,
      enum: ['pending', 'paid'],
      default: 'pending',
    },
    paidAt: { type: Date },

    // Date of the order — useful for daily/weekly aggregations
    earningDate: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('VendorEarning', vendorEarningSchema);
