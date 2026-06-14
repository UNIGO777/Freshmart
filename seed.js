require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// ── Admin config ──────────────────────────────────────────────────
const ADMIN_EMAIL    = 'Naman13399@gmail.com';
const ADMIN_PASSWORD = 'Naman@13399';
const ADMIN_NAME     = 'Naman';

const adminSchema = new mongoose.Schema(
  {
    name:         { type: String, required: true, trim: true },
    email:        { type: String, required: true, unique: true, lowercase: true },
    passwordHash: { type: String, required: true, select: false },
    isActive:     { type: Boolean, default: true },
  },
  { timestamps: true },
);
const Admin = mongoose.models.Admin || mongoose.model('Admin', adminSchema);

// ── Product schema (mirrors Product.model.js) ─────────────────────
const productSchema = new mongoose.Schema(
  {
    name:             { type: String, required: true, trim: true },
    nameHi:           { type: String, trim: true },
    category: {
      type: String,
      required: true,
      enum: ['fruits', 'vegetables', 'spices', 'dairy', 'bakery', 'other'],
      index: true,
    },
    unit:             { type: String, required: true, enum: ['kg', 'g', 'piece', 'dozen'] },
    availableSeason:  { type: String, enum: ['summer', 'winter', 'rain', 'all'] },
    images:           [{ type: String }],
    coverImage:       { type: String, default: '' },
    buyingPrice:      { type: Number, required: true, min: 0 },
    sellingPrice:     { type: Number, required: true, min: 0 },
    active:           { type: Boolean, default: true, index: true },
    isAvailableToday: { type: Boolean, default: true, index: true },
    lastPricedAt:     { type: Date, default: Date.now },
  },
  { timestamps: true },
);
productSchema.index({ name: 'text', nameHi: 'text' });
const Product = mongoose.models.Product || mongoose.model('Product', productSchema);

// ── Seed data ─────────────────────────────────────────────────────
const LAST_PRICED = new Date('2026-05-12T00:00:00.000Z');

