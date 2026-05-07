/**
 * orderSplitter.js
 *
 * Converts vendor acceptance responses into sub-orders.
 *
 * A vendor "accepts" by specifying which items (and quantities) they can fulfil.
 * This module:
 *  - Tracks which items are already covered by prior acceptances.
 *  - Merges a new vendor's accepted items into the running coverage.
 *  - Determines whether all ordered items are now fully covered.
 *  - Builds the final list of sub-orders when coverage is complete.
 */

/**
 * Apply a vendor's acceptance to the current coverage state.
 *
 * @param {Object} coverageState  Running coverage — mutated in place.
 *   Shape: { [productId]: { needed: number, assigned: number, vendorAllocations: [{vendorId, qty}] } }
 * @param {string} vendorId
 * @param {Array<{ productId: string, quantity: number }>} acceptedItems
 *   Items the vendor confirmed they can supply (quantity ≤ needed).
 * @returns {{ allCovered: boolean, coverageState: Object }}
 */
const applyVendorAcceptance = (coverageState, vendorId, acceptedItems) => {
  for (const { productId, quantity } of acceptedItems) {
    const pid = productId.toString();
    if (!coverageState[pid]) continue;

    const slot = coverageState[pid];
    const remaining = slot.needed - slot.assigned;
    const taking = Math.min(quantity, remaining);

    if (taking > 0) {
      slot.assigned += taking;
      slot.vendorAllocations.push({ vendorId, qty: taking });
    }
  }

  const allCovered = Object.values(coverageState).every((s) => s.assigned >= s.needed);
  return { allCovered, coverageState };
};

/**
 * Initialise a fresh coverage state from order items.
 *
 * @param {Array<{ productId, quantity, sellingPrice, buyingPrice, category }>} items
 * @returns {Object} coverageState
 */
const initCoverageState = (items) => {
  const state = {};
  for (const item of items) {
    const pid = item.productId.toString();
    state[pid] = {
      needed: item.quantity,
      assigned: 0,
      sellingPrice: item.sellingPrice,
      buyingPrice: item.buyingPrice,
      category: item.category,
      vendorAllocations: [],
    };
  }
  return state;
};

/**
 * Build sub-order objects from a completed coverage state.
 * Groups allocations by vendorId.
 *
 * @param {Object} coverageState
 * @param {{ lat, lng, fullAddress }} dropLocation  Customer delivery address.
 * @returns {Array<{
 *   vendorId: string,
 *   items: Array<{ productId, quantity, buyingPrice, sellingPrice }>,
 *   dropLocation,
 *   status: 'pending',
 * }>}
 */
const buildSubOrders = (coverageState, dropLocation) => {
  const vendorItemsMap = {};

  for (const [productId, slot] of Object.entries(coverageState)) {
    for (const { vendorId, qty } of slot.vendorAllocations) {
      const vid = vendorId.toString();
      if (!vendorItemsMap[vid]) vendorItemsMap[vid] = [];
      vendorItemsMap[vid].push({
        productId,
        quantity: qty,
        buyingPrice: slot.buyingPrice,
        sellingPrice: slot.sellingPrice,
      });
    }
  }

  return Object.entries(vendorItemsMap).map(([vendorId, items]) => ({
    vendorId,
    items,
    dropLocation,
    status: 'vendor_accepted',
  }));
};

/**
 * List product IDs that are still not fully covered.
 *
 * @param {Object} coverageState
 * @returns {string[]} uncovered productIds
 */
const getUncoveredItems = (coverageState) =>
  Object.entries(coverageState)
    .filter(([, s]) => s.assigned < s.needed)
    .map(([pid]) => pid);

module.exports = { initCoverageState, applyVendorAcceptance, buildSubOrders, getUncoveredItems };
