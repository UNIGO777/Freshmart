const axios = require('axios');
const PanelNotification = require('../models/PanelNotification.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

const SOCKET_URL = `http://localhost:${process.env.PORT_SOCKET || 3010}`;

// ── Internal: create + emit (called by notifyAdmin utility) ──────
const createNotification = async (req, res) => {
  const { panel = 'admin', type, title, body, data = {} } = req.body;
  if (!type || !title || !body) {
    return res.status(400).json({ success: false, message: 'type, title, body required' });
  }
  try {
    const category = PanelNotification.categoryFor(type);
    const notif = await PanelNotification.create({ panel, type, category, title, body, data });

    // Emit to socket room — e.g. "admin:panel"
    axios
      .post(`${SOCKET_URL}/internal/emit`, {
        room:    `${panel}:panel`,
        event:   'panel:notification',
        payload: notif.toObject(),
      })
      .catch((err) => logger.warn(`Socket emit failed: ${err.message}`));

    return res.status(201).json({ success: true, data: notif });
  } catch (err) {
    logger.error('createNotification error:', err);
    return res.status(500).json({ success: false, message: 'Failed to create notification' });
  }
};

// ── GET /notifications?panel=admin&category=orders&unread=true&page=1&limit=30 ──
const listNotifications = async (req, res) => {
  try {
    const panel    = req.query.panel    || 'admin';
    const page     = Math.max(1, parseInt(req.query.page)  || 1);
    const limit    = Math.min(100, parseInt(req.query.limit) || 30);
    const skip     = (page - 1) * limit;

    const filter = { panel };
    if (req.query.category) filter.category = req.query.category;
    if (req.query.unread === 'true') filter.isRead = false;

    const [data, total, unreadCount] = await Promise.all([
      PanelNotification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      PanelNotification.countDocuments(filter),
      PanelNotification.countDocuments({ panel, isRead: false }),
    ]);

    return sendSuccess(res, { data, total, unreadCount, page, limit });
  } catch (err) {
    logger.error('listNotifications error:', err);
    return sendError(res, 500, 'Failed to fetch notifications', ERROR_CODES.SERVER_ERROR);
  }
};

// ── PATCH /notifications/:id/read ────────────────────────────────
const markOneRead = async (req, res) => {
  try {
    const notif = await PanelNotification.findByIdAndUpdate(
      req.params.id,
      { isRead: true },
      { new: true },
    );
    if (!notif) return sendError(res, 404, 'Notification not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, notif);
  } catch (err) {
    logger.error('markOneRead error:', err);
    return sendError(res, 500, 'Failed to mark notification', ERROR_CODES.SERVER_ERROR);
  }
};

// ── PATCH /notifications/read-all ────────────────────────────────
const markAllRead = async (req, res) => {
  try {
    const panel = req.query.panel || 'admin';
    await PanelNotification.updateMany({ panel, isRead: false }, { isRead: true });
    return sendSuccess(res, { ok: true });
  } catch (err) {
    logger.error('markAllRead error:', err);
    return sendError(res, 500, 'Failed to mark all', ERROR_CODES.SERVER_ERROR);
  }
};

// ── DELETE /notifications/:id ─────────────────────────────────────
const deleteNotification = async (req, res) => {
  try {
    const notif = await PanelNotification.findByIdAndDelete(req.params.id);
    if (!notif) return sendError(res, 404, 'Notification not found', ERROR_CODES.NOT_FOUND);
    return sendSuccess(res, { deleted: true });
  } catch (err) {
    logger.error('deleteNotification error:', err);
    return sendError(res, 500, 'Failed to delete notification', ERROR_CODES.SERVER_ERROR);
  }
};

module.exports = { createNotification, listNotifications, markOneRead, markAllRead, deleteNotification };
