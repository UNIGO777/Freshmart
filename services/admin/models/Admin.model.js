const mongoose = require('mongoose');

const adminSchema = new mongoose.Schema(
  {
    name:         { type: String, required: true, trim: true },
    email:        { type: String, required: true, unique: true, lowercase: true, index: true },
    passwordHash: { type: String, required: true, select: false },
    isActive:     { type: Boolean, default: true },
    fcmToken:     { type: String },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Admin', adminSchema);
