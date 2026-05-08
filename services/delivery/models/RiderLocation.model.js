const mongoose = require('mongoose');

/**
 * Stores the most recent GPS location for each rider.
 * One document per rider — upserted on every location update.
 * Used for: geo queries (nearby rider finder), live map tracking.
 *
 * Note: Rider.currentLocation also tracks this but is the Rider profile field.
 * This collection is optimised for high-frequency write-then-query patterns.
 */
const riderLocationSchema = new mongoose.Schema(
  {
    riderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rider',
      required: true,
      unique: true,
    },
    location: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], required: true }, // [lng, lat]
    },
  },
  {
    // Use timestamps so updatedAt tracks when the location was last received
    timestamps: true,
  },
);

riderLocationSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('RiderLocation', riderLocationSchema);