const vegetables = [
  // ── All season ──────────────────────────────────────────────────
  { name: 'Tomato',          nameHi: 'Tamatar',        unit: 'kg',    availableSeason: 'all',    buyingPrice: 25,  sellingPrice: 35  },
  { name: 'Potato',          nameHi: 'Aloo',           unit: 'kg',    availableSeason: 'all',    buyingPrice: 18,  sellingPrice: 28  },
  { name: 'Onion',           nameHi: 'Pyaaz',          unit: 'kg',    availableSeason: 'all',    buyingPrice: 22,  sellingPrice: 35  },
  { name: 'Garlic',          nameHi: 'Lehsun',         unit: 'kg',    availableSeason: 'all',    buyingPrice: 90,  sellingPrice: 130 },
  { name: 'Ginger',          nameHi: 'Adrak',          unit: 'kg',    availableSeason: 'all',    buyingPrice: 70,  sellingPrice: 100 },
  { name: 'Green Chilli',    nameHi: 'Hari Mirch',     unit: 'kg',    availableSeason: 'all',    buyingPrice: 35,  sellingPrice: 55  },
  { name: 'Coriander',       nameHi: 'Dhaniya',        unit: 'kg',    availableSeason: 'all',    buyingPrice: 20,  sellingPrice: 35  },
  { name: 'Spinach',         nameHi: 'Palak',          unit: 'kg',    availableSeason: 'all',    buyingPrice: 18,  sellingPrice: 30  },
  { name: 'Curry Leaves',    nameHi: 'Meetha Neem',    unit: 'kg',    availableSeason: 'all',    buyingPrice: 50,  sellingPrice: 80  },
  { name: 'Drumstick',       nameHi: 'Sahjan',         unit: 'kg',    availableSeason: 'all',    buyingPrice: 35,  sellingPrice: 55  },
  { name: 'Lady Finger',     nameHi: 'Bhindi',         unit: 'kg',    availableSeason: 'all',    buyingPrice: 28,  sellingPrice: 45  },
  { name: 'French Beans',    nameHi: 'Fansi',          unit: 'kg',    availableSeason: 'all',    buyingPrice: 35,  sellingPrice: 55  },
  { name: 'Raw Papaya',      nameHi: 'Kaccha Papita',  unit: 'kg',    availableSeason: 'all',    buyingPrice: 20,  sellingPrice: 35  },
  { name: 'Lemon',           nameHi: 'Nimbu',          unit: 'kg',    availableSeason: 'all',    buyingPrice: 50,  sellingPrice: 80  },
  { name: 'Spring Onion',    nameHi: 'Hara Pyaaz',     unit: 'kg',    availableSeason: 'all',    buyingPrice: 25,  sellingPrice: 40  },
  { name: 'Mint',            nameHi: 'Pudina',         unit: 'kg',    availableSeason: 'all',    buyingPrice: 20,  sellingPrice: 35  },
  // ── Summer ──────────────────────────────────────────────────────
  { name: 'Cucumber',        nameHi: 'Kheera',         unit: 'kg',    availableSeason: 'summer', buyingPrice: 20,  sellingPrice: 35  },
  { name: 'Brinjal',         nameHi: 'Baingan',        unit: 'kg',    availableSeason: 'summer', buyingPrice: 22,  sellingPrice: 38  },
  { name: 'Capsicum',        nameHi: 'Shimla Mirch',   unit: 'kg',    availableSeason: 'summer', buyingPrice: 45,  sellingPrice: 70  },
  { name: 'Corn',            nameHi: 'Makka',          unit: 'piece', availableSeason: 'summer', buyingPrice: 10,  sellingPrice: 15  },
  { name: 'Pumpkin',         nameHi: 'Kaddu',          unit: 'kg',    availableSeason: 'summer', buyingPrice: 15,  sellingPrice: 25  },
  { name: 'Bottle Gourd',    nameHi: 'Lauki',          unit: 'kg',    availableSeason: 'summer', buyingPrice: 15,  sellingPrice: 28  },
  { name: 'Ridge Gourd',     nameHi: 'Turai',          unit: 'kg',    availableSeason: 'summer', buyingPrice: 20,  sellingPrice: 35  },
  { name: 'Bitter Gourd',    nameHi: 'Karela',         unit: 'kg',    availableSeason: 'summer', buyingPrice: 30,  sellingPrice: 50  },
  { name: 'Cluster Beans',   nameHi: 'Gawar',          unit: 'kg',    availableSeason: 'summer', buyingPrice: 28,  sellingPrice: 45  },
  { name: 'Snake Gourd',     nameHi: 'Chichinda',      unit: 'kg',    availableSeason: 'summer', buyingPrice: 20,  sellingPrice: 35  },
  { name: 'Sponge Gourd',    nameHi: 'Ghiya Turai',    unit: 'kg',    availableSeason: 'summer', buyingPrice: 18,  sellingPrice: 30  },
  { name: 'Raw Mango',       nameHi: 'Kaccha Aam',     unit: 'kg',    availableSeason: 'summer', buyingPrice: 30,  sellingPrice: 50  },
  { name: 'Round Gourd',     nameHi: 'Tinda',          unit: 'kg',    availableSeason: 'summer', buyingPrice: 22,  sellingPrice: 38  },
  { name: 'Raw Coconut',     nameHi: 'Kaccha Nariyal', unit: 'piece', availableSeason: 'summer', buyingPrice: 25,  sellingPrice: 40  },
  // ── Winter ──────────────────────────────────────────────────────
  { name: 'Carrot',          nameHi: 'Gajar',          unit: 'kg',    availableSeason: 'winter', buyingPrice: 25,  sellingPrice: 40  },
  { name: 'Green Peas',      nameHi: 'Matar',          unit: 'kg',    availableSeason: 'winter', buyingPrice: 35,  sellingPrice: 60  },
  { name: 'Cauliflower',     nameHi: 'Phool Gobhi',    unit: 'piece', availableSeason: 'winter', buyingPrice: 20,  sellingPrice: 35  },
  { name: 'Cabbage',         nameHi: 'Patta Gobhi',    unit: 'piece', availableSeason: 'winter', buyingPrice: 15,  sellingPrice: 28  },
  { name: 'Radish',          nameHi: 'Mooli',          unit: 'kg',    availableSeason: 'winter', buyingPrice: 12,  sellingPrice: 22  },
  { name: 'Broccoli',        nameHi: 'Broccoli',       unit: 'kg',    availableSeason: 'winter', buyingPrice: 65,  sellingPrice: 100 },
  { name: 'Turnip',          nameHi: 'Shalgam',        unit: 'kg',    availableSeason: 'winter', buyingPrice: 15,  sellingPrice: 28  },
  { name: 'Fenugreek Leaves',nameHi: 'Methi',          unit: 'kg',    availableSeason: 'winter', buyingPrice: 22,  sellingPrice: 38  },
  { name: 'Broad Beans',     nameHi: 'Sem',            unit: 'kg',    availableSeason: 'winter', buyingPrice: 32,  sellingPrice: 50  },
  { name: 'Beetroot',        nameHi: 'Chukandar',      unit: 'kg',    availableSeason: 'winter', buyingPrice: 28,  sellingPrice: 45  },
  { name: 'Knol Khol',       nameHi: 'Ganth Gobhi',    unit: 'kg',    availableSeason: 'winter', buyingPrice: 18,  sellingPrice: 32  },
  { name: 'Mustard Leaves',  nameHi: 'Sarson',         unit: 'kg',    availableSeason: 'winter', buyingPrice: 15,  sellingPrice: 28  },
  { name: 'Bathua',          nameHi: 'Bathua Saag',    unit: 'kg',    availableSeason: 'winter', buyingPrice: 12,  sellingPrice: 22  },
  { name: 'Sweet Potato',    nameHi: 'Shakarkand',     unit: 'kg',    availableSeason: 'winter', buyingPrice: 25,  sellingPrice: 40  },
  { name: 'Lettuce',         nameHi: 'Salad Patta',    unit: 'kg',    availableSeason: 'winter', buyingPrice: 40,  sellingPrice: 65  },
  { name: 'Celery',          nameHi: 'Ajmoda',         unit: 'kg',    availableSeason: 'winter', buyingPrice: 50,  sellingPrice: 80  },
  { name: 'Dill Leaves',     nameHi: 'Suva Bhaji',     unit: 'kg',    availableSeason: 'winter', buyingPrice: 20,  sellingPrice: 35  },
  // ── Rain ────────────────────────────────────────────────────────
  { name: 'Colocasia',       nameHi: 'Arbi',           unit: 'kg',    availableSeason: 'rain',   buyingPrice: 28,  sellingPrice: 42  },
  { name: 'Ivy Gourd',       nameHi: 'Kundru',         unit: 'kg',    availableSeason: 'rain',   buyingPrice: 22,  sellingPrice: 38  },
  { name: 'Cowpea',          nameHi: 'Lobia',          unit: 'kg',    availableSeason: 'rain',   buyingPrice: 32,  sellingPrice: 50  },
  { name: 'Raw Banana',      nameHi: 'Kaccha Kela',    unit: 'kg',    availableSeason: 'rain',   buyingPrice: 22,  sellingPrice: 35  },
  { name: 'Pointed Gourd',   nameHi: 'Parwal',         unit: 'kg',    availableSeason: 'rain',   buyingPrice: 28,  sellingPrice: 45  },
  { name: 'Ash Gourd',       nameHi: 'Petha',          unit: 'kg',    availableSeason: 'rain',   buyingPrice: 15,  sellingPrice: 28  },
  { name: 'Yam',             nameHi: 'Suran',          unit: 'kg',    availableSeason: 'rain',   buyingPrice: 30,  sellingPrice: 48  },
  { name: 'Raw Jackfruit',   nameHi: 'Kathal',         unit: 'kg',    availableSeason: 'rain',   buyingPrice: 25,  sellingPrice: 40  },
  { name: 'Amaranth Leaves', nameHi: 'Chaulai Saag',   unit: 'kg',    availableSeason: 'rain',   buyingPrice: 15,  sellingPrice: 28  },
  { name: 'Taro Stem',       nameHi: 'Ghuiya Dandi',   unit: 'kg',    availableSeason: 'rain',   buyingPrice: 18,  sellingPrice: 32  },
  { name: 'Lotus Stem',      nameHi: 'Kamal Kakdi',    unit: 'kg',    availableSeason: 'rain',   buyingPrice: 45,  sellingPrice: 70  },
  { name: 'Raw Turmeric',    nameHi: 'Kacchi Haldi',   unit: 'kg',    availableSeason: 'rain',   buyingPrice: 50,  sellingPrice: 80  },
  { name: 'Water Chestnut',  nameHi: 'Singhara',       unit: 'kg',    availableSeason: 'rain',   buyingPrice: 35,  sellingPrice: 55  },
].map((p) => ({ ...p, category: 'vegetables', active: true, isAvailableToday: true, images: [], coverImage: '', lastPricedAt: LAST_PRICED }));

