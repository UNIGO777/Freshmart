const mongoose = require('mongoose');

const otpSessionSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      index: true,
    },
    otp: {
      type: String,
      required: true,
    },
    attempts: {
      type: Number,
      default: 0,
    },
    expiresAt: {
      type: Date,
      required: true,
      // TTL index — MongoDB auto-removes expired docs
      index: { expires: 0 },
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model('OtpSession', otpSessionSchema);
