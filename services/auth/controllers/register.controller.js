const { z } = require('zod');
const Customer = require('../../user/models/Customer.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

const registerSchema = z.object({
  name:         z.string().min(2, 'Name must be at least 2 characters'),
  email:        z.string().email('Invalid email address'),
  confirmEmail: z.string().email('Invalid confirm email'),
  phone:        z.string().regex(/^\+?[1-9]\d{9,14}$/, 'Invalid phone number'),
});

/**
 * POST /api/auth/register
 * Body: { name, email, confirmEmail, phone }
 * No password — login is phone + OTP only.
 */
const register = async (req, res) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(
        res, 400,
        parsed.error.errors[0]?.message ?? 'Validation failed',
        ERROR_CODES.VALIDATION_ERROR,
      );
    }

    const { name, email, confirmEmail, phone } = parsed.data;

    if (email.toLowerCase() !== confirmEmail.toLowerCase()) {
      return sendError(res, 400, 'Emails do not match', ERROR_CODES.VALIDATION_ERROR);
    }

    // Check duplicates
    const [byEmail, byPhone] = await Promise.all([
      Customer.findOne({ email: email.toLowerCase() }),
      Customer.findOne({ phone }),
    ]);

    if (byEmail) {
      return sendError(res, 409, 'Email is already registered', ERROR_CODES.ALREADY_EXISTS);
    }
    if (byPhone) {
      return sendError(res, 409, 'Phone number is already registered', ERROR_CODES.ALREADY_EXISTS);
    }

    const user = await Customer.create({
      name:          name.trim(),
      email:         email.toLowerCase(),
      phone,
      authProviders: ['phone'],
    });

    logger.info(`New customer registered: ${user._id}`);

    return sendSuccess(res, 201, 'Account created successfully', {
      user: { id: user._id, name: user.name, email: user.email, phone: user.phone },
    });
  } catch (err) {
    logger.error('register error:', err);
    return sendError(res, 500, 'Registration failed', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { register };