const fruits = [
  // ── All season ──────────────────────────────────────────────────
  { name: 'Banana',       nameHi: 'Kela',         unit: 'dozen',  availableSeason: 'all',    buyingPrice: 35,  sellingPrice: 55  },
  { name: 'Apple',        nameHi: 'Seb',          unit: 'kg',     availableSeason: 'all',    buyingPrice: 90,  sellingPrice: 140 },
  { name: 'Papaya',       nameHi: 'Papita',       unit: 'kg',     availableSeason: 'all',    buyingPrice: 25,  sellingPrice: 40  },
  { name: 'Coconut',      nameHi: 'Nariyal',      unit: 'piece',  availableSeason: 'all',    buyingPrice: 30,  sellingPrice: 50  },
  { name: 'Guava',        nameHi: 'Amrood',       unit: 'kg',     availableSeason: 'all',    buyingPrice: 30,  sellingPrice: 50  },
  { name: 'Pomegranate',  nameHi: 'Anar',         unit: 'kg',     availableSeason: 'all',    buyingPrice: 90,  sellingPrice: 140 },
  { name: 'Pineapple',    nameHi: 'Ananas',       unit: 'piece',  availableSeason: 'all',    buyingPrice: 40,  sellingPrice: 65  },
  // ── Summer ──────────────────────────────────────────────────────
  { name: 'Watermelon',   nameHi: 'Tarbooz',      unit: 'kg',     availableSeason: 'summer', buyingPrice: 12,  sellingPrice: 22  },
  { name: 'Mango',        nameHi: 'Aam',          unit: 'kg',     availableSeason: 'summer', buyingPrice: 60,  sellingPrice: 100 },
  { name: 'Muskmelon',    nameHi: 'Kharbuja',     unit: 'kg',     availableSeason: 'summer', buyingPrice: 18,  sellingPrice: 30  },
  { name: 'Lychee',       nameHi: 'Litchi',       unit: 'kg',     availableSeason: 'summer', buyingPrice: 70,  sellingPrice: 110 },
  { name: 'Jackfruit',    nameHi: 'Kathal',       unit: 'kg',     availableSeason: 'summer', buyingPrice: 25,  sellingPrice: 40  },
  { name: 'Plum',         nameHi: 'Aloo Bukhara', unit: 'kg',     availableSeason: 'summer', buyingPrice: 60,  sellingPrice: 100 },
  { name: 'Peach',        nameHi: 'Aadoo',        unit: 'kg',     availableSeason: 'summer', buyingPrice: 70,  sellingPrice: 110 },
  { name: 'Apricot',      nameHi: 'Khurmani',     unit: 'kg',     availableSeason: 'summer', buyingPrice: 80,  sellingPrice: 130 },
  { name: 'Mulberry',     nameHi: 'Shahtoot',     unit: 'kg',     availableSeason: 'summer', buyingPrice: 50,  sellingPrice: 80  },
  { name: 'Jamun',        nameHi: 'Jamun',        unit: 'kg',     availableSeason: 'summer', buyingPrice: 50,  sellingPrice: 80  },
  { name: 'Phalsa',       nameHi: 'Phalsa',       unit: 'kg',     availableSeason: 'summer', buyingPrice: 40,  sellingPrice: 65  },
  { name: 'Grape',        nameHi: 'Angoor',       unit: 'kg',     availableSeason: 'summer', buyingPrice: 55,  sellingPrice: 90  },
  // ── Winter ──────────────────────────────────────────────────────
  { name: 'Orange',       nameHi: 'Santra',       unit: 'kg',     availableSeason: 'winter', buyingPrice: 40,  sellingPrice: 70  },
  { name: 'Mandarin',     nameHi: 'Kinnow',       unit: 'kg',     availableSeason: 'winter', buyingPrice: 35,  sellingPrice: 60  },
  { name: 'Strawberry',   nameHi: 'Strawberry',   unit: 'kg',     availableSeason: 'winter', buyingPrice: 100, sellingPrice: 160 },
  { name: 'Pear',         nameHi: 'Nashpati',     unit: 'kg',     availableSeason: 'winter', buyingPrice: 50,  sellingPrice: 80  },
  { name: 'Custard Apple',nameHi: 'Sitaphal',     unit: 'kg',     availableSeason: 'winter', buyingPrice: 50,  sellingPrice: 80  },
  { name: 'Dates',        nameHi: 'Khajoor',      unit: 'kg',     availableSeason: 'winter', buyingPrice: 120, sellingPrice: 180 },
  { name: 'Amla',         nameHi: 'Amla',         unit: 'kg',     availableSeason: 'winter', buyingPrice: 30,  sellingPrice: 50  },
  { name: 'Kiwi',         nameHi: 'Kiwi',         unit: 'kg',     availableSeason: 'winter', buyingPrice: 120, sellingPrice: 180 },
  { name: 'Chikoo',       nameHi: 'Chikoo',       unit: 'kg',     availableSeason: 'winter', buyingPrice: 35,  sellingPrice: 60  },
  { name: 'Persimmon',    nameHi: 'Japani Phal',  unit: 'kg',     availableSeason: 'winter', buyingPrice: 80,  sellingPrice: 130 },
  { name: 'Jamrul',       nameHi: 'Jamrul',       unit: 'kg',     availableSeason: 'winter', buyingPrice: 40,  sellingPrice: 65  },
  // ── Rain ────────────────────────────────────────────────────────
  { name: 'Starfruit',    nameHi: 'Kamrakh',      unit: 'kg',     availableSeason: 'rain',   buyingPrice: 40,  sellingPrice: 65  },
  { name: 'Passion Fruit',nameHi: 'Passion Phal', unit: 'kg',     availableSeason: 'rain',   buyingPrice: 100, sellingPrice: 160 },
  { name: 'Dragon Fruit', nameHi: 'Dragon Phal',  unit: 'kg',     availableSeason: 'rain',   buyingPrice: 120, sellingPrice: 200 },
  { name: 'Wood Apple',   nameHi: 'Bael',         unit: 'piece',  availableSeason: 'rain',   buyingPrice: 20,  sellingPrice: 35  },
  { name: 'Tamarind',     nameHi: 'Imli',         unit: 'kg',     availableSeason: 'rain',   buyingPrice: 50,  sellingPrice: 80  },
  { name: 'Karonda',      nameHi: 'Karonda',      unit: 'kg',     availableSeason: 'rain',   buyingPrice: 35,  sellingPrice: 60  },
  { name: 'Ber',          nameHi: 'Ber',          unit: 'kg',     availableSeason: 'rain',   buyingPrice: 30,  sellingPrice: 50  },
].map((p) => ({ ...p, category: 'fruits', active: true, isAvailableToday: true, images: [], coverImage: '', lastPricedAt: LAST_PRICED }));

