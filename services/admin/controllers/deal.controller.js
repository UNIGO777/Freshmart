const { z } = require('zod');
const DealOfDay = require('../models/DealOfDay.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

const dealSchema = z.object({
  heading:  z.string().max(60).optional(),
  title:    z.string().min(3).max(120),
  price:    z.number().min(0),
  cutPrice: z.number().min(0),
  bgImage:  z.string().optional(),
  isActive: z.boolean().optional(),
});

// ── GET /deals — admin: list all deals ──────────────────────────
const listDeals = async (_req, res) => {
  try {
    const deals = await DealOfDay.find().sort({ updatedAt: -1 }).lean();
    return sendSuccess(res, 200, 'Deals fetched', deals);
  } catch (err) {
    logger.error('listDeals error:', err);
    return sendError(res, 500, 'Failed to fetch deals', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /deals/active — public: active deal for app ─────────────
const getActiveDeal = async (_req, res) => {
  try {
    const deal = await DealOfDay.findOne({ isActive: true }).sort({ updatedAt: -1 }).lean();
    return sendSuccess(res, 200, 'Active deal', deal);
  } catch (err) {
    logger.error('getActiveDeal error:', err);
    return sendError(res, 500, 'Failed to fetch deal', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /deals — admin: create deal ────────────────────────────
const createDeal = async (req, res) => {
  try {
    const parsed = dealSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }
    const deal = await DealOfDay.create(parsed.data);
    return sendSuccess(res, 201, 'Deal created', deal);
  } catch (err) {
    logger.error('createDeal error:', err);
    return sendError(res, 500, 'Failed to create deal', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /deals/:id — admin: update deal ───────────────────────
const updateDeal = async (req, res) => {
  try {
    const parsed = dealSchema.partial().safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }
    const deal = await DealOfDay.findByIdAndUpdate(req.params.id, parsed.data, { new: true });
    if (!deal) return sendError(res, 404, 'Deal not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Deal updated', deal);
  } catch (err) {
    logger.error('updateDeal error:', err);
    return sendError(res, 500, 'Failed to update deal', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /deals/:id/toggle — admin: toggle active ──────────────
const toggleDeal = async (req, res) => {
  try {
    const deal = await DealOfDay.findById(req.params.id);
    if (!deal) return sendError(res, 404, 'Deal not found', ERROR_CODES.NOT_FOUND);
    deal.isActive = !deal.isActive;
    await deal.save();
    return sendSuccess(res, 200, 'Deal toggled', deal);
  } catch (err) {
    logger.error('toggleDeal error:', err);
    return sendError(res, 500, 'Failed to toggle deal', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── DELETE /deals/:id — admin: delete deal ──────────────────────
const deleteDeal = async (req, res) => {
  try {
    const deal = await DealOfDay.findByIdAndDelete(req.params.id);
    if (!deal) return sendError(res, 404, 'Deal not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Deal deleted');
  } catch (err) {
    logger.error('deleteDeal error:', err);
    return sendError(res, 500, 'Failed to delete deal', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { listDeals, getActiveDeal, createDeal, updateDeal, toggleDeal, deleteDeal };
