require('dotenv').config();
const axios = require('axios');
const logger = require('./logger');

/**
 * Fire-and-forget panel notification trigger.
 * Calls the Panel-Notify Service's internal endpoint — does NOT block the caller.
 *
 * @param {string} type   Notification type (e.g. 'new_order', 'rider_online')
 * @param {string} title  Short notification title
 * @param {string} body   Notification body text
 * @param {Object} [data] Extra context (orderId, amount, etc.)
 * @param {string} [panel] Target panel — defaults to 'admin'
 */
const notifyAdmin = (type, title, body, data = {}, panel = 'admin') => {
  axios
    .post(
      `http://localhost:${process.env.PORT_PANEL_NOTIFY || 3012}/internal/create`,
      { panel, type, title, body, data },
      { timeout: 3000 },
    )
    .catch((err) => logger.warn(`notifyAdmin failed (${type}): ${err.message}`));
  // Intentionally no await — panel notifications are non-blocking best-effort
};

module.exports = { notifyAdmin };
