const EARTH_RADIUS_KM = 6371;

/**
 * Calculate the Haversine distance between two coordinates.
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number} Distance in kilometres
 */
const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
};

/**
 * Check whether a point is within a given radius of an origin.
 * @param {{ lat: number, lng: number }} origin
 * @param {{ lat: number, lng: number }} point
 * @param {number} radiusKm
 * @returns {boolean}
 */
const isWithinRadius = (origin, point, radiusKm) => {
  return haversineDistance(origin.lat, origin.lng, point.lat, point.lng) <= radiusKm;
};

module.exports = { haversineDistance, isWithinRadius };
