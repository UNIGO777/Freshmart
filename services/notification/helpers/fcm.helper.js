require('dotenv').config();
const admin = require('firebase-admin');
const logger = require('../../../shared/utils/logger');

// ── Firebase Admin SDK initialisation ────────────────────────────
// Guard against re-initialisation in dev (hot-reload / module cache)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const messaging = admin.messaging();

// ── Sound + channel mapping per notification type ──────────────────
const SOUND_MAP = {
  'order:incoming':     { sound: 'order_incoming.wav', channel: 'vendor-orders' },
  'order:rerouted':     { sound: 'order_incoming.wav', channel: 'vendor-orders' },
  'job:request':        { sound: 'rider_job.wav',      channel: 'rider-jobs' },
  'order:confirmed':    { sound: 'order_update.wav',   channel: 'order-updates' },
  'rider:assigned':     { sound: 'order_update.wav',   channel: 'order-updates' },
  'order:picked':       { sound: 'order_update.wav',   channel: 'order-updates' },
  'order:delivered':    { sound: 'order_update.wav',   channel: 'order-updates' },
  'order:cancelled':    { sound: 'order_update.wav',   channel: 'order-updates' },
  'order:picked-vendor':{ sound: 'order_update.wav',   channel: 'order-updates' },
  'order:pickup-otp':   { sound: 'otp_received.wav',   channel: 'otp-alerts' },
  'order:delivery-otp': { sound: 'otp_received.wav',   channel: 'otp-alerts' },
  'order:return-otp':   { sound: 'otp_received.wav',   channel: 'otp-alerts' },
};

/**
 * Send a push notification to a single FCM registration token.
 *
 * @param {string} token  FCM device token stored on the user document
 * @param {{ title: string, body: string, data?: Object, type?: string }} notification
 * @returns {Promise<string|null>}  FCM message ID, or null on failure
 */
const sendToToken = async (token, { title, body, data = {}, type = '' }) => {
  if (!token) return null;

  const soundConfig = SOUND_MAP[type] || { sound: 'default', channel: 'default' };

  const message = {
    token,
    notification: { title, body },
    // data values must all be strings for FCM data payload
    data: Object.fromEntries(
      Object.entries({ ...data, type }).map(([k, v]) => [k, String(v)]),
    ),
    android: {
      priority: 'high',
      notification: {
        sound: soundConfig.sound,
        channelId: soundConfig.channel,
        priority: 'max',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: soundConfig.sound,
          'content-available': 1,
        },
      },
    },
  };

  try {
    const messageId = await messaging.send(message);
    logger.debug(`FCM sent to token …${token.slice(-8)} — messageId: ${messageId}`);
    return messageId;
  } catch (err) {
    // Common codes: messaging/registration-token-not-registered (stale token)
    logger.warn(`FCM sendToToken failed: ${err.code ?? err.message}`);
    return null;
  }
};

/**
 * Send the same notification to multiple FCM tokens (multicast).
 * FCM allows up to 500 tokens per call — callers must chunk if needed.
 *
 * @param {string[]} tokens
 * @param {{ title: string, body: string, data?: Object }} notification
 * @returns {Promise<{ successCount: number, failureCount: number }>}
 */
const sendToMultipleTokens = async (tokens, { title, body, data = {}, type = '' }) => {
  if (!tokens.length) return { successCount: 0, failureCount: 0 };

  const soundConfig = SOUND_MAP[type] || { sound: 'default', channel: 'default' };
  const message = {
    tokens,
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)]),
    ),
    android: {
      priority: 'high',
      notification: {
        sound: soundConfig.sound,
        channelId: soundConfig.channel,
      },
    },
    apns: { payload: { aps: { sound: soundConfig.sound, 'content-available': 1 } } },
  };

  try {
    const response = await messaging.sendEachForMulticast(message);
    logger.info(`FCM multicast: ${response.successCount} sent, ${response.failureCount} failed`);
    return { successCount: response.successCount, failureCount: response.failureCount };
  } catch (err) {
    logger.error(`FCM multicast failed: ${err.message}`);
    return { successCount: 0, failureCount: tokens.length };
  }
};

module.exports = { sendToToken, sendToMultipleTokens };
