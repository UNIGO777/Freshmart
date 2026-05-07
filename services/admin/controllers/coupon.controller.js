const { z } = require('zod');
const Coupon = require('../models/Coupon.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

const couponSchema = z.object({
  code: z.string().min(2).max(30),
  discountType: z.enum(['flat', 'percent']),
  discountValue: z.number().min(0),
  maxDiscountAmount: z.number().min(0).optional().nullable(),
  minOrderValue: z.number().min(0).optional(),
  maxUses: z.number().int().min(1).optional().nullable(),
  maxUsesPerUser: z.number().int().min(1).optional().nullable(),
  validFrom: z.string().datetime(),
  validTo: z.string().datetime(),
  isActive: z.boolean().optional(),
  description: z.string().optional(),
});

// POST /api/admin/coupons
const createCoupon = async (req, res) => {
  try {
    const parsed = couponSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const existing = await Coupon.findOne({ code: parsed.data.code.toUpperCase() });
    if (existing) return sendError(res, 409, 'Coupon code already exists', ERROR_CODES.ALREADY_EXISTS);

    const coupon = await Coupon.create(parsed.data);
    return sendSuccess(res, 201, 'Coupon created', coupon);
  } catch (err) {
    logger.error('createCoupon error:', err);
    return sendError(res, 500, 'Failed to create coupon', ERROR_CODES.INTERNAL_ERROR);
  }
};

// GET /api/admin/coupons
const listCoupons = async (req, res) => {
  try {
    const { active } = req.query;
    const filter = {};
    if (active === 'true') filter.isActive = true;
    if (active === 'false') filter.isActive = false;

    const coupons = await Coupon.find(filter).select('-usedBy').sort({ createdAt: -1 }).lean();
    return sendSuccess(res, 200, 'Coupons fetched', coupons);
  } catch (err) {
    logger.error('listCoupons error:', err);
    return sendError(res, 500, 'Failed to fetch coupons', ERROR_CODES.INTERNAL_ERROR);
  }
};

// PATCH /api/admin/coupons/:id
const updateCoupon = async (req, res) => {
  try {
    const updateSchema = couponSchema.partial().omit({ code: true });
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const coupon = await Coupon.findByIdAndUpdate(req.params.id, parsed.data, {
      new: true,
      runValidators: true,
    }).select('-usedBy');

    if (!coupon) return sendError(res, 404, 'Coupon not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Coupon updated', coupon);
  } catch (err) {
    logger.error('updateCoupon error:', err);
    return sendError(res, 500, 'Failed to update coupon', ERROR_CODES.INTERNAL_ERROR);
  }
};

// DELETE /api/admin/coupons/:id  — soft delete via isActive=false
const disableCoupon = async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!coupon) return sendError(res, 404, 'Coupon not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Coupon disabled', { id: coupon._id });
  } catch (err) {
    logger.error('disableCoupon error:', err);
    return sendError(res, 500, 'Failed to disable coupon', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { createCoupon, listCoupons, updateCoupon, disableCoupon };
