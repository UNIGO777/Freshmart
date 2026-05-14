const { z } = require('zod');
const SupportQuery = require('../models/SupportQuery.model');
const Customer = require('../models/Customer.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const ROLES = require('../../../shared/constants/roles');
const logger = require('../../../shared/utils/logger');
const axios = require('axios');
const { sendEmail } = require('../../../shared/utils/email.util');

const SOCKET_URL       = `http://localhost:${process.env.PORT_SOCKET       || 3010}`;
const NOTIFICATION_URL = `http://localhost:${process.env.PORT_NOTIFICATION || 3008}`;
const ADMIN_EMAIL      = process.env.ADMIN_EMAIL || 'admin@freshmart.in';

// ── POST /queries — customer submits a query ────────────────────
const submitQuery = async (req, res) => {
  try {
    if (req.user.role !== ROLES.CUSTOMER) {
      return sendError(res, 403, 'Only customers can submit queries', ERROR_CODES.FORBIDDEN);
    }
    const parsed = z.object({ message: z.string().min(5).max(2000) }).safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }
    const customer = await Customer.findById(req.user.id).select('name email').lean();
    const query = await SupportQuery.create({
      customerId: req.user.id,
      customerName: customer?.name ?? 'Unknown',
      customerEmail: customer?.email ?? null,
      message: parsed.data.message,
    });

    // Notify admin via socket (real-time on admin panel)
    try {
      await axios.post(`${SOCKET_URL}/internal/emit`, {
        room:    'admin:panel',
        event:   'support:new-query',
        payload: query.toObject(),
      }, { timeout: 3000 });
    } catch (e) {
      logger.warn('Failed to emit support:new-query socket event:', e.message);
    }

    // Email admin about the new query
    sendEmail({
      to:      ADMIN_EMAIL,
      subject: `New Support Query from ${customer?.name ?? 'Customer'}`,
      html:    `<p><strong>${customer?.name ?? 'Customer'}</strong> submitted a support query:</p>
                <blockquote style="border-left:3px solid #10d876;padding:8px 12px;margin:12px 0;background:#f8f9fa;">
                  ${parsed.data.message}
                </blockquote>
                <p>Reply from the <a href="${process.env.ADMIN_PANEL_URL || 'http://localhost:3100'}/support">Admin Panel</a>.</p>`,
    });

    return sendSuccess(res, 201, 'Query submitted', query);
  } catch (err) {
    logger.error('submitQuery error:', err);
    return sendError(res, 500, 'Failed to submit query', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /queries — customer views their own queries ─────────────
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

// ── POST /queries/:id/customer-reply — customer replies to thread ───
const customerReply = async (req, res) => {
  try {
    if (req.user.role !== ROLES.CUSTOMER) {
      return sendError(res, 403, 'Only customers can reply', ERROR_CODES.FORBIDDEN);
    }
    const parsed = z.object({ text: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }
    const query = await SupportQuery.findOne({ _id: req.params.id, customerId: req.user.id });
    if (!query) return sendError(res, 404, 'Query not found', ERROR_CODES.NOT_FOUND);

    query.replies.push({ from: 'customer', text: parsed.data.text });
    if (query.status === 'closed') query.status = 'open';
    await query.save();

    const savedReply = query.replies[query.replies.length - 1];

    // Notify admin panel in real-time
    try {
      await axios.post(`${SOCKET_URL}/internal/emit`, {
        room:    'admin:panel',
        event:   'support:customer-reply',
        payload: { queryId: query._id, reply: savedReply, customerName: query.customerName },
      }, { timeout: 3000 });
    } catch (e) {
      logger.warn('Failed to emit support:customer-reply:', e.message);
    }

    // Email admin about customer reply
    sendEmail({
      to:      ADMIN_EMAIL,
      subject: `Support Reply from ${query.customerName}`,
      html:    `<p><strong>${query.customerName}</strong> replied to their support query:</p>
                <blockquote style="border-left:3px solid #10d876;padding:8px 12px;margin:12px 0;background:#f8f9fa;">
                  ${parsed.data.text}
                </blockquote>
                <p style="color:#888;font-size:12px;">Original query: "${query.message.slice(0, 100)}${query.message.length > 100 ? '…' : ''}"</p>
                <p>Reply from the <a href="${process.env.ADMIN_PANEL_URL || 'http://localhost:3100'}/support">Admin Panel</a>.</p>`,
    });

    return sendSuccess(res, 200, 'Reply sent', query);
  } catch (err) {
    logger.error('customerReply error:', err);
    return sendError(res, 500, 'Failed to send reply', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /queries/:id/reply — admin replies (JWT + ADMIN role) ──
const adminReply = async (req, res) => {
  try {
    if (req.user.role !== ROLES.ADMIN) {
      return sendError(res, 403, 'Admin only', ERROR_CODES.FORBIDDEN);
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

    // Send email to customer (if email is available)
    if (query.customerEmail) {
      sendEmail({
        to:      query.customerEmail,
        subject: 'FreshMart Support — Reply to your query',
        html:    `<p>Hi ${query.customerName},</p>
                  <p>Our support team has replied to your query:</p>
                  <blockquote style="border-left:3px solid #10d876;padding:8px 12px;margin:12px 0;background:#f8f9fa;">
                    ${parsed.data.text}
                  </blockquote>
                  <p style="color:#888;font-size:12px;">Original query: "${query.message.slice(0, 100)}${query.message.length > 100 ? '…' : ''}"</p>
                  <p>Open the FreshMart app to continue the conversation.</p>`,
      });
    }

    return sendSuccess(res, 200, 'Reply sent', query);
  } catch (err) {
    logger.error('adminReply error:', err);
    return sendError(res, 500, 'Failed to send reply', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /queries/all — admin views all queries (JWT + ADMIN) ────
const getAllQueries = async (req, res) => {
  try {
    if (req.user.role !== ROLES.ADMIN) {
      return sendError(res, 403, 'Admin only', ERROR_CODES.FORBIDDEN);
    }
    const { status } = req.query;
    const filter = {};
    if (status === 'open' || status === 'closed') filter.status = status;
    const queries = await SupportQuery.find(filter).sort({ updatedAt: -1 }).lean();
    return sendSuccess(res, 200, 'All queries fetched', queries);
  } catch (err) {
    logger.error('getAllQueries error:', err);
    return sendError(res, 500, 'Failed to fetch queries', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── PATCH /queries/:id/status — admin closes/reopens a query ────
const updateQueryStatus = async (req, res) => {
  try {
    if (req.user.role !== ROLES.ADMIN) {
      return sendError(res, 403, 'Admin only', ERROR_CODES.FORBIDDEN);
    }
    const parsed = z.object({ status: z.enum(['open', 'closed']) }).safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }
    const query = await SupportQuery.findByIdAndUpdate(
      req.params.id,
      { status: parsed.data.status },
      { new: true },
    );
    if (!query) return sendError(res, 404, 'Query not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, 200, 'Query status updated', query);
  } catch (err) {
    logger.error('updateQueryStatus error:', err);
    return sendError(res, 500, 'Failed to update status', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { submitQuery, getMyQueries, customerReply, adminReply, getAllQueries, updateQueryStatus };
