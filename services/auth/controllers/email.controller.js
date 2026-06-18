require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const Customer = require('../../user/models/Customer.model');
const Admin = require('../../admin/models/Admin.model');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../../../shared/utils/jwt.util');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const ROLES = require('../../../shared/constants/roles');
const { notifyAdmin } = require('../../../shared/utils/notifyAdmin');
const { redisClient } = require('../../../shared/db/redis');
const logger = require('../../../shared/utils/logger');

// ── Refresh-token revocation blocklist (Redis, fail-open) ──────────
const blocklistKey = (token) => `bl:rt:${crypto.createHash('sha256').update(token).digest('hex')}`;

/** Add a refresh token to the blocklist until its natural expiry. */
const revokeRefreshToken = async (token, expSeconds) => {
  try {
    if (!redisClient.isReady) return;
    const ttl = Math.max(1, (expSeconds || 0) - Math.floor(Date.now() / 1000));
    await redisClient.set(blocklistKey(token), '1', { EX: ttl });
  } catch (err) {
    logger.warn(`revokeRefreshToken failed (non-fatal): ${err.message}`);
  }
};

/** Returns true only if we positively confirm the token is revoked. */
const isRefreshTokenRevoked = async (token) => {
  try {
    if (!redisClient.isReady) return false;
    return (await redisClient.exists(blocklistKey(token))) === 1;
  } catch (err) {
    logger.warn(`isRefreshTokenRevoked check failed (fail-open): ${err.message}`);
    return false;
  }
};

const registerSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * POST /api/auth/register-email
 * Body: { name, email, password }
 */
const registerEmail = async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const { name, password } = parsed.data;
    const email = parsed.data.email.toLowerCase();

    const existing = await Customer.findOne({ email });
    if (existing) {
      return sendError(res, 409, 'Email already registered', ERROR_CODES.ALREADY_EXISTS);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await Customer.create({
      name,
      email,
      passwordHash,
      authProviders: ['email'],
    });

    const tokenPayload = { id: user._id.toString(), role: ROLES.CUSTOMER };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    notifyAdmin(
      'new_customer',
      'New Customer Registered',
      `${user.name} (${user.email}) just signed up`,
      { customerId: user._id.toString(), name: user.name, email: user.email },
    );

    return sendSuccess(res, 201, 'Account created', {
      accessToken,
      refreshToken,
      user: { id: user._id, name: user.name, email: user.email },
    });
  } catch (err) {
    logger.error('registerEmail error:', err);
    return sendError(res, 500, 'Registration failed', ERROR_CODES.INTERNAL_ERROR);
  }
};

/**
 * POST /api/auth/login-email
 * Body: { email, password }
 */
const loginEmail = async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const { password } = parsed.data;
    const email = parsed.data.email.toLowerCase();

    const user = await Customer.findOne({ email }).select('+passwordHash');
    if (!user || !user.passwordHash) {
      return sendError(res, 401, 'Invalid email or password', ERROR_CODES.INVALID_CREDENTIALS);
    }

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) {
      return sendError(res, 401, 'Invalid email or password', ERROR_CODES.INVALID_CREDENTIALS);
    }

    if (!user.isActive) {
      return sendError(res, 403, 'Account is inactive', ERROR_CODES.FORBIDDEN);
    }

    const tokenPayload = { id: user._id.toString(), role: ROLES.CUSTOMER };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    return sendSuccess(res, 200, 'Login successful', {
      accessToken,
      refreshToken,
      user: { id: user._id, name: user.name, email: user.email },
    });
  } catch (err) {
    logger.error('loginEmail error:', err);
    return sendError(res, 500, 'Login failed', ERROR_CODES.INTERNAL_ERROR);
  }
};

/**
 * POST /api/auth/refresh
 * Body: { refreshToken }
 */
const refreshToken = async (req, res) => {
  try {
    const { refreshToken: token } = req.body;

    if (!token) {
      return sendError(res, 400, 'Refresh token required', ERROR_CODES.MISSING_FIELDS);
    }

    const decoded = verifyRefreshToken(token);

    if (await isRefreshTokenRevoked(token)) {
      return sendError(res, 401, 'Refresh token has been revoked', ERROR_CODES.TOKEN_INVALID);
    }

    const newAccessToken = signAccessToken({ id: decoded.id, role: decoded.role });

    return sendSuccess(res, 200, 'Token refreshed', { accessToken: newAccessToken });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return sendError(res, 401, 'Refresh token expired', ERROR_CODES.TOKEN_EXPIRED);
    }
    return sendError(res, 401, 'Invalid refresh token', ERROR_CODES.TOKEN_INVALID);
  }
};

/**
 * POST /api/auth/logout
 * Body: { refreshToken? }
 * Revokes the supplied refresh token (added to a Redis blocklist until expiry).
 * Always succeeds — even if no token is given or Redis is unavailable.
 */
const logout = async (req, res) => {
  const token = req.body?.refreshToken;
  if (token) {
    try {
      const decoded = verifyRefreshToken(token);
      await revokeRefreshToken(token, decoded.exp);
    } catch {
      // Invalid/expired token — nothing to revoke.
    }
  }
  return sendSuccess(res, 200, 'Logged out successfully');
};

/**
 * POST /api/auth/login-admin
 * Body: { email, password }
 */
