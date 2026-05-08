require('dotenv').config();
const axios = require('axios');
const logger = require('./logger');

/**
 * Fire-and-forget FCM push notification trigger.
 * Calls the Notification Service's internal endpoint — does NOT block the caller.
 *
 * @param {string} type      Notification type key (e.g. 'order:confirmed', 'job:request')
 * @param {string} userId    Target user's MongoDB _id string
 * @param {string} userRole  'customer' | 'vendor' | 'rider'
 * @param {Object} [data]    Extra context passed to the notification template
 */
const triggerNotification = (type, userId, userRole, data = {}) => {
  axios
    .post(
      `http://localhost:${process.env.PORT_NOTIFICATION || 3008}/internal/notify`,
      { type, userId, userRole, data },
      { timeout: 3000 },
    )
    .catch((err) =>
      logger.warn(`Notification trigger failed (${type} → ${userRole}:${userId}): ${err.message}`),
    );
  // Intentionally no await — push notifications are non-blocking best-effort
};

module.exports = { triggerNotification };
