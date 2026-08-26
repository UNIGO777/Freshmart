import admin from 'firebase-admin';
import 'dotenv/config';

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});

const TOKEN = process.env.TEST_FCM_TOKEN;
const TYPE = process.argv[2] || 'order_update';

if (!TOKEN) {
  console.error('Set TEST_FCM_TOKEN in .env first');
  process.exit(1);
}

admin.messaging().send({
  token: TOKEN,
  android: { priority: 'high' },
  // notification block is ONLY here so something is visible to tap.
  // Production orderPush.js must never include it.
  notification: { title: 'Khetan Mart', body: `Tap to test: ${TYPE}` },
  data: { type: TYPE, orderId: 'test123' },
})
  .then(id => console.log('✅ sent:', id))
  .catch(e => console.error('❌', e.code, '—', e.message));