const spices = [
  { name: 'Turmeric Powder',    nameHi: 'Haldi',           unit: 'kg', buyingPrice: 120,  sellingPrice: 180  },
  { name: 'Red Chilli Powder',  nameHi: 'Lal Mirch',       unit: 'kg', buyingPrice: 150,  sellingPrice: 220  },
  { name: 'Coriander Powder',   nameHi: 'Dhaniya Powder',  unit: 'kg', buyingPrice: 100,  sellingPrice: 160  },
  { name: 'Cumin Seeds',        nameHi: 'Jeera',            unit: 'kg', buyingPrice: 250,  sellingPrice: 380  },
  { name: 'Mustard Seeds',      nameHi: 'Rai',              unit: 'kg', buyingPrice: 80,   sellingPrice: 130  },
  { name: 'Fenugreek Seeds',    nameHi: 'Methi Dana',       unit: 'kg', buyingPrice: 80,   sellingPrice: 130  },
  { name: 'Black Pepper',       nameHi: 'Kali Mirch',       unit: 'kg', buyingPrice: 500,  sellingPrice: 750  },
  { name: 'Cloves',             nameHi: 'Laung',            unit: 'kg', buyingPrice: 700,  sellingPrice: 1000 },
  { name: 'Cardamom',           nameHi: 'Elaichi',          unit: 'kg', buyingPrice: 1800, sellingPrice: 2500 },
  { name: 'Cinnamon',           nameHi: 'Dalchini',         unit: 'kg', buyingPrice: 300,  sellingPrice: 450  },
  { name: 'Bay Leaves',         nameHi: 'Tej Patta',        unit: 'kg', buyingPrice: 150,  sellingPrice: 240  },
  { name: 'Asafoetida',         nameHi: 'Hing',             unit: 'kg', buyingPrice: 800,  sellingPrice: 1200 },
  { name: 'Carom Seeds',        nameHi: 'Ajwain',           unit: 'kg', buyingPrice: 120,  sellingPrice: 190  },
  { name: 'Fennel Seeds',       nameHi: 'Saunf',            unit: 'kg', buyingPrice: 130,  sellingPrice: 200  },
  { name: 'Dry Red Chilli',     nameHi: 'Sukhi Lal Mirch',  unit: 'kg', buyingPrice: 180,  sellingPrice: 280  },
  { name: 'Garam Masala',       nameHi: 'Garam Masala',     unit: 'kg', buyingPrice: 250,  sellingPrice: 380  },
  { name: 'Dry Mango Powder',   nameHi: 'Amchur',           unit: 'kg', buyingPrice: 180,  sellingPrice: 280  },
  { name: 'Pomegranate Seeds',  nameHi: 'Anardana',         unit: 'kg', buyingPrice: 300,  sellingPrice: 450  },
  { name: 'Nigella Seeds',      nameHi: 'Kalonji',          unit: 'kg', buyingPrice: 150,  sellingPrice: 240  },
  { name: 'Star Anise',         nameHi: 'Chakri Phool',     unit: 'kg', buyingPrice: 400,  sellingPrice: 600  },
  { name: 'Nutmeg',             nameHi: 'Jaiphal',          unit: 'kg', buyingPrice: 600,  sellingPrice: 900  },
  { name: 'Mace',               nameHi: 'Javitri',          unit: 'kg', buyingPrice: 700,  sellingPrice: 1050 },
  { name: 'Black Cardamom',     nameHi: 'Badi Elaichi',     unit: 'kg', buyingPrice: 900,  sellingPrice: 1350 },
  { name: 'Sesame Seeds',       nameHi: 'Til',              unit: 'kg', buyingPrice: 120,  sellingPrice: 190  },
  { name: 'Poppy Seeds',        nameHi: 'Khus Khus',        unit: 'kg', buyingPrice: 500,  sellingPrice: 750  },
  { name: 'Curry Powder',       nameHi: 'Curry Powder',     unit: 'kg', buyingPrice: 200,  sellingPrice: 300  },
  { name: 'Chaat Masala',       nameHi: 'Chaat Masala',     unit: 'kg', buyingPrice: 200,  sellingPrice: 300  },
  { name: 'Biryani Masala',     nameHi: 'Biryani Masala',   unit: 'kg', buyingPrice: 250,  sellingPrice: 380  },
  { name: 'Sambar Masala',      nameHi: 'Sambar Masala',    unit: 'kg', buyingPrice: 200,  sellingPrice: 300  },
  { name: 'Pav Bhaji Masala',   nameHi: 'Pav Bhaji Masala', unit: 'kg', buyingPrice: 200,  sellingPrice: 300  },
  { name: 'Saffron',            nameHi: 'Kesar',             unit: 'g',  buyingPrice: 350,  sellingPrice: 500  },
  { name: 'Dried Ginger Powder',nameHi: 'Sonth',             unit: 'kg', buyingPrice: 200,  sellingPrice: 300  },
  { name: 'Black Salt',         nameHi: 'Kala Namak',        unit: 'kg', buyingPrice: 40,   sellingPrice: 70   },
  { name: 'Rock Salt',          nameHi: 'Sendha Namak',      unit: 'kg', buyingPrice: 30,   sellingPrice: 55   },
].map((p) => ({ ...p, category: 'spices', availableSeason: 'all', active: true, isAvailableToday: true, images: [], coverImage: '', lastPricedAt: LAST_PRICED }));

