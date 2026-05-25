require('dotenv').config();
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  phone:     { type: String, required: true, unique: true },
  name:      { type: String, default: '' },
  block:     { type: String, default: '' },
  district:  { type: String, default: '' },
  isAdmin:   { type: Boolean, default: false },
  isActive:  { type: Boolean, default: true },
  otp:       String,
  otpExpiry: Date,
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

const ADMIN_PHONE = '9330414463';

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Atlas connected');

  const result = await User.findOneAndUpdate(
    { phone: ADMIN_PHONE },
    { phone: ADMIN_PHONE, isAdmin: true, isActive: true, name: 'Admin' },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`Admin user ready: ${result.phone} | isAdmin: ${result.isAdmin} | _id: ${result._id}`);
  await mongoose.disconnect();
}

seed().catch(err => { console.error(err); process.exit(1); });
