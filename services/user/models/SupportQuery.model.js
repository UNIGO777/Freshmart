const mongoose = require('mongoose');

const replySchema = new mongoose.Schema(
  {
    from: { type: String, enum: ['customer', 'admin'], required: true },
    text: { type: String, required: true, maxlength: 2000 },
  },
  { timestamps: true }
);

const supportQuerySchema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true },
    customerName: { type: String },
    message: { type: String, required: true, maxlength: 2000 },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    replies: [replySchema],
  },
  { timestamps: true }
);

supportQuerySchema.index({ customerId: 1, createdAt: -1 });

module.exports = mongoose.model('SupportQuery', supportQuerySchema);