const dairy = [
  { name: 'Full Cream Milk',  nameHi: 'Poora Doodh',           unit: 'kg',    buyingPrice: 52,  sellingPrice: 65  },
  { name: 'Toned Milk',       nameHi: 'Toned Doodh',           unit: 'kg',    buyingPrice: 44,  sellingPrice: 55  },
  { name: 'Skimmed Milk',     nameHi: 'Malai Rahit Doodh',     unit: 'kg',    buyingPrice: 38,  sellingPrice: 50  },
  { name: 'Buffalo Milk',     nameHi: 'Bhains Ka Doodh',       unit: 'kg',    buyingPrice: 60,  sellingPrice: 75  },
  { name: 'Paneer',           nameHi: 'Paneer',                 unit: 'kg',    buyingPrice: 280, sellingPrice: 380 },
  { name: 'Dahi',             nameHi: 'Dahi',                   unit: 'kg',    buyingPrice: 55,  sellingPrice: 75  },
  { name: 'Butter',           nameHi: 'Makkhan',                unit: 'kg',    buyingPrice: 380, sellingPrice: 500 },
  { name: 'Ghee',             nameHi: 'Ghee',                   unit: 'kg',    buyingPrice: 500, sellingPrice: 680 },
  { name: 'Cream',            nameHi: 'Malai',                  unit: 'kg',    buyingPrice: 150, sellingPrice: 220 },
  { name: 'Buttermilk',       nameHi: 'Chaas',                  unit: 'kg',    buyingPrice: 20,  sellingPrice: 35  },
  { name: 'Lassi',            nameHi: 'Lassi',                  unit: 'kg',    buyingPrice: 40,  sellingPrice: 60  },
  { name: 'Khoya',            nameHi: 'Mawa',                   unit: 'kg',    buyingPrice: 280, sellingPrice: 380 },
  { name: 'Condensed Milk',   nameHi: 'Gada Doodh',             unit: 'kg',    buyingPrice: 120, sellingPrice: 180 },
  { name: 'Milk Powder',      nameHi: 'Doodh Powder',           unit: 'kg',    buyingPrice: 280, sellingPrice: 380 },
  { name: 'Cheese Slice',     nameHi: 'Cheese Slice',           unit: 'kg',    buyingPrice: 450, sellingPrice: 600 },
  { name: 'Cheddar Cheese',   nameHi: 'Cheddar Cheese',         unit: 'kg',    buyingPrice: 500, sellingPrice: 700 },
  { name: 'Mozzarella Cheese',nameHi: 'Mozzarella Cheese',      unit: 'kg',    buyingPrice: 500, sellingPrice: 700 },
  { name: 'Whipping Cream',   nameHi: 'Whipping Cream',         unit: 'kg',    buyingPrice: 200, sellingPrice: 300 },
  { name: 'Egg',              nameHi: 'Anda',                   unit: 'dozen', buyingPrice: 70,  sellingPrice: 90  },
  { name: 'Shrikhand',        nameHi: 'Shrikhand',              unit: 'kg',    buyingPrice: 150, sellingPrice: 220 },
  { name: 'Ice Cream',        nameHi: 'Ice Cream',              unit: 'kg',    buyingPrice: 180, sellingPrice: 280 },
].map((p) => ({ ...p, category: 'dairy', availableSeason: 'all', active: true, isAvailableToday: true, images: [], coverImage: '', lastPricedAt: LAST_PRICED }));

