require('dotenv').config();
const Customer = require('../../user/models/Customer.model');
const Vendor   = require('../../user/models/Vendor.model');
const Rider    = require('../../user/models/Rider.model');
const { sendToToken, sendToMultipleTokens } = require('../helpers/fcm.helper');
const { getTemplate } = require('../helpers/templates');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// ── Helpers ───────────────────────────────────────────────────────

/** Fetch the FCM token for a user based on their role. */
const getFcmToken = async (userId, userRole) => {
  let doc = null;
  switch (userRole) {
    case 'customer': doc = await Customer.findById(userId).select('fcmToken').lean(); break;
    case 'vendor':   doc = await Vendor.findById(userId).select('fcmToken').lean();   break;
    case 'rider':    doc = await Rider.findById(userId).select('fcmToken').lean();    break;
    default: break;
  }
  return doc?.fcmToken ?? null;
};

// ── POST /internal/notify ─────────────────────────────────────────
// Service-to-service: any service calls this to send a push notification.
// Body: { type, userId, userRole, data? }
const notifyUser = async (req, res) => {
  try {
    const { type, userId, userRole, data = {} } = req.body;

    if (!type || !userId || !userRole) {
      return res.status(400).json({ success: false, message: 'type, userId, userRole required' });
    }

    const template = getTemplate(type, data);
    if (!template) {
      logger.warn(`Unknown notification type: ${type}`);
      return res.json({ success: true, sent: false, reason: 'unknown_type' });
    }

    const token = await getFcmToken(userId, userRole);
    if (!token) {
      logger.debug(`No FCM token for ${userRole}:${userId} — skipping push`);
      return res.json({ success: true, sent: false, reason: 'no_fcm_token' });
    }

    await sendToToken(token, template);
    return res.json({ success: true, sent: true });
  } catch (err) {
    logger.error('notifyUser error:', err);
    return res.status(500).json({ success: false });
  }
};

// ── POST /promo ───────────────────────────────────────────────────
// Admin: send a promotional push to all active customers (or all riders).
// Body: { title, body, target?: 'customers' | 'riders', screen? }
const sendPromo = async (req, res) => {
  try {
    const { title, body, target = 'customers', screen } = req.body;

    if (!title || !body) {
      return sendError(res, 400, 'title and body are required', ERROR_CODES.MISSING_FIELDS);
    }

    let docs;
    if (target === 'riders') {
      docs = await Rider.find({ isActive: true, fcmToken: { $exists: true, $ne: '' } })
        .select('fcmToken')
        .lean();
    } else {
      // Default: all customers
      docs = await Customer.find({ isActive: true, fcmToken: { $exists: true, $ne: '' } })
        .select('fcmToken')
        .lean();
    }

    const tokens = docs.map((d) => d.fcmToken).filter(Boolean);

    if (tokens.length === 0) {
      return sendSuccess(res, 200, 'No registered devices found', { sent: 0 });
    }

    // FCM multicast limit is 500 tokens per call
    const CHUNK = 500;
    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < tokens.length; i += CHUNK) {
      const chunk = tokens.slice(i, i + CHUNK);
      const result = await sendToMultipleTokens(chunk, {
        title,
        body,
        data: { screen: screen ?? 'Offers' },
      });
      successCount += result.successCount;
      failureCount += result.failureCount;
    }

    logger.info(`Promo push sent: ${successCount} success, ${failureCount} failed (target: ${target})`);
    return sendSuccess(res, 200, 'Promo notification sent', { successCount, failureCount, total: tokens.length });
  } catch (err) {
    logger.error('sendPromo error:', err);
    return sendError(res, 500, 'Failed to send promo notification', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /fcm-token ──────────────────────────────────────────────
// Any authenticated user updates their FCM device token.
// Called by the app on login or when FCM refreshes the token.
// Body: { token }
const updateFcmToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return sendError(res, 400, 'token is required', ERROR_CODES.MISSING_FIELDS);

    const { id: userId, role } = req.user;

    let Model;
    switch (role) {
      case 'customer': Model = Customer; break;
      case 'vendor':   Model = Vendor;   break;
      case 'rider':    Model = Rider;    break;
      default:
        return sendError(res, 400, 'Invalid role', ERROR_CODES.VALIDATION_ERROR);
    }

    await Model.findByIdAndUpdate(userId, { fcmToken: token });
    return sendSuccess(res, 200, 'FCM token updated');
  } catch (err) {
    logger.error('updateFcmToken error:', err);
    return sendError(res, 500, 'Failed to update FCM token', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { notifyUser, sendPromo, updateFcmToken };
