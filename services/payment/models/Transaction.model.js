const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
      required: true,
      index: true,
    },

    // PhonePe identifiers
    merchantTransactionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    phonepeTransactionId: {
      type: String,          // Filled after payment success from PhonePe callback
      sparse: true,
      index: true,
    },

    amount: { type: Number, required: true },  // In paise (₹1 = 100 paise)
    method: {
      type: String,
      enum: ['upi', 'cod'],
      required: true,
    },
    status: {
      type: String,
      enum: ['created', 'paid', 'refunded', 'failed'],
      default: 'created',
    },

    // PhonePe callback payload snapshot for audit
    callbackPayload: { type: mongoose.Schema.Types.Mixed },

    refundTransactionId: { type: String },
    refundedAt: { type: Date },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Transaction', transactionSchema);
