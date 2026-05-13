const mongoose = require('mongoose');

const riderSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, unique: true },
    passwordHash: { type: String, select: false },

    currentLocation: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }, // [lng, lat]
    },

    isOnline: { type: Boolean, default: false },
    isOnDelivery: { type: Boolean, default: false },
    isApproved: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },

    fcmToken: { type: String },
    vehicleType: { type: String, enum: ['bike', 'scooter', 'bicycle'], default: 'bike' },

    earnings: {
      today: { type: Number, default: 0 },
      thisWeek: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },

    rating: {
      average: { type: Number, default: 0 },
      count: { type: Number, default: 0 },
    },

    kyc: {
      aadhaarUrl: { type: String },
      panUrl:     { type: String },
      status:     { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
    },

    drivingLicense: {
      number:   { type: String, trim: true, default: '' },
      photoUrl: { type: String, default: '' },
    },
  },
  { timestamps: true },
);

riderSchema.index({ currentLocation: '2dsphere' });

module.exports = mongoose.model('Rider', riderSchema);
