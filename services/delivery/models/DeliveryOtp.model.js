const mongoose = require('mongoose');

const deliveryOtpSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Order',
      required: true,
      index: true,
    },
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DeliveryJob',
      required: true,
    },
    vendorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vendor',
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Customer',
    },
    riderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rider',
    },
    // pickup = vendor holds code, rider enters it at pickup
    // delivery = customer holds code, rider enters it at delivery
    // return = vendor holds code, rider enters it when returning package
    type: {
      type: String,
      enum: ['pickup', 'delivery', 'return'],
      required: true,
    },
    code: {
      type: String,
      required: true,
    },
    // Who holds/sees the OTP (vendor or customer)
    recipientType: {
      type: String,
      enum: ['vendor', 'customer'],
      required: true,
    },
  },
  { timestamps: true },
);

// Compound index: one active OTP per type per job
deliveryOtpSchema.index({ jobId: 1, type: 1 }, { unique: true });

// Quick lookup by vendor or customer
deliveryOtpSchema.index({ vendorId: 1, recipientType: 1 });
deliveryOtpSchema.index({ customerId: 1, recipientType: 1 });

module.exports = mongoose.model('DeliveryOtp', deliveryOtpSchema);
