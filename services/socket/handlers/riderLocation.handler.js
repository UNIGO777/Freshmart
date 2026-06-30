const { orderTrackingRoom } = require('../rooms');
const logger = require('../../../shared/utils/logger');

/**
 * Register rider location events for a connected rider socket.
 * The rider app emits `rider:location` every 5 seconds while active.
 *
 * Flow:
 *  1. Persist location update via Delivery Service internal HTTP (for geo queries).
 *  2. Broadcast lat/lng to all customers watching this order's tracking room.
 */
const registerRiderLocation = (io, socket, { riderId }) => {
  socket.on('rider:location', async ({ lat, lng, heading, orderId } = {}) => {
    if (lat == null || lng == null) return;

    // Persist to DB via Delivery Service — non-fatal if it fails
    try {
      const axios = require('axios');
      await axios.post(
        `http://localhost:${process.env.PORT_DELIVERY || 3006}/internal/location-update`,
        { riderId, lat, lng, orderId },
        { timeout: 3000 },
      );
    } catch (err) {
      logger.warn(`Rider ${riderId} location persist failed: ${err.message}`);
    }

    // Broadcast to customers tracking this order in real-time (include heading for icon rotation)
    if (orderId) {
      io.to(orderTrackingRoom(orderId)).emit('rider:location', { lat, lng, heading, riderId, orderId });
    }
  });
};

module.exports = { registerRiderLocation };
