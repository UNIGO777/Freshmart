const { z } = require('zod');
const Banner = require('../models/Banner.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

const createBannerSchema = z.object({
  imageUrl: z.string().url(),
  title: z.string().trim().default(''),
  linkUrl: z.string().trim().default(''),
  position: z.number().int().min(0).default(0),
  isActive: z.boolean().default(false),
  type: z.enum(['hero', 'deal_of_day']).default('hero'),
});

const updateBannerSchema = z.object({
  title: z.string().trim().optional(),
  linkUrl: z.string().trim().optional(),
  position: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

// GET /banners — all banners sorted by position, optionally filtered by ?type=
const listBanners = async (req, res) => {
  try {
    const filter = req.query.type ? { type: req.query.type } : {};
    const banners = await Banner.find(filter).sort({ position: 1, createdAt: 1 });
    return sendSuccess(res, 200, 'Banners fetched', banners);
  } catch (err) {
    logger.error('listBanners error', err);
    return sendError(res, 500, 'Failed to fetch banners', ERROR_CODES.SERVER_ERROR);
  }
};

// POST /banners
const createBanner = async (req, res) => {
  const parsed = createBannerSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, parsed.error.issues[0].message, ERROR_CODES.VALIDATION_ERROR);
  }
  try {
    const banner = await Banner.create(parsed.data);
    return sendSuccess(res, 201, 'Banner created', banner);
  } catch (err) {
    logger.error('createBanner error', err);
    return sendError(res, 500, 'Failed to create banner', ERROR_CODES.SERVER_ERROR);
  }
};

// PATCH /banners/:id
const updateBanner = async (req, res) => {
  const parsed = updateBannerSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, parsed.error.issues[0].message, ERROR_CODES.VALIDATION_ERROR);
  }
  try {
    const banner = await Banner.findByIdAndUpdate(req.params.id, parsed.data, { new: true });
    if (!banner) return sendError(res, 404, 'Banner not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Banner updated', banner);
  } catch (err) {
    logger.error('updateBanner error', err);
    return sendError(res, 500, 'Failed to update banner', ERROR_CODES.SERVER_ERROR);
  }
};

// DELETE /banners/:id
const deleteBanner = async (req, res) => {
  try {
    const banner = await Banner.findByIdAndDelete(req.params.id);
    if (!banner) return sendError(res, 404, 'Banner not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Banner deleted', { deleted: true });
  } catch (err) {
    logger.error('deleteBanner error', err);
    return sendError(res, 500, 'Failed to delete banner', ERROR_CODES.SERVER_ERROR);
  }
};

// PATCH /banners/:id/toggle — independently flip this banner's active state.
// Multiple banners of the same type can be active at once; the storefront shows
// all active banners (of a type) as a carousel, sorted by position.
const toggleBanner = async (req, res) => {
  try {
    const banner = await Banner.findById(req.params.id);
    if (!banner) return sendError(res, 404, 'Banner not found', ERROR_CODES.NOT_FOUND);
    banner.isActive = !banner.isActive;
    await banner.save();
    return sendSuccess(res, 200, 'Banner toggled', banner);
  } catch (err) {
    logger.error('toggleBanner error', err);
    return sendError(res, 500, 'Failed to toggle banner', ERROR_CODES.SERVER_ERROR);
  }
};

// PUT /banners/reorder — body: { order: [{ id, position }] }
const reorderBanners = async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) {
    return sendError(res, 400, 'order must be an array', ERROR_CODES.VALIDATION_ERROR);
  }
  try {
    await Promise.all(
      order.map(({ id, position }) =>
        Banner.findByIdAndUpdate(id, { position }),
      ),
    );
    const banners = await Banner.find().sort({ position: 1, createdAt: 1 });
    return sendSuccess(res, 200, 'Banners reordered', banners);
  } catch (err) {
    logger.error('reorderBanners error', err);
    return sendError(res, 500, 'Failed to reorder banners', ERROR_CODES.SERVER_ERROR);
  }
};

module.exports = { listBanners, createBanner, updateBanner, deleteBanner, toggleBanner, reorderBanners };