const bakery = [
  { name: 'White Bread',    nameHi: 'Safed Bread',    unit: 'piece', buyingPrice: 35,  sellingPrice: 50  },
  { name: 'Brown Bread',    nameHi: 'Brown Bread',    unit: 'piece', buyingPrice: 40,  sellingPrice: 60  },
  { name: 'Multigrain Bread',nameHi:'Multigrain Bread',unit: 'piece', buyingPrice: 50,  sellingPrice: 75  },
  { name: 'Pav',            nameHi: 'Pav',            unit: 'piece', buyingPrice: 20,  sellingPrice: 30  },
  { name: 'Burger Bun',     nameHi: 'Burger Bun',     unit: 'piece', buyingPrice: 15,  sellingPrice: 25  },
  { name: 'Butter Bun',     nameHi: 'Butter Bun',     unit: 'piece', buyingPrice: 12,  sellingPrice: 20  },
  { name: 'Rusk',           nameHi: 'Rusk',           unit: 'kg',    buyingPrice: 120, sellingPrice: 180 },
  { name: 'Plain Biscuit',  nameHi: 'Sada Biscuit',   unit: 'kg',    buyingPrice: 80,  sellingPrice: 130 },
  { name: 'Cream Biscuit',  nameHi: 'Cream Biscuit',  unit: 'kg',    buyingPrice: 100, sellingPrice: 160 },
  { name: 'Croissant',      nameHi: 'Croissant',      unit: 'piece', buyingPrice: 25,  sellingPrice: 40  },
  { name: 'Plain Cake',     nameHi: 'Sada Cake',      unit: 'kg',    buyingPrice: 180, sellingPrice: 280 },
  { name: 'Chocolate Cake', nameHi: 'Chocolate Cake', unit: 'kg',    buyingPrice: 280, sellingPrice: 420 },
  { name: 'Muffin',         nameHi: 'Muffin',         unit: 'piece', buyingPrice: 25,  sellingPrice: 40  },
  { name: 'Cupcake',        nameHi: 'Cupcake',        unit: 'piece', buyingPrice: 30,  sellingPrice: 50  },
  { name: 'Cookies',        nameHi: 'Cookies',        unit: 'kg',    buyingPrice: 150, sellingPrice: 240 },
  { name: 'Nankhatai',      nameHi: 'Nankhatai',      unit: 'kg',    buyingPrice: 130, sellingPrice: 200 },
  { name: 'Khari Biscuit',  nameHi: 'Khari',          unit: 'kg',    buyingPrice: 100, sellingPrice: 160 },
  { name: 'Toast',          nameHi: 'Toast',          unit: 'piece', buyingPrice: 30,  sellingPrice: 50  },
  { name: 'Pizza Base',     nameHi: 'Pizza Base',     unit: 'piece', buyingPrice: 40,  sellingPrice: 65  },
  { name: 'Doughnut',       nameHi: 'Doughnut',       unit: 'piece', buyingPrice: 25,  sellingPrice: 40  },
  { name: 'Brownie',        nameHi: 'Brownie',        unit: 'piece', buyingPrice: 35,  sellingPrice: 60  },
  { name: 'Bread Roll',     nameHi: 'Bread Roll',     unit: 'piece', buyingPrice: 10,  sellingPrice: 18  },
  { name: 'Fruit Cake',     nameHi: 'Fruit Cake',     unit: 'kg',    buyingPrice: 250, sellingPrice: 380 },
  { name: 'Puff Pastry',    nameHi: 'Puff',           unit: 'piece', buyingPrice: 15,  sellingPrice: 25  },
].map((p) => ({ ...p, category: 'bakery', availableSeason: 'all', active: true, isAvailableToday: true, images: [], coverImage: '', lastPricedAt: LAST_PRICED }));

