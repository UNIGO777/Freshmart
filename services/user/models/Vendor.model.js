const mongoose = require('mongoose');

const vendorSchema = new mongoose.Schema(
  {
    businessName: { type: String, required: true, trim: true },
    ownerName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true },
    email: { type: String, lowercase: true, sparse: true, index: true },
    passwordHash: { type: String, select: false },

    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },

    address: { type: String, default: '' },

    serviceRadiusKm: { type: Number, default: 5 },

    categories: {
      type: [String],
      enum: ['fruits', 'vegetables', 'spices', 'dairy', 'bakery', 'other'],
      default: [],
    },

    isApproved: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    isOnline: { type: Boolean, default: false },
    

    profilePhoto: { type: String, default: '' },

    fcmToken: { type: String },

    bankDetails: {
      accountNo: { type: String },
      ifsc: { type: String },
      upiId: { type: String },
    },

    kyc: {
      aadhaarUrl: { type: String },
      panUrl:     { type: String },
      status:     { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
    },
  },
  { timestamps: true },
);

vendorSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Vendor', vendorSchema);