const loginAdmin = async (req, res) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const { email, password } = parsed.data;

    const admin = await Admin.findOne({ email: email.toLowerCase() }).select('+passwordHash');
    if (!admin || !admin.passwordHash) {
      return sendError(res, 401, 'Invalid email or password', ERROR_CODES.INVALID_CREDENTIALS);
    }

    const match = await bcrypt.compare(password, admin.passwordHash);
    if (!match) {
      return sendError(res, 401, 'Invalid email or password', ERROR_CODES.INVALID_CREDENTIALS);
    }

    if (!admin.isActive) {
      return sendError(res, 403, 'Admin account is inactive', ERROR_CODES.FORBIDDEN);
    }

    const tokenPayload = { id: admin._id.toString(), role: ROLES.ADMIN };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    return sendSuccess(res, 200, 'Admin login successful', {
      accessToken,
      refreshToken,
      user: { id: admin._id, name: admin.name, email: admin.email, role: ROLES.ADMIN },
    });
  } catch (err) {
    logger.error('loginAdmin error:', err);
    return sendError(res, 500, 'Login failed', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /api/auth/switch-role ───────────────────────────────────
// Allows a customer who is also a vendor (or vice versa) to get
// a new token pair scoped to the other role.
// Requires a valid JWT (authenticate middleware must run first).
const Vendor = require('../../user/models/Vendor.model');
const Rider = require('../../user/models/Rider.model');

const switchRole = async (req, res) => {
  try {
    const { targetRole } = req.body;
    if (!targetRole || ![ROLES.CUSTOMER, ROLES.VENDOR, ROLES.RIDER].includes(targetRole)) {
      return sendError(res, 400, 'targetRole must be "customer", "vendor" or "rider"', ERROR_CODES.VALIDATION_ERROR);
    }

    if (req.user.role === targetRole) {
      return sendError(res, 400, 'Already in this role', ERROR_CODES.VALIDATION_ERROR);
    }

    let targetId;

    if (req.user.role === ROLES.CUSTOMER && targetRole === ROLES.VENDOR) {
      // Customer wants to switch to vendor — find linked vendor by email
      const customer = await Customer.findById(req.user.id).select('email phone').lean();
      if (!customer) return sendError(res, 404, 'Customer not found', ERROR_CODES.USER_NOT_FOUND);

      const vendor = await Vendor.findOne({
        $or: [
          ...(customer.email ? [{ email: customer.email }] : []),
          ...(customer.phone ? [{ phone: customer.phone }] : []),
        ],
      }).select('_id isApproved isActive').lean();

      if (!vendor) return sendError(res, 404, 'No vendor account linked', ERROR_CODES.NOT_FOUND);
      if (!vendor.isActive) return sendError(res, 403, 'Vendor account is inactive', ERROR_CODES.FORBIDDEN);

      targetId = vendor._id.toString();
    } else if (req.user.role === ROLES.VENDOR && targetRole === ROLES.CUSTOMER) {
      // Vendor wants to switch back to customer
      const vendor = await Vendor.findById(req.user.id).select('email phone').lean();
      if (!vendor) return sendError(res, 404, 'Vendor not found', ERROR_CODES.USER_NOT_FOUND);

      const customer = await Customer.findOne({
        $or: [
          ...(vendor.email ? [{ email: vendor.email }] : []),
          ...(vendor.phone ? [{ phone: vendor.phone }] : []),
        ],
      }).select('_id').lean();

      if (!customer) return sendError(res, 404, 'No customer account linked', ERROR_CODES.NOT_FOUND);
      targetId = customer._id.toString();
    } else if (req.user.role === ROLES.CUSTOMER && targetRole === ROLES.RIDER) {
      // Customer wants to switch to rider — find linked rider by phone
      const customer = await Customer.findById(req.user.id).select('phone').lean();
      if (!customer) return sendError(res, 404, 'Customer not found', ERROR_CODES.USER_NOT_FOUND);

      const rider = await Rider.findOne({
        ...(customer.phone ? { phone: customer.phone } : {}),
      }).select('_id isActive').lean();

      if (!rider) return sendError(res, 404, 'No rider account linked', ERROR_CODES.NOT_FOUND);
      if (!rider.isActive) return sendError(res, 403, 'Rider account is inactive', ERROR_CODES.FORBIDDEN);

      targetId = rider._id.toString();
    } else if (req.user.role === ROLES.RIDER && targetRole === ROLES.CUSTOMER) {
      // Rider wants to switch back to customer
      const rider = await Rider.findById(req.user.id).select('phone').lean();
      if (!rider) return sendError(res, 404, 'Rider not found', ERROR_CODES.USER_NOT_FOUND);

      const customer = await Customer.findOne({
        ...(rider.phone ? { phone: rider.phone } : {}),
      }).select('_id').lean();

      if (!customer) return sendError(res, 404, 'No customer account linked', ERROR_CODES.NOT_FOUND);
      targetId = customer._id.toString();
    } else {
      return sendError(res, 400, 'Unsupported role switch', ERROR_CODES.VALIDATION_ERROR);
    }

    const tokenPayload = { id: targetId, role: targetRole };
    const accessToken = signAccessToken(tokenPayload);
    const newRefreshToken = signRefreshToken(tokenPayload);

    return sendSuccess(res, 200, `Switched to ${targetRole}`, {
      accessToken,
      refreshToken: newRefreshToken,
      role: targetRole,
    });
  } catch (err) {
    logger.error('switchRole error:', err);
    return sendError(res, 500, 'Role switch failed', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { registerEmail, loginEmail, loginAdmin, refreshToken, logout, switchRole };
