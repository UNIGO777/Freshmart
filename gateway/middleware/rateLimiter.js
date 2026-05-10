const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { redisClient } = require('../../shared/db/redis');

// In development/test, skip all rate limiting.
const passThrough = (_req, _res, next) => next();
if (process.env.NODE_ENV !== 'production') {
  module.exports = { generalLimiter: passThrough, authLimiter: passThrough };
  return;
}

// Use Redis-backed store so rate limits are shared across all gateway instances
// (horizontal scaling safe). Falls back to in-memory if Redis is unavailable.
const makeStore = (prefix) => {
  // Only create a Redis store if the client is already connected.
  // rateLimiter.js is required synchronously at boot before connectRedis()
  // runs, so isReady is false at that point — fall back to in-memory.
  if (!redisClient.isReady) return undefined;

  return new RedisStore({
    // Guard sendCommand so a Redis drop mid-flight doesn't crash requests.
    // On failure, return a safe dummy value so rate limiting fails open.
    sendCommand: async (...args) => {
      try {
        if (!redisClient.isReady) throw new Error('Redis not ready');
        return await redisClient.sendCommand(args);
      } catch {
        return null;
      }
    },
    prefix,
  });
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
