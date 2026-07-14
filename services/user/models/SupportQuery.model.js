const mongoose = require('mongoose');

const replySchema = new mongoose.Schema(
  {
    from: { type: String, enum: ['customer', 'rider', 'vendor', 'admin'], required: true },
    text: { type: String, required: true, maxlength: 2000 },
  },
  { timestamps: true }
);

const supportQuerySchema = new mongoose.Schema(
  {
    // `customerId` now holds the requester's id for ANY role (kept as-is for
    // back-compat with existing data + the admin panel). `userRole` disambiguates
    // so admin replies route to the correct socket room / FCM role.
    customerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    customerName: { type: String },
    customerEmail: { type: String, default: null },
    userRole: { type: String, enum: ['customer', 'rider', 'vendor'], default: 'customer' },
    message: { type: String, required: true, maxlength: 2000 },
    status: { type: String, enum: ['open', 'closed'], default: 'open' },
    replies: [replySchema],
  },
  { timestamps: true }
);

supportQuerySchema.index({ customerId: 1, createdAt: -1 });

module.exports = mongoose.model('SupportQuery', supportQuerySchema);
