const ORDER_STATUS = {
  STOCK_CHECK: 'stock_check',
  AWAITING_PAYMENT: 'awaiting_payment',
  CONFIRMED: 'confirmed',
  PARTIALLY_DELIVERED: 'partially_delivered',
  DELIVERED: 'delivered',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

const SUB_ORDER_STATUS = {
  PENDING: 'pending',
  VENDOR_ACCEPTED: 'vendor_accepted',
  RIDER_ASSIGNED: 'rider_assigned',
  PICKED: 'picked',
  DELIVERED: 'delivered',
  FAILED: 'failed',
};

const PAYMENT_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  REFUNDED: 'refunded',
};

module.exports = { ORDER_STATUS, SUB_ORDER_STATUS, PAYMENT_STATUS };
