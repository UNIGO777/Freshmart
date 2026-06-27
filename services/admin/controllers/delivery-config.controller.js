const { z } = require('zod');
const DeliveryRateConfig = require('../models/DeliveryRateConfig.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// ── GET /delivery-config ────────────────────────────────────────
const getDeliveryConfig = async (_req, res) => {
  try {
    const config = await DeliveryRateConfig.getConfig();
    return sendSuccess(res, 200, 'Delivery config fetched', config);
  } catch (err) {
    logger.error('getDeliveryConfig error:', err);
    return sendError(res, 500, 'Failed to fetch config', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /delivery-config/rate ─────────────────────────────────
const updateRateSchema = z.object({
  ratePerKm: z.number().min(0),
});

const updateRate = async (req, res) => {
  try {
    const parsed = updateRateSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Valid ratePerKm (number >= 0) required', ERROR_CODES.VALIDATION_ERROR);
    }

    const config = await DeliveryRateConfig.getConfig();
    config.ratePerKm = parsed.data.ratePerKm;
    config.updatedBy = req.user.id;
    await config.save();

    return sendSuccess(res, 200, 'Rate updated', config);
  } catch (err) {
    logger.error('updateRate error:', err);
    return sendError(res, 500, 'Failed to update rate', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /delivery-config/surge ────────────────────────────────
const updateSurgeSchema = z.object({
  surgeActive:     z.boolean(),
  surgeMultiplier: z.number().min(1.0).optional(),
  surgeReason:     z.string().optional(),
});

const updateSurge = async (req, res) => {
  try {
    const parsed = updateSurgeSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'surgeActive (boolean) is required', ERROR_CODES.VALIDATION_ERROR);
    }

    const config = await DeliveryRateConfig.getConfig();
    config.surgeActive = parsed.data.surgeActive;
    if (parsed.data.surgeMultiplier != null) config.surgeMultiplier = parsed.data.surgeMultiplier;
    if (parsed.data.surgeReason != null) config.surgeReason = parsed.data.surgeReason;
    config.surgeStartedAt = parsed.data.surgeActive ? new Date() : null;
    config.updatedBy = req.user.id;
    await config.save();

    return sendSuccess(res, 200, `Surge ${parsed.data.surgeActive ? 'activated' : 'deactivated'}`, config);
  } catch (err) {
    logger.error('updateSurge error:', err);
    return sendError(res, 500, 'Failed to update surge', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /delivery-config/fees ────────────────────────────────
const updateFeesSchema = z.object({
  deliveryFee:           z.number().min(0).optional(),
  freeDeliveryThreshold: z.number().min(0).optional(),
});

const updateFees = async (req, res) => {
  try {
    const parsed = updateFeesSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Invalid fee values', ERROR_CODES.VALIDATION_ERROR);
    }

    const config = await DeliveryRateConfig.getConfig();
    if (parsed.data.deliveryFee != null) config.deliveryFee = parsed.data.deliveryFee;
    if (parsed.data.freeDeliveryThreshold != null) config.freeDeliveryThreshold = parsed.data.freeDeliveryThreshold;
    config.updatedBy = req.user.id;
    await config.save();

    return sendSuccess(res, 200, 'Delivery fees updated', config);
  } catch (err) {
    logger.error('updateFees error:', err);
    return sendError(res, 500, 'Failed to update fees', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /delivery-config/customer (public — no auth) ───────────
const getCustomerDeliveryConfig = async (_req, res) => {
  try {
    const config = await DeliveryRateConfig.getConfig();
    return sendSuccess(res, 200, 'Delivery config', {
      deliveryFee: config.deliveryFee,
      freeDeliveryThreshold: config.freeDeliveryThreshold,
    });
  } catch (err) {
    logger.error('getCustomerDeliveryConfig error:', err);
    return sendError(res, 500, 'Failed to fetch config', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { getDeliveryConfig, updateRate, updateSurge, updateFees, getCustomerDeliveryConfig };
