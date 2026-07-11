require('dotenv').config({ quiet: true });
const admin = require('firebase-admin');
const logger = require('./logger');

// Guard against re-init across hot-reload / shared module cache (one per process).
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

/**
 * Send a DATA-ONLY, high-priority FCM push.
 *
 * CRITICAL: no `notification` block — with one present, the OS tray handler
 * consumes the message and the app's setBackgroundMessageHandler never runs on a
 * killed app. `priority: high` buys the Doze bypass + the window to start a
 * foreground service from the background. `ttl` drops stale offers.
 *
 * @param {string} token   FCM registration token
 * @param {Object} data    string-coerced data payload (must include `type`)
 * @param {{ ttlSec?: number }} [opts]
 * @returns {Promise<string|null>} message id, or null on failure
 */
const fs = require('fs'); // TEMP instrumentation
const sendDataOnly = async (token, data, { ttlSec = 60 } = {}) => {
  if (!token) { try { fs.appendFileSync('/tmp/fcm-send.log', `${Date.now()} NOTOKEN ${data.type} ${data.orderId||''}\n`); } catch {} return null; } // TEMP
  try {
    const id = await admin.messaging().send({
      token,
      data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
      android: { priority: 'high', ttl: ttlSec * 1000 },
    });
    try { fs.appendFileSync('/tmp/fcm-send.log', `${Date.now()} OK ${data.type} ${data.orderId||''} tok=${(token||'').slice(0,8)} id=${(id||'').slice(-10)}\n`); } catch {} // TEMP
    return id;
  } catch (err) {
    // e.g. messaging/registration-token-not-registered (stale token)
    logger.warn(`sendDataOnly failed: ${err.code ?? err.message}`);
    try { fs.appendFileSync('/tmp/fcm-send.log', `${Date.now()} ERR ${data.type} ${data.orderId||''} tok=${(token||'').slice(0,8)} ${err.errorInfo?.code ?? err.code ?? err.message}\n`); } catch {} // TEMP
    return null;
  }
};

module.exports = { sendDataOnly };
