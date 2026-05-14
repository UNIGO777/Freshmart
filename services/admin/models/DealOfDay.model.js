const mongoose = require('mongoose');

const dealOfDaySchema = new mongoose.Schema(
  {
    heading:    { type: String, default: 'Deal of the day', trim: true },
    title:      { type: String, required: true, trim: true },
    price:      { type: Number, required: true, min: 0 },
    cutPrice:   { type: Number, required: true, min: 0 },
    bgImage:    { type: String, default: '' },
    isActive:   { type: Boolean, default: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model('DealOfDay', dealOfDaySchema);
