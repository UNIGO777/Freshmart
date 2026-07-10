/**
 * Milestone-1 transport check: send a DATA-ONLY NEW_ORDER push to TEST_FCM_TOKEN
 * via the SAME production helper (shared/utils/dataPush). No notification block, so
 * it exercises the real setBackgroundMessageHandler path on a killed app.
 *
 *   node scripts/test-data-push.js [NEW_ORDER|ORDER_CANCELLED|PING] [ringSeconds]
 */
require('dotenv').config({ quiet: true });
const { sendDataOnly } = require('../shared/utils/dataPush');

const TOKEN = process.env.TEST_FCM_TOKEN;
const TYPE = process.argv[2] || 'NEW_ORDER';
const RING_SEC = Number(process.argv[3]) || 60;

if (!TOKEN) {
  console.error('Set TEST_FCM_TOKEN in .env first');
  process.exit(1);
}

const orderId = `test-${Date.now().toString().slice(-6)}`;
const data =
  TYPE === 'NEW_ORDER'
    ? { type: 'NEW_ORDER', orderId, expiresAt: Date.now() + RING_SEC * 1000 }
    : TYPE === 'ORDER_CANCELLED'
      ? { type: 'ORDER_CANCELLED', orderId: process.argv[3] || orderId }
      : { type: 'PING', pingId: orderId };

sendDataOnly(TOKEN, data, { ttlSec: RING_SEC })
  .then((id) => {
    if (id) console.log(`✅ data-only ${TYPE} sent:`, id, '\n   payload:', JSON.stringify(data));
    else console.error('❌ send returned null (stale token? check logs)');
    process.exit(id ? 0 : 1);
  })
  .catch((e) => { console.error('❌', e.message); process.exit(1); });
