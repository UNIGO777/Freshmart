require('dotenv').config();
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const Customer = require('../../user/models/Customer.model');
const Admin = require('../../admin/models/Admin.model');
const { signAccessToken, signRefreshToken, verifyRefreshToken } = require('../../../shared/utils/jwt.util');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const ROLES = require('../../../shared/constants/roles');
const logger = require('../../../shared/utils/logger');

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

    const { name, email, password } = parsed.data;

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

    const { email, password } = parsed.data;

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
 * No-op for now — stateless JWT; future: add refresh token to a Redis blocklist
 */
const logout = async (_req, res) => {
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

module.exports = { registerEmail, loginEmail, loginAdmin, refreshToken, logout };
