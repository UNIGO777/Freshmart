require('dotenv').config();
const axios = require('axios');
const OtpSession = require('../models/OtpSession.model');
const Customer = require('../../user/models/Customer.model');
const { signAccessToken, signRefreshToken } = require('../../../shared/utils/jwt.util');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const ROLES = require('../../../shared/constants/roles');
const logger = require('../../../shared/utils/logger');

const OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;

/** Generate a 6-digit OTP */
const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

/**
 * POST /api/auth/send-otp
 * Body: { phone: string }
 */
const sendOtp = async (req, res) => {
  try {
    const { phone } = req.body;

    if (!phone || !/^\+?[1-9]\d{9,14}$/.test(phone)) {
      return sendError(res, 400, 'Invalid phone number', ERROR_CODES.VALIDATION_ERROR);
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

    // Send SMS FIRST — only persist the session if delivery succeeds.
    // This prevents a phantom OTP sitting in DB that the user never received.
    await axios.get('https://www.fast2sms.com/dev/bulkV2', {
      params: {
        authorization: process.env.FASTTOSMS_AUTH_TOKEN,
        variables_values: otp,
        route: 'otp',
        numbers: phone.replace(/^\+91/, ''),
      },
      timeout: 8000,
    });

    // Upsert OTP session only after successful delivery
    await OtpSession.findOneAndUpdate(
      { phone },
      { otp, expiresAt, attempts: 0 },
      { upsert: true, new: true },
    );

    logger.info(`OTP sent to ${phone}`);
    return sendSuccess(res, 200, 'OTP sent successfully');
  } catch (err) {
    logger.error('sendOtp error:', err);
    return sendError(res, 500, 'Failed to send OTP', ERROR_CODES.INTERNAL_ERROR);
  }
};

/**
 * POST /api/auth/verify-otp
 * Body: { phone: string, otp: string, role?: string }
 */
const verifyOtp = async (req, res) => {
  try {
    const { phone, otp } = req.body;

    if (!phone || !otp) {
      return sendError(res, 400, 'Phone and OTP are required', ERROR_CODES.MISSING_FIELDS);
    }

    const session = await OtpSession.findOne({ phone });

    if (!session) {
      return sendError(res, 400, 'OTP not found or expired', ERROR_CODES.OTP_NOT_FOUND);
    }

    if (new Date() > session.expiresAt) {
      await OtpSession.deleteOne({ phone });
      return sendError(res, 400, 'OTP has expired', ERROR_CODES.OTP_EXPIRED);
    }

    if (session.attempts >= MAX_ATTEMPTS) {
      await OtpSession.deleteOne({ phone });
      return sendError(res, 429, 'Too many attempts. Request a new OTP.', ERROR_CODES.RATE_LIMITED);
    }

    if (session.otp !== otp) {
      await OtpSession.updateOne({ phone }, { $inc: { attempts: 1 } });
      return sendError(res, 400, 'Incorrect OTP', ERROR_CODES.INVALID_OTP);
    }

    // OTP verified — clean up session
    await OtpSession.deleteOne({ phone });

    // Find or create customer (OTP is only for customers in this flow)
    let user = await Customer.findOne({ phone });
    const isNewUser = !user;

    if (!user) {
      user = await Customer.create({ phone, authProviders: ['phone'] });
    } else if (!user.authProviders.includes('phone')) {
      user.authProviders.push('phone');
      await user.save();
    }

    const tokenPayload = { id: user._id.toString(), role: ROLES.CUSTOMER };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    return sendSuccess(res, 200, isNewUser ? 'Account created' : 'Login successful', {
      accessToken,
      refreshToken,
      isNewUser,
      user: { id: user._id, name: user.name, phone: user.phone },
    });
  } catch (err) {
    logger.error('verifyOtp error:', err);
    return sendError(res, 500, 'OTP verification failed', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { sendOtp, verifyOtp };
