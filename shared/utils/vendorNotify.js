const axios = require('axios');
const logger = require('./logger');

const VENDOR_URL = `http://localhost:${process.env.PORT_VENDOR || 4005}`;

const notifyVendor = async (vendorId, type, title, body, orderId, data) => {
  try {
    await axios.post(
      `${VENDOR_URL}/internal/notification`,
      { vendorId, type, title, body, orderId, data },
      { timeout: 3000 },
    );
  } catch (err) {
    logger.warn(`vendorNotify failed (${type}): ${err.message}`);
  }
};

module.exports = { notifyVendor };
