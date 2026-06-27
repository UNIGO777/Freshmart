const Rider = require('../../user/models/Rider.model');

const BATCH_SIZE = 3;
const SEARCH_RADIUS_KM = 5; // Max km radius to search for available riders

/**
 * Find up to `limit` nearest online, unoccupied, approved riders to a location.
 * Excludes riders whose IDs are in `excludeIds` (already offered / rejected for this job).
 *
 * Uses Rider.currentLocation (2dsphere index) for the geo query — updated on
 * every location ping from the rider app.
 *
 * @param {{ lat: number, lng: number }} location  Vendor pickup location
 * @param {string[]}  excludeIds  Rider IDs already in offeredRiderIds | rejectedRiderIds
 * @param {number}   [limit]     How many riders to return (default BATCH_SIZE = 3)
 * @returns {Promise<Array>}     Rider lean docs, sorted nearest-first
 */
const findNearbyRiders = async (location, excludeIds = [], limit = BATCH_SIZE) => {
  const { lat, lng } = location;

  return Rider.find({
    isOnline:    true,
    isOnDelivery: false,
    isApproved:  true,
    isActive:    true,
    _id: { $nin: excludeIds },
    currentLocation: {
      $nearSphere: {
        $geometry: { type: 'Point', coordinates: [lng, lat] },
        $maxDistance: SEARCH_RADIUS_KM * 1000,
      },
    },
  })
    .select('_id name phone fcmToken currentLocation vehicleType')
    .limit(limit)
    .lean();
};

module.exports = { findNearbyRiders, BATCH_SIZE };
