const rateLimit = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { redisClient } = require('../../../shared/db/redis');

// In development/test, skip account rate limiting so local logins never lock out.
const passThrough = (_req, _res, next) => next();
const isDev = process.env.NODE_ENV !== 'production';

/**
 * Normalise a phone into the same canonical form the OTP controller stores
 * (strip a leading +91 / 91) so "+919876543210" and "9876543210" share a bucket.
 */
const normalizePhone = (phone) => String(phone).replace(/^\+?91(?=\d{10}$)/, '');

/**
 * Build a Redis-backed store so per-account counters are shared across auth
 * instances. Falls back to in-memory (per-process) when Redis is not ready —
 * still correct on a single instance, and fails open if Redis drops mid-flight.
 */
const makeStore = (prefix) => {
  if (!redisClient.isReady) return undefined; // -> express-rate-limit memory store
  return new RedisStore({
    sendCommand: async (...args) => {
      try {
        if (!redisClient.isReady) throw new Error('Redis not ready');
        return await redisClient.sendCommand(args);
      } catch {
        return null; // fail open
      }
    },
    prefix,
  });
};

/**
 * Factory for a limiter keyed by an ACCOUNT identifier (phone/email) taken from
 * the parsed request body — NOT by IP. This is what makes 500 different users
 * logging in at once safe: each account gets its own bucket, while a single
 * user hammering login is throttled.
 *
 * @param {object}   opts
 * @param {number}   opts.windowMs
 * @param {number}   opts.max
 * @param {string}   opts.prefix    Redis key prefix
 * @param {string}   opts.message   Rejection message
 * @param {function} opts.identify  (req) => string identifier (phone/email)
 */
const makeAccountLimiter = ({ windowMs, max, prefix, message, identify }) => {
  if (isDev) return passThrough;
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: makeStore(prefix),
    // Key strictly by account. If the identifier is missing (malformed request),
    // fall back to IP so the request is still bounded and validation passes.
    keyGenerator: (req) => {
      const id = identify(req);
      return id ? `acct:${id}` : `ip:${req.ip}`;
    },
    // We intentionally key by body, not IP — silence the IP-key validation warning.
    validate: { keyGeneratorIpFallback: false },
    message: { success: false, message, errorCode: 'RATE_LIMITED' },
  });
};

// Sending OTPs costs real money (SMS) — keep this tight, per phone.
const otpSendLimiter = makeAccountLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 3, // at most 3 OTP requests per phone per minute
  prefix: 'rl:otp-send:',
  message: 'Too many OTP requests for this number. Please wait a minute and try again.',
  identify: (req) => (req.body?.phone ? normalizePhone(req.body.phone) : null),
});

// Verifying OTP / password logins — per account, generous enough for typos.
const loginLimiter = makeAccountLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 8, // 8 login attempts per account per minute
  prefix: 'rl:login:',
  message: 'Too many login attempts for this account. Please wait a minute and try again.',
  identify: (req) => {
    if (req.body?.phone) return normalizePhone(req.body.phone);
    if (req.body?.email) return String(req.body.email).trim().toLowerCase();
    return null;
  },
});

module.exports = { otpSendLimiter, loginLimiter };
