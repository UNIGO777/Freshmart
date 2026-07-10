/**
 * Milestone-2 verification harness: place a REAL customer order that routes to the
 * vendor currently logged in on the test device, so accept/reject hit real 2xx
 * paths (not the 404 a fake order gives).
 *
 * Requires: that vendor logged in + ONLINE on the device (has fcmToken), with
 * inventory for at least one active product. Mints a customer token from JWT_SECRET.
 *
 *   node scripts/place-real-order.js
 */
require('dotenv').config({ quiet: true });
const mongoose = require('mongoose');
const { signAccessToken } = require('../shared/utils/jwt.util');

const GATEWAY = process.env.GATEWAY_URL || `http://localhost:${process.env.PORT_GATEWAY || 4000}`;

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  // 1. The device vendor. Force it online + set the device token, because the
  //    socket auto-offlines it whenever the phone locks (the ONLINE-mode foreground
  //    service that keeps a real vendor online is a later milestone). VENDOR_ID +
  //    TEST_FCM_TOKEN from env.
  const VENDOR_ID = process.env.M2_VENDOR_ID || '6a2559a376e12c06b58540f3';
  // Force ONLINE only — keep the app's own self-registered fcmToken (do NOT overwrite
  // with a manual token; the app now registers a real, valid token on boot).
  await db.collection('vendors').updateOne(
    { _id: new mongoose.Types.ObjectId(VENDOR_ID) },
    { $set: { isOnline: true } },
  );
  const vendor = await db.collection('vendors').findOne({ _id: new mongoose.Types.ObjectId(VENDOR_ID) });
  if (!vendor) throw new Error(`Vendor ${VENDOR_ID} not found.`);
  const [vLng, vLat] = vendor.location?.coordinates || [];
  if (vLat == null) throw new Error('Vendor has no location set.');
  console.log(`vendor: ${vendor.businessName || vendor._id}  online=${vendor.isOnline} approved=${vendor.isApproved} active=${vendor.isActive} loc=[${vLat},${vLng}]`);

  // 2. A product this vendor stocks (isAvailable) that is also orderable today.
  const invRows = await db.collection('inventories')
    .find({ vendorId: vendor._id, isAvailable: true }).project({ productId: 1 }).toArray();
  const invIds = invRows.map((r) => r.productId);
  if (invIds.length === 0) throw new Error('Vendor has no available inventory — mark a product available in the Inventory tab.');
  const product = await db.collection('products').findOne({ _id: { $in: invIds }, active: true, isAvailableToday: true });
  if (!product) throw new Error('Vendor stock exists but none is an active, available-today product.');
  console.log(`product: ${product.name} (${product._id})  category=${product.category} sellingPrice=${product.sellingPrice}`);

  // 3. Mint a customer token.
  const customer = await db.collection('customers').findOne({});
  if (!customer) throw new Error('No customer to place the order as.');
  const token = signAccessToken({ id: customer._id.toString(), role: 'customer' });
  console.log(`placing as customer: ${customer._id}`);

  // 4. Place the order AT the vendor's location so this vendor is the closest match.
  const body = {
    items: [{ productId: product._id.toString(), quantity: 1 }],
    deliveryAddress: { lat: vLat, lng: vLng, fullAddress: 'M2 test — at vendor location', label: 'Test' },
    paymentMethod: 'cod',
  };
  const res = await fetch(`${GATEWAY}/api/orders/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  console.log(`\nPOST /api/orders -> ${res.status}`);
  const orderId = json?.data?.orderId || json?.data?._id || json?.orderId;
  if (res.ok) console.log(`✅ ORDER PLACED. orderId=${orderId}\n   (routed to vendor -> data-only NEW_ORDER push should hit the device)`);
  else console.log('❌ order failed:', JSON.stringify(json));

  await mongoose.disconnect();
  process.exit(res.ok ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
