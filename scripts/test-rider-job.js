/**
 * Rider phone-off siren test: send a DATA-ONLY NEW_JOB push straight to a rider's
 * registered FCM token via the production helper (shared/utils/dataPush) — exercises
 * the real setBackgroundMessageHandler → OrderSiren path on a killed/closed app.
 *
 *   node scripts/test-rider-job.js [phone] [ringSeconds]
 *   node scripts/test-rider-job.js 7000610047 60
 *
 * The rider must have opened the app while logged in at least once (so it registered
 * a token). A fake jobId is fine here — we're testing the SIREN, not accept/reject.
 */
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { sendDataOnly } = require('../shared/utils/dataPush');

const PHONE = process.argv[2] || '7000610047';
const RING_SEC = Number(process.argv[3]) || 60;

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  const digits = PHONE.replace(/\D/g, '').slice(-10);
  const rider = await db.collection('riders').findOne({ phone: { $regex: digits + '$' } });
  if (!rider) { console.error(`❌ Rider not found for phone ${PHONE} (…${digits})`); process.exit(1); }

  console.log(`rider   : ${rider.name || rider._id}  phone=${rider.phone}`);
  console.log(`state   : isOnline=${rider.isOnline}  isApproved=${rider.isApproved}  isActive=${rider.isActive}`);
  console.log(`fcmToken: ${rider.fcmToken ? rider.fcmToken.slice(0, 14) + '…' : 'NONE'}`);
  if (!rider.fcmToken) {
    console.error('❌ Rider has no fcmToken — open the rider app once (logged in) so it registers, then retry.');
    process.exit(1);
  }

  const now = Date.now();
  const data = {
    type: 'NEW_JOB',
    jobId: `test-${now.toString().slice(-6)}`,
    orderId: `testord-${now.toString().slice(-6)}`,
    expiresAt: now + RING_SEC * 1000,
    earnings: 45,
    distance: '2.3',
    pickup: 'FreshMart Store, Sector 18',
    drop: 'Customer, Sector 22',
  };

  const id = await sendDataOnly(rider.fcmToken, data, { ttlSec: RING_SEC });
  if (id) {
    console.log('\n✅ NEW_JOB push sent:', id);
    console.log('   payload:', JSON.stringify(data));
    console.log(`   → the rider phone should ring the siren + show the job popup for ~${RING_SEC}s.`);
  } else {
    console.error('\n❌ send returned null — stale/invalid token. Have the rider re-open the app to refresh it, then retry.');
  }
  await mongoose.disconnect();
  process.exit(id ? 0 : 1);
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
