const { orderTrackingRoom } = require('../rooms');
const logger = require('../../../shared/utils/logger');

/**
 * Register order tracking socket events for a connected client (any role).
 * Customers call join:order after placing/retrieving an order to receive:
 *   - order:status  (status changes)
 *   - rider:location  (live lat/lng while rider is in transit)
 */
const registerOrderTracking = (io, socket) => {
  socket.on('join:order', ({ orderId } = {}) => {
    if (!orderId) return;
    const room = orderTrackingRoom(orderId);
    socket.join(room);
    logger.debug(`Socket ${socket.id} joined ${room}`);
    socket.emit('joined:order', { orderId, room });
  });

  socket.on('leave:order', ({ orderId } = {}) => {
    if (!orderId) return;
    socket.leave(orderTrackingRoom(orderId));
    logger.debug(`Socket ${socket.id} left order:tracking:${orderId}`);
  });
};

module.exports = { registerOrderTracking };
