const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema(
  {
    label:       { type: String, default: 'Home' },
    lat:         { type: Number },
    lng:         { type: Number },
    fullAddress: { type: String, required: true },
    flat:        { type: String, default: '' },
    floor:       { type: String, default: '' },
    landmark:    { type: String, default: '' },
    street:      { type: String, default: '' },
    city:        { type: String, default: '' },
    state:       { type: String, default: '' },
    zip:         { type: String, default: '' },
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

    // Referrals (tracking only — no rewards). `referralCode` is this user's own
    // shareable code (auto-generated). `referredBy` / `referredByCode` record
    // who/which code brought them in at signup.
    referralCode:   { type: String, unique: true, sparse: true, uppercase: true, trim: true, index: true },
    referredBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    referredByCode: { type: String, default: '', uppercase: true, trim: true },

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

    cart: [
      {
        productId:    { type: mongoose.Schema.Types.ObjectId, required: true },
        name:         { type: String, required: true },
        sellingPrice: { type: Number, required: true },
        coverImage:   { type: String, default: '' },
        unit:         { type: String, default: '' },
        qty:          { type: Number, required: true, min: 1 },
      },
    ],
  },
  { timestamps: true },
);

// ── Referral code generation ──────────────────────────────────────
// Unambiguous alphabet (no 0/O/1/I) so codes are easy to read & share.
const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const randomChars = (len) => {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += REFERRAL_ALPHABET[Math.floor(Math.random() * REFERRAL_ALPHABET.length)];
  }
  return s;
};

/**
 * Generate a referral code unique across customers. Uses up to 4 alpha chars
 * from the name as a recognisable prefix, padded with random chars to length 8.
 */
customerSchema.statics.generateUniqueReferralCode = async function (name = '') {
  const prefix = String(name).toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  for (let attempt = 0; attempt < 12; attempt++) {
    const code = (prefix + randomChars(8 - prefix.length)) || randomChars(8);
    const exists = await this.exists({ referralCode: code });
    if (!exists) return code;
  }
  return randomChars(10); // statistically unreachable fallback
};

// Assign a referral code to every new customer (create() runs save hooks).
customerSchema.pre('save', async function (next) {
  if (!this.referralCode) {
    this.referralCode = await this.constructor.generateUniqueReferralCode(this.name);
  }
  next();
});

module.exports = mongoose.model('Customer', customerSchema);
