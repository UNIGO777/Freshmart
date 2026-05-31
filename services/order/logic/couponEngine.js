const Coupon = require('../../admin/models/Coupon.model');

/**
 * Validate a coupon code and compute the discount amount.
 *
 * @param {string} code
 * @param {number} orderSubtotal  Pre-discount order total (rupees, not paise)
 * @param {string} customerId
 * @returns {Promise<{
 *   valid: boolean,
 *   reason?: string,
 *   discountAmount: number,
 *   coupon?: Object,
 * }>}
 */
const validateCoupon = async (code, orderSubtotal, customerId) => {
  const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });

  if (!coupon) return { valid: false, reason: 'Coupon not found or inactive', discountAmount: 0 };

  const now = new Date();
  if (now < coupon.validFrom) return { valid: false, reason: 'Coupon is not yet active', discountAmount: 0 };
  if (now > coupon.validTo) return { valid: false, reason: 'Coupon has expired', discountAmount: 0 };

  if (coupon.maxUses !== null && coupon.usedCount >= coupon.maxUses) {
    return { valid: false, reason: 'Coupon usage limit reached', discountAmount: 0 };
  }

  if (orderSubtotal < coupon.minOrderValue) {
    return {
      valid: false,
      reason: `Minimum order value of ₹${coupon.minOrderValue} required`,
      discountAmount: 0,
    };
  }

  // Per-user limit check
  if (coupon.maxUsesPerUser !== null) {
    const timesUsed = coupon.usedBy.filter((id) => id.toString() === customerId.toString()).length;
    if (timesUsed >= coupon.maxUsesPerUser) {
      return { valid: false, reason: 'You have already used this coupon', discountAmount: 0 };
    }
  }

  // Calculate discount
  let discountAmount;
  if (coupon.discountType === 'flat') {
    discountAmount = Math.min(coupon.discountValue, orderSubtotal);
  } else {
    discountAmount = (orderSubtotal * coupon.discountValue) / 100;
    if (coupon.maxDiscountAmount !== null) {
      discountAmount = Math.min(discountAmount, coupon.maxDiscountAmount);
    }
  }

  return { valid: true, discountAmount: Math.round(discountAmount * 100) / 100, coupon };
};

/**
 * Atomically mark coupon as used by a customer.
 * Uses findOneAndUpdate to safely increment usedCount.
 *
 * @param {string} couponId
 * @param {string} customerId
 */
const markCouponUsed = async (couponId, customerId) => {
  await Coupon.findByIdAndUpdate(couponId, {
    $inc: { usedCount: 1 },
    $push: { usedBy: customerId },
  });
};

/**
 * Release a coupon reservation (on order cancel/payment failure).
 *
 * @param {string} couponId
 * @param {string} customerId
 */
const releaseCoupon = async (couponId, customerId) => {
  await Coupon.findOneAndUpdate(
    { _id: couponId, usedCount: { $gt: 0 } },
    { $inc: { usedCount: -1 }, $pull: { usedBy: customerId } },
  );
};

/**
 * Mark a coupon used, identified by its code (used by services that only have
 * the order's stored couponCode, e.g. payment confirmation).
 *
 * @param {string} code
 * @param {string} customerId
 */
const markCouponUsedByCode = async (code, customerId) => {
  if (!code) return;
  await Coupon.findOneAndUpdate(
    { code: code.toUpperCase() },
    { $inc: { usedCount: 1 }, $push: { usedBy: customerId } },
  );
};

/**
 * Release a coupon hold identified by its code (used on cancel/refund where
 * only the order's stored couponCode is available). Never drives usedCount
 * below zero.
 *
 * @param {string} code
 * @param {string} customerId
 */
const releaseCouponByCode = async (code, customerId) => {
  if (!code) return;
  await Coupon.findOneAndUpdate(
    { code: code.toUpperCase(), usedCount: { $gt: 0 } },
    { $inc: { usedCount: -1 }, $pull: { usedBy: customerId } },
  );
};

module.exports = { validateCoupon, markCouponUsed, releaseCoupon, markCouponUsedByCode, releaseCouponByCode };
