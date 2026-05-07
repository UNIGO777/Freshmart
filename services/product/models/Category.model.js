const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      // e.g. 'fruits', 'vegetables', 'spices'
    },
    name: { type: String, required: true, trim: true },     // English display name
    nameHi: { type: String, trim: true },                   // Hindi display name
    icon: { type: String },                                 // URL or icon identifier
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('Category', categorySchema);
