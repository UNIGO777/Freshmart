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

/**
 * Send a push notification to a single FCM registration token.
 *
 * @param {string} token  FCM device token stored on the user document
 * @param {{ title: string, body: string, data?: Object }} notification
 * @returns {Promise<string|null>}  FCM message ID, or null on failure
 */
const sendToToken = async (token, { title, body, data = {} }) => {
  if (!token) return null;

  const message = {
    token,
    notification: { title, body },
    // data values must all be strings for FCM data payload
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)]),
    ),
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
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
const sendToMultipleTokens = async (tokens, { title, body, data = {} }) => {
  if (!tokens.length) return { successCount: 0, failureCount: 0 };

  const message = {
    tokens,
    notification: { title, body },
    data: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, String(v)]),
    ),
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default' } } },
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
