const { z } = require('zod');
const SupportQuery = require('../models/SupportQuery.model');
const Customer = require('../models/Customer.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const ROLES = require('../../../shared/constants/roles');
const logger = require('../../../shared/utils/logger');
const axios = require('axios');

const SOCKET_URL        = `http://localhost:${process.env.PORT_SOCKET        || 3010}`;
const NOTIFICATION_URL  = `http://localhost:${process.env.PORT_NOTIFICATION  || 3008}`;

// POST /support/queries — customer submits a query
const submitQuery = async (req, res) => {
  try {
    if (req.user.role !== ROLES.CUSTOMER) {
      return sendError(res, 403, 'Only customers can submit queries', ERROR_CODES.FORBIDDEN);
    }
    const parsed = z.object({ message: z.string().min(5).max(2000) }).safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }
    const customer = await Customer.findById(req.user.id).select('name').lean();
    const query = await SupportQuery.create({
      customerId: req.user.id,
      customerName: customer?.name ?? 'Unknown',
      message: parsed.data.message,
    });
    return sendSuccess(res, 201, 'Query submitted', query);
  } catch (err) {
    logger.error('submitQuery error:', err);
    return sendError(res, 500, 'Failed to submit query', ERROR_CODES.INTERNAL_ERROR);
  }
};

// GET /support/queries — customer views their own queries
const getMyQueries = async (req, res) => {
  try {
    if (req.user.role !== ROLES.CUSTOMER) {
      return sendError(res, 403, 'Only customers can view queries', ERROR_CODES.FORBIDDEN);
    }
    const queries = await SupportQuery.find({ customerId: req.user.id }).sort({ createdAt: -1 }).lean();
    return sendSuccess(res, 200, 'Queries fetched', queries);
  } catch (err) {
    logger.error('getMyQueries error:', err);
    return sendError(res, 500, 'Failed to fetch queries', ERROR_CODES.INTERNAL_ERROR);
  }
};

// POST /support/queries/:id/reply — admin replies (protected by x-admin-secret header)
const adminReply = async (req, res) => {
  try {
    const adminSecret = process.env.ADMIN_SUPPORT_SECRET || 'freshmart-admin-2024';
    if (req.headers['x-admin-secret'] !== adminSecret) {
      return sendError(res, 403, 'Forbidden', ERROR_CODES.FORBIDDEN);
    }
    const parsed = z.object({ text: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }
    const query = await SupportQuery.findById(req.params.id);
    if (!query) return sendError(res, 404, 'Query not found', ERROR_CODES.NOT_FOUND);

    query.replies.push({ from: 'admin', text: parsed.data.text });
    await query.save();

    const savedReply = query.replies[query.replies.length - 1];

    // Emit real-time reply to customer via socket
    try {
      await axios.post(`${SOCKET_URL}/internal/emit`, {
        room:    `customer:${query.customerId}`,
        event:   'support:reply',
        payload: { queryId: query._id, reply: savedReply },
      }, { timeout: 3000 });
    } catch (socketErr) {
      logger.warn('Failed to emit support:reply socket event:', socketErr.message);
    }

    // Send FCM push notification to customer
    try {
      const preview = parsed.data.text.length > 60
        ? parsed.data.text.slice(0, 60) + '…'
        : parsed.data.text;
      await axios.post(`${NOTIFICATION_URL}/internal/notify`, {
        type:     'support:reply',
        userId:   query.customerId.toString(),
        userRole: 'customer',
        data:     { preview },
      }, { timeout: 3000 });
    } catch (notifErr) {
      logger.warn('Failed to send support:reply push notification:', notifErr.message);
    }

    return sendSuccess(res, 200, 'Reply sent', query);
  } catch (err) {
    logger.error('adminReply error:', err);
    return sendError(res, 500, 'Failed to send reply', ERROR_CODES.INTERNAL_ERROR);
  }
};

// GET /support/queries/all — admin views all queries (protected by x-admin-secret)
const getAllQueries = async (req, res) => {
  try {
    const adminSecret = process.env.ADMIN_SUPPORT_SECRET || 'freshmart-admin-2024';
    if (req.headers['x-admin-secret'] !== adminSecret) {
      return sendError(res, 403, 'Forbidden', ERROR_CODES.FORBIDDEN);
    }
    const queries = await SupportQuery.find().sort({ createdAt: -1 }).lean();
    return sendSuccess(res, 200, 'All queries fetched', queries);
  } catch (err) {
    logger.error('getAllQueries error:', err);
    return sendError(res, 500, 'Failed to fetch queries', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { submitQuery, getMyQueries, adminReply, getAllQueries };
