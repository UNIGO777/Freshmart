require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

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

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('Connected to MongoDB');

    const existing = await Admin.findOne({ email: ADMIN_EMAIL.toLowerCase() });
    if (existing) {
      console.log(`Admin already exists: ${existing.email}`);
      process.exit(0);
    }

    const passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 12);
    const admin = await Admin.create({ name: ADMIN_NAME, email: ADMIN_EMAIL, passwordHash });

    console.log('Admin created successfully:');
    console.log(`  ID:    ${admin._id}`);
    console.log(`  Email: ${admin.email}`);
    console.log(`  Name:  ${admin.name}`);
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
})();
