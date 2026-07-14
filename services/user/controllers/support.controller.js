const { z } = require('zod');
const SupportQuery = require('../models/SupportQuery.model');
const Customer = require('../models/Customer.model');
const Rider = require('../models/Rider.model');
const Vendor = require('../models/Vendor.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const ROLES = require('../../../shared/constants/roles');
const logger = require('../../../shared/utils/logger');
const axios = require('axios');
const { sendEmail } = require('../../../shared/utils/email.util');

const SOCKET_URL       = `http://localhost:${process.env.PORT_SOCKET       || 3010}`;
const NOTIFICATION_URL = `http://localhost:${process.env.PORT_NOTIFICATION || 3008}`;
const ADMIN_EMAIL      = process.env.ADMIN_EMAIL || 'admin@zipbasket.in';

// Roles that can raise/see their own support queries (admins use the admin routes).
const SUPPORT_ROLES = [ROLES.CUSTOMER, ROLES.RIDER, ROLES.VENDOR];

// Resolve the requester's display name + email from whichever role model applies.
const getRequesterProfile = async (role, id) => {
  if (role === ROLES.RIDER) {
    const r = await Rider.findById(id).select('name email').lean();
    return { name: r?.name ?? 'Rider', email: r?.email ?? null };
  }
  if (role === ROLES.VENDOR) {
    const v = await Vendor.findById(id).select('businessName ownerName email').lean();
    return { name: v?.businessName || v?.ownerName || 'Vendor', email: v?.email ?? null };
  }
  const c = await Customer.findById(id).select('name email').lean();
  return { name: c?.name ?? 'Customer', email: c?.email ?? null };
};

// ── POST /queries — customer submits a query ────────────────────
const submitQuery = async (req, res) => {
  try {
    if (!SUPPORT_ROLES.includes(req.user.role)) {
      return sendError(res, 403, 'Only app users can submit queries', ERROR_CODES.FORBIDDEN);
    }
    const parsed = z.object({ message: z.string().min(5).max(2000) }).safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }
    const profile = await getRequesterProfile(req.user.role, req.user.id);
    const query = await SupportQuery.create({
      customerId: req.user.id,
      customerName: profile.name,
      customerEmail: profile.email,
      userRole: req.user.role,
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
      subject: `New Support Query from ${profile.name} (${req.user.role})`,
      html:    `<p><strong>${profile.name}</strong> (${req.user.role}) submitted a support query:</p>
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
    if (!SUPPORT_ROLES.includes(req.user.role)) {
      return sendError(res, 403, 'Only app users can view queries', ERROR_CODES.FORBIDDEN);
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
    if (!SUPPORT_ROLES.includes(req.user.role)) {
      return sendError(res, 403, 'Only app users can reply', ERROR_CODES.FORBIDDEN);
    }
    const parsed = z.object({ text: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }
    const query = await SupportQuery.findOne({ _id: req.params.id, customerId: req.user.id });
    if (!query) return sendError(res, 404, 'Query not found', ERROR_CODES.NOT_FOUND);

    query.replies.push({ from: req.user.role, text: parsed.data.text });
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
    // Route to the requester's actual role room / FCM role (customer | rider | vendor).
    const role = query.userRole || 'customer';

    // Emit real-time reply to the requester via socket
    try {
      await axios.post(`${SOCKET_URL}/internal/emit`, {
        room:    `${role}:${query.customerId}`,
        event:   'support:reply',
        payload: { queryId: query._id, reply: savedReply },
      }, { timeout: 3000 });
    } catch (socketErr) {
      logger.warn('Failed to emit support:reply socket event:', socketErr.message);
    }

    // Send FCM push notification to the requester
    try {
      const preview = parsed.data.text.length > 60
        ? parsed.data.text.slice(0, 60) + '…'
        : parsed.data.text;
      await axios.post(`${NOTIFICATION_URL}/internal/notify`, {
        type:     'support:reply',
        userId:   query.customerId.toString(),
        userRole: role,
        data:     { preview },
      }, { timeout: 3000 });
    } catch (notifErr) {
      logger.warn('Failed to send support:reply push notification:', notifErr.message);
    }

    // Send email to customer (if email is available)
    if (query.customerEmail) {
      sendEmail({
        to:      query.customerEmail,
        subject: 'ZipBasket Support — Reply to your query',
        html:    `<p>Hi ${query.customerName},</p>
                  <p>Our support team has replied to your query:</p>
                  <blockquote style="border-left:3px solid #10d876;padding:8px 12px;margin:12px 0;background:#f8f9fa;">
                    ${parsed.data.text}
                  </blockquote>
                  <p style="color:#888;font-size:12px;">Original query: "${query.message.slice(0, 100)}${query.message.length > 100 ? '…' : ''}"</p>
                  <p>Open the ZipBasket app to continue the conversation.</p>`,
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
    const parsed = z.object({ status: z.enum(['open', 'closed']) }).safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }
    const query = await SupportQuery.findById(req.params.id);
    if (!query) return sendError(res, 404, 'Query not found', ERROR_CODES.NOT_FOUND);

    // Admin can change any query; a requester can close/reopen their OWN query.
    const isAdmin = req.user.role === ROLES.ADMIN;
    const isOwner = query.customerId.toString() === req.user.id;
    if (!isAdmin && !isOwner) {
      return sendError(res, 403, 'Not allowed', ERROR_CODES.FORBIDDEN);
    }

    query.status = parsed.data.status;
    await query.save();
    return sendSuccess(res, 200, 'Query status updated', query);
  } catch (err) {
    logger.error('updateQueryStatus error:', err);
    return sendError(res, 500, 'Failed to update status', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = { submitQuery, getMyQueries, customerReply, adminReply, getAllQueries, updateQueryStatus };
