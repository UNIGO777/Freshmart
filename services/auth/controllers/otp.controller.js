const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });
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

// Google Play reviewer test account (see scripts/seed-play-test-account.js and
// docs/release-signing.md). Fixed OTP, no real SMS ever sent for this number.
// Gated to NODE_ENV !== 'production' so it can NEVER work against a real prod
// deployment — only against the production server when it's deliberately set to
// a non-production NODE_ENV for the review window (the user's own call).
const PLAY_TEST_PHONE = '9999999999';
const PLAY_TEST_OTP = '000000';

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

    // Login-only guard: verify-otp requires an existing account, so an OTP to an
    // unregistered number can never succeed. Reject here — BEFORE spending an SMS —
    // instead of letting the user enter a code that's doomed to "no account found".
    // The sign-up flow calls POST /register first, so a genuine new user already
    // has a Customer record by the time it requests an OTP and passes this check.
    const existing = await Customer.findOne({ phone }).select('_id').lean();
    if (!existing) {
      return sendError(res, 404, 'No account found for this number. Please sign up first.', ERROR_CODES.NOT_FOUND);
    }

    const isProd = process.env.NODE_ENV === 'production';
    const isPlayTestPhone = phone === PLAY_TEST_PHONE && !isProd;

    const otp = isPlayTestPhone ? PLAY_TEST_OTP : generateOtp();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MS);

    // Send OTP via Fast2SMS WhatsApp route. With no token: log to console in
    // dev, but FAIL CLOSED in production — never fall back to leaking the OTP.
    if (isPlayTestPhone) {
      // Reviewer test number: never send a real SMS (it isn't a real phone), the
      // OTP is always fixed.
      logger.info(`[play-test] Fixed OTP issued for reviewer test number ${phone}`);
    } else if (process.env.FAST2SMS_API_KEY) {
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
            otp_id: process.env.FAST2SMS_OTP_ID,
            otp_expiry: parseInt(process.env.FAST2SMS_OTP_EXPIRY) || 5,
            otp_length: parseInt(process.env.FAST2SMS_OTP_LENGTH) || 6,
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

    // Return the OTP in the response only in non-production dev mode (or for the
    // Play reviewer test number, where there's no real phone to receive an SMS).
    const devPayload = (isPlayTestPhone || (!process.env.FAST2SMS_API_KEY && !isProd)) ? { devOtp: otp } : {};
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
    const { phone: rawPhone, otp: rawOtp } = req.body;

    if (!rawPhone || rawOtp === undefined || rawOtp === null || rawOtp === '') {
      return sendError(res, 400, 'Phone and OTP are required', ERROR_CODES.MISSING_FIELDS);
    }

    // Normalise the submitted OTP: clients may send it as a number, or SMS
    // autofill can inject spaces/newlines (e.g. "123 456"). Strip everything
    // that isn't a digit so a correct code never fails a strict comparison.
    const otp = String(rawOtp).replace(/\D/g, '');

    const phone = normalizePhone(rawPhone);
    // Always validate against the NEWEST session. A rare race between two
    // send-otp calls can leave more than one session doc for a phone; picking an
    // arbitrary one would reject the code the user actually received.
    const session = await OtpSession.findOne({ phone }).sort({ createdAt: -1 });

    if (!session) {
      return sendError(res, 400, 'OTP not found or expired', ERROR_CODES.OTP_NOT_FOUND);
    }

    if (new Date() > session.expiresAt) {
      await OtpSession.deleteMany({ phone });
      return sendError(res, 400, 'OTP has expired', ERROR_CODES.OTP_EXPIRED);
    }

    if (session.attempts >= MAX_ATTEMPTS) {
      await OtpSession.deleteMany({ phone });
      return sendError(res, 429, 'Too many attempts. Request a new OTP.', ERROR_CODES.RATE_LIMITED);
    }

    // Compare as trimmed strings so a stored/submitted type mismatch can never
    // reject a correct code.
    if (String(session.otp).trim() !== otp) {
      await OtpSession.updateOne({ _id: session._id }, { $inc: { attempts: 1 } });
      return sendError(res, 400, 'Incorrect OTP', ERROR_CODES.INVALID_OTP);
    }

    // OTP verified — clear every session for this phone (handles rare duplicates)
    await OtpSession.deleteMany({ phone });

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