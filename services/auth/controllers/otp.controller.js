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

/** Strip +91 / 91 country code prefix so mobile and web resolve to the same DB record */
const normalizePhone = (phone) => phone.replace(/^\+?91(?=\d{10}$)/, '');

/**
 * POST /api/auth/send-otp
 * Body: { phone: string }
 */
const sendOtp = async (req, res) => {
  try {
    const raw = req.body.phone;

    if (!raw || !/^\+?[1-9]\d{9,14}$/.test(raw)) {
      return sendError(res, 400, 'Invalid phone number', ERROR_CODES.VALIDATION_ERROR);
    }

    const phone = normalizePhone(raw);
    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

    const isProd = process.env.NODE_ENV === 'production';

    // Send OTP via Fast2SMS WhatsApp route. With no token: log to console in
    // dev, but FAIL CLOSED in production — never fall back to leaking the OTP.
    if (process.env.FAST2SMS_API_KEY) {
      try {
        const { data } = await axios.request({
          method: 'POST',
          url: 'https://www.fast2sms.com/dev/otp/send',
          headers: {
            accept: 'application/json',
            authorization: process.env.FAST2SMS_API_KEY,
            'content-type': 'application/json',
          },
          data: {
            mobile: phone,
            otp_id: process.env.FAST2SMS_TEMPLATE_ID,
            otp_expiry: 5,
            otp_length: 6,
            otp,
          },
        });
        if (!data || data.return === false) {
          logger.error('Fast2SMS failed:', data?.message || JSON.stringify(data));
          return sendError(res, 500, 'Failed to send OTP', ERROR_CODES.INTERNAL_ERROR);
        }
      } catch (smsErr) {
        logger.error('Fast2SMS error:', smsErr.response?.data || smsErr.message);
        return sendError(res, 500, 'Failed to send OTP', ERROR_CODES.INTERNAL_ERROR);
      }
    } else if (isProd) {
      logger.error('FAST2SMS_API_KEY not configured — cannot send OTP in production');
      return sendError(res, 500, 'OTP service is not configured', ERROR_CODES.INTERNAL_ERROR);
    } else {
      console.log('\n' + '='.repeat(50));
      console.log(`  [DEV] OTP for ${phone}:  ${otp}`);
      console.log('='.repeat(50) + '\n');
    }

    // Upsert OTP session only after successful delivery
    await OtpSession.findOneAndUpdate(
      { phone },
      { otp, expiresAt, attempts: 0 },
      { upsert: true, new: true },
    );

    logger.info(`OTP sent to ${phone}`);

    // Return the OTP in the response only in non-production dev mode.
    const devPayload = (!process.env.FAST2SMS_API_KEY && !isProd) ? { devOtp: otp } : {};
    return sendSuccess(res, 200, 'OTP sent successfully', devPayload);
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
    const { phone: rawPhone, otp } = req.body;

    if (!rawPhone || !otp) {
      return sendError(res, 400, 'Phone and OTP are required', ERROR_CODES.MISSING_FIELDS);
    }

    const phone = normalizePhone(rawPhone);
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

    // Login only — user must have registered via POST /api/auth/register first
    const user = await Customer.findOne({ phone });
    if (!user) {
      return sendError(res, 404, 'No account found for this number. Please sign up first.', ERROR_CODES.NOT_FOUND);
    }

    if (!user.authProviders.includes('phone')) {
      user.authProviders.push('phone');
      await user.save();
    }

    const tokenPayload = { id: user._id.toString(), role: ROLES.CUSTOMER };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    return sendSuccess(res, 200, 'Login successful', {
      accessToken,
      refreshToken,
      user: { id: user._id, name: user.name, phone: user.phone },
    });
  } catch (err) {
    logger.error('verifyOtp error:', err);
    return sendError(res, 500, 'OTP verification failed', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { sendOtp, verifyOtp };