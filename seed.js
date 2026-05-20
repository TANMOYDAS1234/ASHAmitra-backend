require('dotenv').config();
const mongoose = require('mongoose');
const User     = require('./src/models/User');

async function seed() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB Atlas');

    // Remove existing admin if any (clean re-seed)
    await User.deleteOne({ phone: '9330414463' });

    // Insert admin
    const admin = await User.create({
      phone:    '9330414463',
      name:     'Super Admin',
      role:     'admin',
      block:    'HQ',
      district: 'West Bengal',
      language: 'Bengali (বাংলা)',
      isActive: true,
    });

    // Set fixed OTP for admin: 123456
    await admin.setOtp('123456');
    await admin.save();

    console.log('✅ Admin inserted:');
    console.log('   Phone : 9330414463');
    console.log('   OTP   : 123456');
    console.log('   Role  : admin');
    console.log('   ID    :', admin._id.toString());

  } catch (err) {
    console.error('❌ Seed failed:', err.message);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected');
  }
}

seed();
