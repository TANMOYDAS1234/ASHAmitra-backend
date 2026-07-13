// One-time bootstrap of the FULL supervisory tree, for the pilot.
//
//   node seed-hierarchy.js
//
// Creates a CMHO and a BMHO, folds the existing flat admin in as the ANM, and
// links everyone up:   CMHO ▸ BMHO ▸ ANM ▸ ASHAs
//
// Why a script: `POST /api/admin/workers` only ever mints the level BELOW the
// caller, so the top of the tree can't be created from inside the app.
//
// Idempotent — safe to re-run; it upserts by phone rather than duplicating.
// Login is passwordless OTP, so the PHONE is the credential.

require('dotenv').config();
const mongoose = require('mongoose');

const CMHO = {
  phone: '9000000001',
  name: 'Dr. Sudipta Roy (CMHO)',
  district: 'Nadia',
  block: '',
};
const BMHO = {
  phone: '9000000002',
  name: 'Dr. Arnab Ghosh (BMHO)',
  district: 'Nadia',
  block: 'Kalyani',
};

const User = mongoose.model(
  'User',
  new mongoose.Schema({}, { strict: false, collection: 'users', timestamps: true }),
);

async function upsert(phone, fields) {
  const found = await User.findOne({ phone });
  if (found) {
    await User.updateOne({ phone }, { $set: fields });
  } else {
    await User.create({ phone, ...fields });
  }
  return User.findOne({ phone });
}

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI); // never printed
    console.log('connected to Atlas\n');

    // 1) CMHO — the root of the tree, reports to nobody.
    const cmho = await upsert(CMHO.phone, {
      name: CMHO.name,
      role: 'cmho',
      isAdmin: true, // legacy flag, keeps old isAdmin checks passing
      isActive: true,
      supervisorId: null,
      district: CMHO.district,
      block: CMHO.block,
    });

    // 2) BMHO — under the CMHO.
    const bmho = await upsert(BMHO.phone, {
      name: BMHO.name,
      role: 'bmho',
      isAdmin: true,
      isActive: true,
      supervisorId: cmho._id,
      district: BMHO.district,
      block: BMHO.block,
    });

    // 3) The existing flat admin becomes the ANM, sitting under the BMHO.
    const anm = await User.findOne({
      isAdmin: true,
      phone: { $nin: [CMHO.phone, BMHO.phone] },
    });
    if (anm) {
      await User.updateOne(
        { _id: anm._id },
        { $set: { role: 'anm', supervisorId: bmho._id } },
      );
    }

    // 4) Legacy workers → asha_worker, and any ASHA with no supervisor hangs
    //    off the ANM (same thing the boot migration does).
    await User.updateMany(
      { isAdmin: { $ne: true }, $or: [{ role: { $exists: false } }, { role: null }] },
      { $set: { role: 'asha_worker' } },
    );
    let linked = { modifiedCount: 0 };
    if (anm) {
      linked = await User.updateMany(
        {
          role: 'asha_worker',
          $or: [{ supervisorId: null }, { supervisorId: { $exists: false } }],
        },
        { $set: { supervisorId: anm._id } },
      );
    }

    // ── Report the resulting tree ────────────────────────────────────────
    const ashas = anm
      ? await User.find({ role: 'asha_worker', supervisorId: anm._id }).select('name phone')
      : [];

    console.log('TREE');
    console.log(`  CMHO  ${cmho.name}  (${cmho.phone})`);
    console.log(`   └─ BMHO  ${bmho.name}  (${bmho.phone})`);
    if (anm) {
      console.log(`       └─ ANM   ${anm.name || '(no name)'}  (${anm.phone})`);
      for (const a of ashas) {
        console.log(`           └─ ASHA  ${a.name || '(no name)'}  (${a.phone})`);
      }
      console.log(`\n  ${ashas.length} ASHA(s) under the ANM (${linked.modifiedCount} newly linked)`);
    } else {
      console.log('       └─ (no existing admin found to become the ANM)');
    }

    console.log('\nLOG IN WITH (passwordless OTP — the phone is the credential):');
    console.log(`  CMHO : ${CMHO.phone}`);
    console.log(`  BMHO : ${BMHO.phone}`);
  } catch (e) {
    console.error('seed failed:', e.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
