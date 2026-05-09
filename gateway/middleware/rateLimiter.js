const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { redisClient } = require('../../shared/db/redis');

// Use Redis-backed store so rate limits are shared across all gateway instances
// (horizontal scaling safe). Falls back to in-memory if Redis is unavailable.
const makeStore = (prefix) => {
  try {
    return new RedisStore({
      sendCommand: (...args) => redisClient.sendCommand(args),
      prefix,
    });
  } catch {
    // Redis not ready yet — in-memory fallback (single-instance only)
    return undefined;
  }
};

// General limiter for all routes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore('rl:general:'),
  message: { success: false, message: 'Too many requests, please try again later.', errorCode: 'RATE_LIMITED' },
});

// Stricter limiter for auth routes (OTP, login)
const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore('rl:auth:'),
  message: { success: false, message: 'Too many auth attempts, please try again later.', errorCode: 'RATE_LIMITED' },
});

module.exports = { generalLimiter, authLimiter };
