/**
 * Push notification templates — maps notification type to { title, body }.
 *
 * `data` is the context object forwarded from the triggering service.
 * Keep title short (shown in status bar) and body concise (2 lines max on device).
 */

const TEMPLATES = {
  // ── Customer notifications ──────────────────────────────────────

  /** All vendors have accepted — order is locked in */
  'order:confirmed': (data) => ({
    title: 'Order Confirmed! 🛒',
    body:  'Your order has been confirmed and is being prepared.',
    data:  { orderId: data.orderId ?? '', screen: 'OrderDetail' },
  }),

  /** No vendor could fulfil the order */
  'order:failed': (data) => ({
    title: 'Order Could Not Be Placed',
    body:  data.reason ?? 'No vendor was available for your order. Please try again.',
    data:  { orderId: data.orderId ?? '', screen: 'Home' },
  }),

  /** A rider has been assigned and is heading to the vendor */
  'rider:assigned': (data) => ({
    title: 'Rider On The Way 🛵',
    body:  `${data.riderName ?? 'Your rider'} is heading to pick up your order.`,
    data:  { orderId: data.orderId ?? '', screen: 'OrderTracking' },
  }),

  /** Rider has picked up from vendor — en route to customer */
  'order:picked': (data) => ({
    title: 'Order Picked Up 📦',
    body:  'Your order has been picked up and is on its way to you!',
    data:  { orderId: data.orderId ?? '', screen: 'OrderTracking' },
  }),

  /** Rider has delivered the order */
  'order:delivered': (data) => ({
    title: 'Order Delivered ✅',
    body:  'Your order has been delivered. Enjoy! Please rate your experience.',
    data:  { orderId: data.orderId ?? '', screen: 'RateOrder' },
  }),

  // ── Vendor notifications ────────────────────────────────────────

  /** New order has been routed to this vendor */
  'order:incoming': (data) => ({
    title: 'New Order Received! 🆕',
    body:  `You have a new order. Accept within ${data.expiresIn ?? 90} seconds.`,
    data:  { orderId: data.orderId ?? '', screen: 'IncomingOrder' },
  }),

  /** Order was reassigned away from this vendor (cascade) */
  'order:rerouted': (data) => ({
    title: 'Order Reassigned',
    body:  'An order offer has expired and been sent to another vendor.',
    data:  { orderId: data.orderId ?? '', screen: 'Dashboard' },
  }),

  // ── Rider notifications ─────────────────────────────────────────

  /** New delivery job offered to rider (30s window) */
  'job:request': (data) => ({
    title: 'New Delivery Request 🚀',
    body:  `New delivery job available. Accept within ${data.expiresIn ?? 30} seconds!`,
    data:  { jobId: data.jobId ?? '', screen: 'JobRequest' },
  }),

  /** Rider's offer window expired */
  'job:expired': (data) => ({
    title: 'Job Offer Expired',
    body:  'A delivery offer was assigned to another rider.',
    data:  { jobId: data.jobId ?? '', screen: 'Dashboard' },
  }),

  // ── Promo (admin-triggered bulk) ───────────────────────────────

  /** Admin sends a promotional notification — title/body provided directly */
  'promo': (data) => ({
    title: data.title ?? 'Special Offer 🎉',
    body:  data.body  ?? 'Check out the latest deals on FreshMart!',
    data:  { screen: data.screen ?? 'Offers' },
  }),
};

/**
 * Get the notification template for a given type.
 * Returns null if the type is not registered.
 *
 * @param {string} type
 * @param {Object} data
 * @returns {{ title: string, body: string, data: Object } | null}
 */
const getTemplate = (type, data = {}) => {
  const builder = TEMPLATES[type];
  if (!builder) return null;
  return builder(data);
};

module.exports = { getTemplate, TEMPLATES };
