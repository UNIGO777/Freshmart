/**
 * Google Play reviewer test account.
 *
 * Creates/updates ONE phone number (9999999999) as a Customer, Vendor AND Rider all
 * at once — matching how role-switching already works in the app (same phone number
 * across the three collections). The reviewer logs in once and can exercise every
 * side of the marketplace: browse & order as customer, accept & fulfil as vendor,
 * pick up & deliver as rider.
 *
 * Login: phone 9999999999, OTP 000000 (fixed — see otp.controller.js PLAY_TEST_PHONE).
 * That bypass ONLY works when NODE_ENV !== 'production', so this account is only
 * usable against a review/staging backend deliberately run outside production mode.
 *
 *   node scripts/seed-play-test-account.js
 *
 * Idempotent — safe to re-run any time (e.g. after wiping test data).
 */
require('dotenv').config();
const mongoose = require('mongoose');

const Customer = require('../services/user/models/Customer.model');
const Vendor   = require('../services/user/models/Vendor.model');
const Rider    = require('../services/user/models/Rider.model');
const Product  = require('../services/product/models/Product.model');
const Category = require('../services/product/models/Category.model');
const Inventory = require('../services/vendor/models/Inventory.model');

const PHONE = '9999999999';
const NAME  = 'Play Store Tester';

// Connaught Place, New Delhi — a well-known, easily-searchable landmark so the
// reviewer can manually set their location to this area (Select Location screen's
// search) even if their device/emulator is physically outside India.
const TEST_LAT = 28.6315;
const TEST_LNG = 77.2167;
const TEST_ADDRESS = 'Connaught Place, New Delhi, Delhi, India';

const ALL_CATEGORIES = ['fruits', 'vegetables', 'spices', 'dairy', 'bakery', 'other'];

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB.\n');

  // ── Customer ──────────────────────────────────────────────────────
  let customer = await Customer.findOne({ phone: PHONE });
  if (!customer) {
    customer = new Customer({
      name: NAME,
      phone: PHONE,
      authProviders: ['phone'],
      isActive: true,
      addresses: [{
        label: 'Home',
        lat: TEST_LAT,
        lng: TEST_LNG,
        fullAddress: TEST_ADDRESS,
        city: 'New Delhi',
        state: 'Delhi',
      }],
    });
    await customer.save();
    console.log(`✅ Customer created: ${customer._id}`);
  } else {
    customer.isActive = true;
    if (!customer.authProviders.includes('phone')) customer.authProviders.push('phone');
    if (customer.addresses.length === 0) {
      customer.addresses.push({
        label: 'Home', lat: TEST_LAT, lng: TEST_LNG, fullAddress: TEST_ADDRESS,
        city: 'New Delhi', state: 'Delhi',
      });
    }
    await customer.save();
    console.log(`✅ Customer already existed, refreshed: ${customer._id}`);
  }

  // ── Vendor (same phone — enables the in-app "isAlsoVendor" switch) ──
  let vendor = await Vendor.findOne({ phone: PHONE });
  if (!vendor) {
    vendor = new Vendor({
      businessName: 'Khetan Mart Test Store',
      ownerName: NAME,
      phone: PHONE,
      location: { type: 'Point', coordinates: [TEST_LNG, TEST_LAT] },
      address: TEST_ADDRESS,
      serviceRadiusKm: 20000, // global — demo/test store is serviceable from ANY location
      categories: ALL_CATEGORIES,
      isApproved: true,
      isActive: true,
      isOnline: true, // pre-online so the reviewer can order without an extra step
    });
    await vendor.save();
    console.log(`✅ Vendor created: ${vendor._id}`);
  } else {
    vendor.categories = ALL_CATEGORIES;
    vendor.isApproved = true;
    vendor.isActive = true;
    vendor.isOnline = true;
    vendor.serviceRadiusKm = 20000; // global — serviceable from ANY location
    await vendor.save();
    console.log(`✅ Vendor already existed, refreshed: ${vendor._id}`);
  }

  // ── Rider (same phone — enables the in-app "isAlsoRider" switch) ────
  let rider = await Rider.findOne({ phone: PHONE });
  if (!rider) {
    rider = new Rider({
      name: NAME,
      phone: PHONE,
      currentLocation: { type: 'Point', coordinates: [TEST_LNG, TEST_LAT] },
      isApproved: true,
      isActive: true,
      isOnline: true, // pre-online so the reviewer can immediately test job offers
    });
    await rider.save();
    console.log(`✅ Rider created: ${rider._id}`);
  } else {
    rider.isApproved = true;
    rider.isActive = true;
    rider.isOnline = true;
    await rider.save();
    console.log(`✅ Rider already existed, refreshed: ${rider._id}`);
  }

  // ── Categories: make sure all are active (visible in the storefront) ──
  const catResult = await Category.updateMany({}, { $set: { isActive: true } });
  console.log(`✅ Categories set active: ${catResult.modifiedCount} updated`);

  // ── Products: make every product available today, everywhere ──────
  const prodResult = await Product.updateMany(
    {},
    { $set: { active: true, isAvailableToday: true } },
  );
  console.log(`✅ Products set available: ${prodResult.modifiedCount} updated`);

  // ── Inventory: give the test vendor a stocked, available row for EVERY
  //    product so their storefront is never empty for the reviewer ──────
  const allProducts = await Product.find({}).select('_id').lean();
  let inventoryUpserts = 0;
  for (const p of allProducts) {
    await Inventory.findOneAndUpdate(
      { vendorId: vendor._id, productId: p._id },
      { $set: { isAvailable: true, quantityAvailable: 999 } },
      { upsert: true },
    );
    inventoryUpserts += 1;
  }
  console.log(`✅ Inventory upserted for ${inventoryUpserts} product(s)`);

  console.log('\n' + '='.repeat(60));
  console.log('  Google Play reviewer test account is ready');
  console.log('='.repeat(60));
  console.log(`  Phone: ${PHONE}`);
  console.log(`  OTP:   000000  (fixed — works only when NODE_ENV !== 'production')`);
  console.log(`  Test location: ${TEST_ADDRESS} (${TEST_LAT}, ${TEST_LNG})`);
  console.log('  This one account is customer + vendor + rider all at once.');
  console.log('='.repeat(60) + '\n');

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => {
  console.error('❌ Seed failed:', e);
  process.exit(1);
});
