const mongoose = require('mongoose');

const vendorNotificationSchema = new mongoose.Schema(
  {
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', required: true, index: true },
    type: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    orderId: { type: String },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true },
);

vendorNotificationSchema.index({ vendorId: 1, createdAt: -1 });

module.exports = mongoose.model('VendorNotification', vendorNotificationSchema);
