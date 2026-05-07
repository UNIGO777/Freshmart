const rateLimit = require('express-rate-limit');

// General limiter for all routes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.', errorCode: 'RATE_LIMITED' },
});

// Stricter limiter for auth routes (OTP, login)
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts, please try again later.', errorCode: 'RATE_LIMITED' },
});

module.exports = { generalLimiter, authLimiter };
