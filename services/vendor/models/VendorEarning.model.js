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

    // Customer-side sale total for the vendor's fulfilled items.
    salesAmount: { type: Number, required: true },

    // Vendor payout is based on buying price, not a commission deduction.
    netAmount: { type: Number, required: true },

    // Platform margin = salesAmount - netAmount.
    marginAmount: { type: Number, required: true },

    status: {
      type: String,
      enum: ['pending', 'paid', 'reversed'],
      default: 'pending',
    },
    paidAt: { type: Date },
    reversedAt: { type: Date, default: null },
    reverseReason: { type: String, default: null },

    // Date of the order — useful for daily/weekly aggregations
    earningDate: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('VendorEarning', vendorEarningSchema);
