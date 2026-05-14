const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, default: 'Home' },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    fullAddress: { type: String, required: true },
  },
  { _id: true },
);

const customerSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    phone: { type: String, sparse: true, index: true },
    email: { type: String, lowercase: true, sparse: true, index: true },
    passwordHash: { type: String, select: false },

    // Social auth identifiers
    googleId: { type: String, sparse: true, index: true },
    appleId: { type: String, sparse: true, index: true },

    authProviders: {
      type: [String],
      enum: ['phone', 'email', 'google', 'apple'],
      default: [],
    },

    addresses: [addressSchema],

    language: { type: String, enum: ['en', 'hi'], default: 'en' },
    fcmToken: { type: String },
    isActive: { type: Boolean, default: true },

    wishlist: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, required: true },
        name: { type: String, required: true },
        sellingPrice: { type: Number, required: true },
        coverImage: { type: String, default: '' },
        category: { type: String, default: '' },
        addedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

module.exports = mongoose.model('Customer', customerSchema);
