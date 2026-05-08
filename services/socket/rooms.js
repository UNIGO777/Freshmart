/**
 * Room name helpers — single source of truth for all Socket.io rooms.
 * Each client joins its own identity room on connect.
 * Customers additionally join per-order tracking rooms.
 */

const customerRoom = (id) => `customer:${String(id)}`;
const vendorRoom = (id) => `vendor:${String(id)}`;
const riderRoom = (id) => `rider:${String(id)}`;

/** Customer joins this room to receive live rider location + status updates for an order. */
const orderTrackingRoom = (orderId) => `order:tracking:${String(orderId)}`;

module.exports = { customerRoom, vendorRoom, riderRoom, orderTrackingRoom };
