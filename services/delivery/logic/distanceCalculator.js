require('dotenv').config();
const axios = require('axios');
const logger = require('../../../shared/utils/logger');

const GOOGLE_MAPS_SERVER_KEY = process.env.GOOGLE_MAPS_SERVER_KEY;

// ── Haversine fallback (straight-line km) ─────────────────────────
const haversineKm = (lat1, lng1, lat2, lng2) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
};

/**
 * Calculate road distance using Google Maps Directions API.
 * Route: rider -> vendor (waypoint) -> customer
 *
 * @param {{ lat: number, lng: number }} riderLoc
 * @param {{ lat: number, lng: number }} vendorLoc  (pickup)
 * @param {{ lat: number, lng: number }} customerLoc (drop)
 * @returns {Promise<{ totalKm: number, riderToVendorKm: number, vendorToCustomerKm: number }>}
 */
const calculateRouteDistance = async (riderLoc, vendorLoc, customerLoc) => {
  // Fallback result using Haversine
  const fallback = () => {
    const riderToVendorKm = haversineKm(riderLoc.lat, riderLoc.lng, vendorLoc.lat, vendorLoc.lng);
    const vendorToCustomerKm = haversineKm(vendorLoc.lat, vendorLoc.lng, customerLoc.lat, customerLoc.lng);
    return {
      totalKm: Math.round((riderToVendorKm + vendorToCustomerKm) * 100) / 100,
      riderToVendorKm,
      vendorToCustomerKm,
    };
  };

  if (!GOOGLE_MAPS_SERVER_KEY) {
    logger.warn('[DistanceCalc] No GOOGLE_MAPS_SERVER_KEY configured, using Haversine fallback');
    return fallback();
  }

  try {
    const { data } = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
      params: {
        origin: `${riderLoc.lat},${riderLoc.lng}`,
        destination: `${customerLoc.lat},${customerLoc.lng}`,
        waypoints: `${vendorLoc.lat},${vendorLoc.lng}`,
        mode: 'driving',
        key: GOOGLE_MAPS_SERVER_KEY,
      },
      timeout: 5000,
    });

    if (data.status !== 'OK' || !data.routes || data.routes.length === 0) {
      logger.warn('[DistanceCalc] Google Maps returned non-OK status:', data.status);
      return fallback();
    }

    const legs = data.routes[0].legs;
    if (!legs || legs.length < 2) {
      logger.warn('[DistanceCalc] Unexpected legs count:', legs?.length);
      return fallback();
    }

    // leg[0] = rider -> vendor, leg[1] = vendor -> customer
    const riderToVendorKm = Math.round((legs[0].distance.value / 1000) * 100) / 100;
    const vendorToCustomerKm = Math.round((legs[1].distance.value / 1000) * 100) / 100;

    return {
      totalKm: Math.round((riderToVendorKm + vendorToCustomerKm) * 100) / 100,
      riderToVendorKm,
      vendorToCustomerKm,
    };
  } catch (err) {
    logger.error('[DistanceCalc] Google Maps API error:', err.message);
    return fallback();
  }
};

module.exports = { calculateRouteDistance, haversineKm };
