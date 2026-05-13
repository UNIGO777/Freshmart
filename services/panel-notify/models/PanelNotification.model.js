const mongoose = require('mongoose');

const CATEGORIES = ['orders', 'riders', 'customers', 'payouts', 'system'];

const TYPE_TO_CATEGORY = {
  new_order:       'orders',
  order_delivered: 'orders',
  order_failed:    'orders',
  order_cancelled: 'orders',
  rider_online:    'riders',
  rider_offline:   'riders',
  new_customer:    'customers',
  payout_approved: 'payouts',
  system:          'system',
};

const panelNotificationSchema = new mongoose.Schema(
  {
    panel: {
      type: String,
      default: 'admin',
      index: true,
    },

    type: {
      type: String,
      required: true,
    },

    category: {
      type: String,
      enum: CATEGORIES,
      required: true,
    },

    title: { type: String, required: true, trim: true },
    body:  { type: String, required: true, trim: true },

    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  { timestamps: true },
);

panelNotificationSchema.index({ panel: 1, createdAt: -1 });
panelNotificationSchema.index({ panel: 1, isRead: 1 });

panelNotificationSchema.statics.categoryFor = (type) =>
  TYPE_TO_CATEGORY[type] ?? 'system';

module.exports = mongoose.model('PanelNotification', panelNotificationSchema);
