// One-time bootstrap: create the TOP of the supervisory tree (a CMHO).
//
// Why this exists: the boot migration folds the legacy flat admin into an ANM,
// and `POST /api/admin/workers` only ever mints the level BELOW the caller
// (CMHO→BMHO→ANM→ASHA). So there is no in-app way to bring the first CMHO into
// being — it has to be seeded once, from the server.
//
//   node seed-cmho.js <phone> "<name>" [district]
//   e.g. node seed-cmho.js 9876543210 "Dr. A. Sen" Nadia
//
// Then, entirely from the app:
//   1. log in as the CMHO            → create a BMHO   (create-chain)
//   2. log in as the BMHO            → adopt the existing ANM from "unassigned"
//   3. the ANM already owns her ASHAs (linked by the migration)
//   → the tree is CMHO ▸ BMHO ▸ ANM ▸ ASHA.
//
// Idempotent: re-running promotes the same phone rather than duplicating.

require('dotenv').config();
const mongoose = require('mongoose');

const [phone, name, district] = process.argv.slice(2);
if (!phone || !name) {
  console.error('usage: node seed-cmho.js <phone> "<name>" [district]');
  process.exit(1);
}

// Loose schema on purpose — this script must not drift from server.js's model.
const User = mongoose.model(
  'User',
  new mongoose.Schema({}, { strict: false, collection: 'users', timestamps: true }),
);

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const fields = {
      name,
      role: 'cmho',
      isAdmin: true,      // legacy flag — keeps old isAdmin checks passing
      isActive: true,
      supervisorId: null, // the CMHO is the root; reports to nobody
      district: district || '',
    };

    const existing = await User.findOne({ phone });
    if (existing) {
      await User.updateOne({ phone }, { $set: fields });
      console.log(`Promoted existing user ${phone} → CMHO (${name}).`);
    } else {
      await User.create({ phone, block: '', ...fields });
      console.log(`Created CMHO ${name} (${phone}).`);
    }

    const cmho = await User.findOne({ phone }).select('_id role');
    console.log(`  _id=${cmho._id}  role=${cmho.role}`);
    console.log('Next: log in as this phone → create a BMHO → BMHO adopts the ANM.');
  } catch (e) {
    console.error('seed failed:', e.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
