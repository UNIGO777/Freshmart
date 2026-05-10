const Rider       = require('../../user/models/Rider.model');
const DeliveryJob = require('../../delivery/models/DeliveryJob.model');
const { DELIVERY_JOB_STATUS } = require('../../delivery/models/DeliveryJob.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// ── GET /riders ───────────────────────────────────────────────────
const listRiders = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.approved !== undefined) filter.isApproved = req.query.approved === 'true';
    if (req.query.online   !== undefined) filter.isOnline   = req.query.online   === 'true';
    if (req.query.search) {
      const re = new RegExp(req.query.search, 'i');
      filter.$or = [{ name: re }, { phone: re }];
    }

    const [riders, total] = await Promise.all([
      Rider.find(filter)
        .select('-passwordHash')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Rider.countDocuments(filter),
    ]);

    return sendSuccess(res, 200, 'Riders fetched', { riders, total, page, limit });
  } catch (err) {
    logger.error('listRiders error:', err);
    return sendError(res, 500, 'Failed to fetch riders', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /riders/:id ───────────────────────────────────────────────
// Rider detail + delivery stats
const getRiderDetail = async (req, res) => {
  try {
    const rider = await Rider.findById(req.params.id).select('-passwordHash').lean();
    if (!rider) return sendError(res, 404, 'Rider not found', ERROR_CODES.NOT_FOUND);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [totalDeliveries, todayDeliveries, recentJobs] = await Promise.all([
      DeliveryJob.countDocuments({ riderId: rider._id, status: DELIVERY_JOB_STATUS.DELIVERED }),
      DeliveryJob.countDocuments({
        riderId: rider._id,
        status:  DELIVERY_JOB_STATUS.DELIVERED,
        deliveredAt: { $gte: todayStart },
      }),
      DeliveryJob.find({ riderId: rider._id })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ]);

    return sendSuccess(res, 200, 'Rider detail', {
      rider,
      stats: { totalDeliveries, todayDeliveries },
      recentJobs,
    });
  } catch (err) {
    logger.error('getRiderDetail error:', err);
    return sendError(res, 500, 'Failed to fetch rider', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /riders/:id/approve ─────────────────────────────────────
const approveRider = async (req, res) => {
  try {
    const rider = await Rider.findByIdAndUpdate(
      req.params.id,
      { isApproved: true, isActive: true },
      { new: true, select: '-passwordHash' },
    );
    if (!rider) return sendError(res, 404, 'Rider not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Rider approved', rider);
  } catch (err) {
    logger.error('approveRider error:', err);
    return sendError(res, 500, 'Failed to approve rider', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /riders/:id/block ───────────────────────────────────────
const blockRider = async (req, res) => {
  try {
    const rider = await Rider.findByIdAndUpdate(
      req.params.id,
      { isApproved: false, isActive: false, isOnline: false },
      { new: true, select: '-passwordHash' },
    );
    if (!rider) return sendError(res, 404, 'Rider not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Rider blocked', rider);
  } catch (err) {
    logger.error('blockRider error:', err);
    return sendError(res, 500, 'Failed to block rider', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /riders ──────────────────────────────────────────────────
const createRider = async (req, res) => {
  try {
    const {
      name, phone, password, vehicleType,
      aadhaarUrl, panUrl,
    } = req.body;

    if (!name || !phone || !password) {
      return sendError(res, 400, 'name, phone and password are required', ERROR_CODES.MISSING_FIELDS);
    }

    const existing = await Rider.findOne({ phone });
    if (existing) return sendError(res, 409, 'Phone number already registered', ERROR_CODES.ALREADY_EXISTS);

    const bcrypt = require('bcryptjs');
    const passwordHash = await bcrypt.hash(password, 12);

    const rider = await Rider.create({
      name,
      phone,
      passwordHash,
      vehicleType: vehicleType || 'bike',
      isApproved: true,
      isActive: true,
      kyc: { aadhaarUrl: aadhaarUrl || '', panUrl: panUrl || '', status: 'pending' },
    });

    const r = rider.toObject();
    delete r.passwordHash;
    return sendSuccess(res, 201, 'Rider created', r);
  } catch (err) {
    logger.error('createRider error:', err);
    return sendError(res, 500, 'Failed to create rider', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { listRiders, getRiderDetail, approveRider, blockRider, createRider };