const other = [
  { name: 'Rice',            nameHi: 'Chawal',           unit: 'kg', buyingPrice: 55,  sellingPrice: 80   },
  { name: 'Basmati Rice',    nameHi: 'Basmati Chawal',   unit: 'kg', buyingPrice: 90,  sellingPrice: 130  },
  { name: 'Wheat Flour',     nameHi: 'Gehun Atta',       unit: 'kg', buyingPrice: 35,  sellingPrice: 55   },
  { name: 'Maida',           nameHi: 'Maida',             unit: 'kg', buyingPrice: 30,  sellingPrice: 48   },
  { name: 'Besan',           nameHi: 'Besan',             unit: 'kg', buyingPrice: 60,  sellingPrice: 90   },
  { name: 'Sooji',           nameHi: 'Sooji',             unit: 'kg', buyingPrice: 35,  sellingPrice: 55   },
  { name: 'Poha',            nameHi: 'Poha',              unit: 'kg', buyingPrice: 45,  sellingPrice: 70   },
  { name: 'Toor Dal',        nameHi: 'Toor Dal',          unit: 'kg', buyingPrice: 110, sellingPrice: 160  },
  { name: 'Moong Dal',       nameHi: 'Moong Dal',         unit: 'kg', buyingPrice: 100, sellingPrice: 150  },
  { name: 'Chana Dal',       nameHi: 'Chana Dal',         unit: 'kg', buyingPrice: 90,  sellingPrice: 135  },
  { name: 'Urad Dal',        nameHi: 'Urad Dal',          unit: 'kg', buyingPrice: 100, sellingPrice: 150  },
  { name: 'Masoor Dal',      nameHi: 'Masoor Dal',        unit: 'kg', buyingPrice: 85,  sellingPrice: 130  },
  { name: 'Kabuli Chana',    nameHi: 'Kabuli Chana',      unit: 'kg', buyingPrice: 90,  sellingPrice: 140  },
  { name: 'Rajma',           nameHi: 'Rajma',             unit: 'kg', buyingPrice: 110, sellingPrice: 170  },
  { name: 'Sugar',           nameHi: 'Cheeni',            unit: 'kg', buyingPrice: 42,  sellingPrice: 60   },
  { name: 'Jaggery',         nameHi: 'Gud',               unit: 'kg', buyingPrice: 50,  sellingPrice: 75   },
  { name: 'Salt',            nameHi: 'Namak',             unit: 'kg', buyingPrice: 12,  sellingPrice: 22   },
  { name: 'Sunflower Oil',   nameHi: 'Surajmukhi Tel',    unit: 'kg', buyingPrice: 120, sellingPrice: 170  },
  { name: 'Mustard Oil',     nameHi: 'Sarson Ka Tel',     unit: 'kg', buyingPrice: 130, sellingPrice: 185  },
  { name: 'Groundnut Oil',   nameHi: 'Moongphali Tel',    unit: 'kg', buyingPrice: 150, sellingPrice: 210  },
  { name: 'Coconut Oil',     nameHi: 'Nariyal Tel',       unit: 'kg', buyingPrice: 160, sellingPrice: 230  },
  { name: 'Soya Sauce',      nameHi: 'Soya Sauce',        unit: 'kg', buyingPrice: 80,  sellingPrice: 130  },
  { name: 'Tomato Ketchup',  nameHi: 'Tamatar Sauce',     unit: 'kg', buyingPrice: 70,  sellingPrice: 110  },
  { name: 'Vinegar',         nameHi: 'Sirka',             unit: 'kg', buyingPrice: 40,  sellingPrice: 65   },
  { name: 'Honey',           nameHi: 'Shahad',            unit: 'kg', buyingPrice: 200, sellingPrice: 320  },
  { name: 'Vermicelli',      nameHi: 'Seviyan',           unit: 'kg', buyingPrice: 60,  sellingPrice: 95   },
  { name: 'Spaghetti',       nameHi: 'Spaghetti',         unit: 'kg', buyingPrice: 70,  sellingPrice: 110  },
  { name: 'Macaroni',        nameHi: 'Macaroni',          unit: 'kg', buyingPrice: 65,  sellingPrice: 100  },
  { name: 'Noodles',         nameHi: 'Noodles',           unit: 'kg', buyingPrice: 70,  sellingPrice: 110  },
  { name: 'Oats',            nameHi: 'Oats',              unit: 'kg', buyingPrice: 100, sellingPrice: 160  },
  { name: 'Corn Flour',      nameHi: 'Makke Ka Atta',     unit: 'kg', buyingPrice: 40,  sellingPrice: 65   },
  { name: 'Baking Powder',   nameHi: 'Baking Powder',     unit: 'kg', buyingPrice: 150, sellingPrice: 230  },
  { name: 'Baking Soda',     nameHi: 'Meetha Soda',       unit: 'kg', buyingPrice: 50,  sellingPrice: 80   },
  { name: 'Dry Fruits Mix',  nameHi: 'Sukhe Meve',        unit: 'kg', buyingPrice: 600, sellingPrice: 900  },
  { name: 'Cashew',          nameHi: 'Kaju',              unit: 'kg', buyingPrice: 700, sellingPrice: 1000 },
  { name: 'Almond',          nameHi: 'Badam',             unit: 'kg', buyingPrice: 800, sellingPrice: 1150 },
  { name: 'Raisin',          nameHi: 'Kishmish',          unit: 'kg', buyingPrice: 200, sellingPrice: 320  },
  { name: 'Walnut',          nameHi: 'Akhrot',            unit: 'kg', buyingPrice: 600, sellingPrice: 900  },
  { name: 'Pistachio',       nameHi: 'Pista',             unit: 'kg', buyingPrice: 900, sellingPrice: 1300 },
  { name: 'Tea Leaves',      nameHi: 'Chai Patti',        unit: 'kg', buyingPrice: 250, sellingPrice: 380  },
  { name: 'Coffee Powder',   nameHi: 'Coffee Powder',     unit: 'kg', buyingPrice: 400, sellingPrice: 600  },
  { name: 'Cocoa Powder',    nameHi: 'Cocoa Powder',      unit: 'kg', buyingPrice: 350, sellingPrice: 550  },
  { name: 'Tapioca Pearls',  nameHi: 'Sabudana',          unit: 'kg', buyingPrice: 80,  sellingPrice: 125  },
  { name: 'Peanuts',         nameHi: 'Moongphali',        unit: 'kg', buyingPrice: 70,  sellingPrice: 110  },
  { name: 'Papad',           nameHi: 'Papad',             unit: 'kg', buyingPrice: 120, sellingPrice: 180  },
  { name: 'Pickle',          nameHi: 'Achar',             unit: 'kg', buyingPrice: 100, sellingPrice: 160  },
].map((p) => ({ ...p, category: 'other', availableSeason: 'all', active: true, isAvailableToday: true, images: [], coverImage: '', lastPricedAt: LAST_PRICED }));

