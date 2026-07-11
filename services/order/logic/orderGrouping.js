/**
 * orderGrouping.js  — Multi-vendor category split (M0)
 *
 * The DIVIDE + the per-group atomic LOCK.
 *
 *  - `splitByCategory(items)` turns one order's items into independent
 *    category-groups (veg-group, fruit-group, …). Each group routes to its
 *    category's vendors on its own and becomes its own sub-order.
 *
 *  - `claimGroup(...)` is the per-group atomic lock: a vendor claims the WHOLE
 *    group all-or-nothing. Two vendors racing the same group → exactly one wins,
 *    via a single `findOneAndUpdate` whose `$elemMatch` requires the group to
 *    still be open. This is the per-group analogue of the whole-order guard.
 *
 * NOTE: this module does NOT touch the FCM siren / popup / "Order from <name>"
 * layer — those are done and reused as-is.
 */
const mongoose = require('mongoose');
const { SUB_ORDER_STATUS } = require('../../../shared/constants/orderStatus');

/**
 * Divide an order's items into per-category groups.
 *
 * @param {Array<{ productId, quantity, sellingPrice, buyingPrice, name, category }>} items
 * @returns {Array<{ groupKey, category, items, productIds }>}
 *   One entry per distinct category. Order is stable (first-seen category first).
 */
const splitByCategory = (items) => {
  const byCat = new Map();
  for (const it of items) {
    const key = (it.category || 'uncategorized').toString();
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(it);
  }
  return [...byCat.entries()].map(([category, groupItems]) => ({
    groupKey: category,
    category,
    items: groupItems,
    productIds: groupItems.map((i) => i.productId),
  }));
};

/**
 * Build the sub-order document for one group won by one vendor.
 * (One group → one vendor → one sub-order → one OTP → one rider.)
 *
 * @param {{ items }} group
 * @param {string|ObjectId} vendorId
 * @param {{ pickupLocation?, dropLocation? }} locations
 */
const buildGroupSubOrder = (group, vendorId, { pickupLocation, dropLocation } = {}) => ({
  vendorId: new mongoose.Types.ObjectId(vendorId),
  items: group.items.map((it) => ({
    productId: it.productId,
    quantity: it.quantity,
    sellingPrice: it.sellingPrice,
    buyingPrice: it.buyingPrice,
    name: it.name,
  })),
  status: SUB_ORDER_STATUS.VENDOR_ACCEPTED,
  pickupLocation,
  dropLocation,
  vendorAcceptedAt: new Date(),
});

/**
 * Atomically claim ONE group for ONE vendor.
 *
 * The `$elemMatch` matches the group ONLY while it is still open
 * (`status:'open'`, `claimedByVendorId:null`) AND this vendor was offered it.
 * The positional `$` writes exactly that group; `$push` appends its sub-order —
 * both in a single atomic document update. Concurrent claims on the same group:
 * the first flips it to 'claimed', the second no longer matches and gets `null`.
 *
 * @param {mongoose.Model} Model   the Order model (injected for testability)
 * @param {string|ObjectId} orderId
 * @param {{ groupKey, items }} group
 * @param {string|ObjectId} vendorId
 * @param {{ pickupLocation?, dropLocation? }} [locations]
 * @returns {Promise<Object|null>}  the updated order if won; `null` if lost/not-offered/closed
 */
const claimGroup = async (Model, orderId, group, vendorId, locations = {}) => {
  const vObj = new mongoose.Types.ObjectId(vendorId);
  const subOrder = buildGroupSubOrder(group, vObj, locations);

  return Model.findOneAndUpdate(
    {
      _id: orderId,
      'routingMeta.groups': {
        $elemMatch: { groupKey: group.groupKey, status: 'open', claimedByVendorId: null, offeredVendorIds: vObj },
      },
    },
    {
      $set: {
        'routingMeta.groups.$.claimedByVendorId': vObj,
        'routingMeta.groups.$.status': 'claimed',
      },
      $push: { subOrders: subOrder },
    },
    { new: true },
  );
};

module.exports = { splitByCategory, buildGroupSubOrder, claimGroup };
