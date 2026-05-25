require('dotenv').config();
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  phone: String, name: String, isAdmin: Boolean, isActive: Boolean,
  otp: String, otpExpiry: Date,
}, { timestamps: true });

const patientSchema = new mongoose.Schema({ ashaId: mongoose.Schema.Types.ObjectId, name: String }, { timestamps: true });
const reportSchema  = new mongoose.Schema({ ashaId: mongoose.Schema.Types.ObjectId, finalBand: String }, { timestamps: true });

const User    = mongoose.model('User',    userSchema);
const Patient = mongoose.model('Patient', patientSchema);
const Report  = mongoose.model('Report',  reportSchema);

async function test() {
  console.log('\n=== AshaМітра Backend DB Test ===\n');
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Atlas connected\n');

    const [users, patients, reports] = await Promise.all([
      User.find({}),
      Patient.find({}),
      Report.find({}),
    ]);

    console.log(`👤 Users (${users.length}):`);
    if (users.length === 0) console.log('   (none)');
    users.forEach(u => console.log(`   - ${u.phone} | admin:${u.isAdmin} | active:${u.isActive} | name:"${u.name}" | id:${u._id}`));

    console.log(`\n🏥 Patients (${patients.length}):`);
    if (patients.length === 0) console.log('   (none)');
    patients.forEach(p => console.log(`   - ${p.name} | ashaId:${p.ashaId}`));

    console.log(`\n📋 Reports (${reports.length}):`);
    if (reports.length === 0) console.log('   (none)');
    reports.forEach(r => console.log(`   - band:${r.finalBand} | ashaId:${r.ashaId}`));

    console.log('\n=== Test complete ===\n');
  } catch (err) {
    console.error('❌ ERROR:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

test();