const ALL_PRODUCTS = [...vegetables, ...fruits, ...spices, ...dairy, ...bakery, ...other];

// ── Main ──────────────────────────────────────────────────────────
(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    // ── Admin ──
    const existing = await Admin.findOne({ email: ADMIN_EMAIL.toLowerCase() });
    if (existing) {
      console.log(`Admin already exists: ${existing.email}`);
    } else {
      const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
      const admin = await Admin.create({ name: ADMIN_NAME, email: ADMIN_EMAIL, passwordHash });
      console.log('Admin created:');
      console.log(`  ID:    ${admin._id}`);
      console.log(`  Email: ${admin.email}`);
      console.log(`  Name:  ${admin.name}`);
    }

    // ── Products ──
    const existingCount = await Product.countDocuments();
    if (existingCount > 0) {
      console.log(`Products already seeded (${existingCount} found). Skipping product seed.`);
      console.log('  Run with --force flag to re-seed: node seed.js --force');
    } else {
      const inserted = await Product.insertMany(ALL_PRODUCTS, { ordered: false });
      console.log(`\nProducts seeded successfully: ${inserted.length} products`);

      // Summary by category
      const summary = inserted.reduce((acc, p) => {
        acc[p.category] = (acc[p.category] || 0) + 1;
        return acc;
      }, {});
      Object.entries(summary).forEach(([cat, count]) => {
        console.log(`  ${cat.padEnd(12)} ${count} products`);
      });
    }

    // ── Force re-seed ──
    if (process.argv.includes('--force')) {
      await Product.deleteMany({});
      const inserted = await Product.insertMany(ALL_PRODUCTS, { ordered: false });
      console.log(`\nForce re-seeded: ${inserted.length} products`);
    }

  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
})();
