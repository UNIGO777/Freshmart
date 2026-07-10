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

// Auth routes: this gateway limiter is only a coarse per-IP ABUSE net. The real
// per-account throttling (per phone/email) lives in the auth service, which can
// read the request body — the gateway cannot. Because many legitimate users can
// share a single egress IP (mobile CGNAT, a load balancer, office Wi-Fi), this
// bucket must be generous, otherwise 5 different users logging in within a minute
// would falsely trip "too many attempts".
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // up to 100 auth requests/min per source IP (abuse protection only)
  standardHeaders: true,
  legacyHeaders: false,
  store: makeStore('rl:auth:'),
  message: { success: false, message: 'Too many requests from this network, please try again shortly.', errorCode: 'RATE_LIMITED' },
});

module.exports = { generalLimiter, authLimiter };
