const mongoose = require('mongoose');

const riderSessionSchema = new mongoose.Schema(
  {
    riderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Rider',
      required: true,
      index: true,
    },
    startedAt: { type: Date, required: true, default: Date.now },
    endedAt:   { type: Date, default: null },
    durationMinutes: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// For querying active sessions and date-range aggregations
riderSessionSchema.index({ riderId: 1, startedAt: -1 });
riderSessionSchema.index({ riderId: 1, endedAt: 1 });

module.exports = mongoose.model('RiderSession', riderSessionSchema);
