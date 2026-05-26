require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// ── Atlas connection ──────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB Atlas connected'))
  .catch(err => { console.error('Atlas connection error:', err.message); process.exit(1); });

// ── Schemas ───────────────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  phone:            { type: String, required: true, unique: true },
  name:             { type: String, default: '' },
  block:            { type: String, default: '' },
  district:         { type: String, default: '' },
  isAdmin:          { type: Boolean, default: false },
  isActive:         { type: Boolean, default: true },
  profileImagePath: { type: String, default: null },
  otp:              String,
  otpExpiry:        Date,
}, { timestamps: true });

const patientSchema = new mongoose.Schema({
  ashaId:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  name:      { type: String, required: true },
  type:      { type: String, required: true },
  village:   { type: String, default: '' },
  mobile:    { type: String, default: '' },
  lastVisit: { type: String, default: '' },
  risk:      { type: String, default: 'safe' },
  situation: String,
  outcome:   String,
  reason:    String,
  nextStep:  String,
  qaHistory: { type: Array, default: [] },
  // Optimistic concurrency control. Incremented on every successful update.
  // PUT requests carry the version they're updating from; if it no longer
  // matches the server's, the update is rejected 409 so the client can
  // refetch + merge instead of silently overwriting another writer.
  version:   { type: Number, default: 0 },
}, { timestamps: true });

const reportSchema = new mongoose.Schema({
  ashaId:              { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  patientId:           String,
  patientName:         String,
  caseType:            String,
  caseLabel:           String,
  outcome:             String,
  finalBand:           String,
  reason:              String,
  nextStep:            String,
  situation:           String,
  qaHistory:           { type: Array, default: [] },
  triggeredRules:      { type: [String], default: [] },
  riskScore:           { type: Number, default: 0 },
  riskLevel:           String,
  dangerSigns:         { type: [String], default: [] },
  suspectedConditions: { type: [String], default: [] },
  facilityType:        String,
  recheckAfterHours:   { type: Number, default: 0 },
  transportAction:     String,
}, { timestamps: true });

// ── Notifications ─────────────────────────────────────────────────────────────
// `recipientId` is the User who receives. For admin-broadcast events we create
// one Notification per active admin (cheap enough at pilot scale and lets each
// admin track their own read state). `type` lets the client choose an icon
// + colour. `data` is a free-form payload (e.g. { reportId, patientId }).
const notificationSchema = new mongoose.Schema({
  recipientId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type:        { type: String, required: true }, // red_band | yellow_band | welcome | follow_up | sync
  title:       { type: String, required: true },
  body:        { type: String, default: '' },
  link:        { type: String, default: '' },    // optional route
  data:        { type: mongoose.Schema.Types.Mixed, default: {} },
  read:        { type: Boolean, default: false, index: true },
}, { timestamps: true });

// AI response cache. Same prompt → same response (deterministic at temp 0.2,
// and even at higher temps the variation isn't worth the extra LLM calls for
// what is essentially a clinical-question lookup table). Keyed by SHA-1 of
// the trimmed prompt to keep keys short and collision-resistant. TTL is
// indefinite — clinical-guidance text doesn't go stale on the timescales
// that matter here. Bump a version prefix to invalidate if model changes.
const aiCacheSchema = new mongoose.Schema({
  key:        { type: String, required: true, unique: true, index: true },
  prompt:     { type: String, required: true },
  text:       { type: String, required: true },
  provider:   { type: String, required: true },
  hits:       { type: Number, default: 0 },
  lastUsedAt: { type: Date,   default: Date.now },
}, { timestamps: true });

const User         = mongoose.model('User',         userSchema);
const Patient      = mongoose.model('Patient',      patientSchema);
const Report       = mongoose.model('Report',       reportSchema);
const Notification = mongoose.model('Notification', notificationSchema);
const AiCache      = mongoose.model('AiCache',      aiCacheSchema);

// ── Helper: create one notification per active admin ──────────────────────────
async function notifyAllAdmins({ type, title, body, link = '', data = {} }) {
  try {
    const admins = await User.find({ isAdmin: true, isActive: true }).select('_id');
    if (admins.length === 0) return;
    await Notification.insertMany(admins.map(a => ({
      recipientId: a._id, type, title, body, link, data,
    })));
  } catch (e) {
    console.error('[notifyAllAdmins]', e.message);
  }
}

async function notifyUser({ recipientId, type, title, body, link = '', data = {} }) {
  try {
    if (!recipientId) return;
    await Notification.create({ recipientId, type, title, body, link, data });
  } catch (e) {
    console.error('[notifyUser]', e.message);
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ success: false, message: 'No token' });
  try {
    req.user = jwt.verify(header.replace('Bearer ', ''), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user.isAdmin && req.user.role !== 'admin')
    return res.status(403).json({ success: false, message: 'Admin only' });
  next();
}

// ── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ success: true, message: 'AshaMitra backend is running', version: '1.0.0' }));

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone required' });

    let user = await User.findOne({ phone });
    if (!user)
      return res.status(404).json({ success: false, message: 'এই নম্বরটি নিবন্ধিত নয়। অ্যাডমিনের সাথে যোগাযোগ করুন।' });
    if (!user.isActive)
      return res.status(403).json({ success: false, message: 'Account deactivated' });

    const otp    = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + Number(process.env.OTP_EXPIRY_MINUTES) * 60000);
    await User.updateOne({ phone }, { otp, otpExpiry: expiry });

    console.log(`[DEV] OTP for ${phone}: ${otp}`);
    const isPilot = process.env.USE_REAL_OTP !== 'true';
    res.json({ success: true, message: 'OTP sent', ...(isPilot && { otp }) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;
    const user = await User.findOne({ phone });
    if (!user)
      return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.isActive)
      return res.status(403).json({ success: false, message: 'Account deactivated' });
    if (user.otp !== otp || new Date() > user.otpExpiry)
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });

    await User.updateOne({ phone }, { otp: null, otpExpiry: null });

    const token = jwt.sign(
      { id: user._id, phone: user.phone, isAdmin: user.isAdmin ?? (user.role === 'admin'), role: user.role ?? (user.isAdmin ? 'admin' : 'asha_worker') },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({
      success: true,
      token,
      user: {
        id: user._id.toString(), phone: user.phone, name: user.name,
        block: user.block, district: user.district,
        isAdmin: user.isAdmin,
        role: user.isAdmin ? 'admin' : 'asha_worker',
        isActive: user.isActive,
        profileImagePath: user.profileImagePath ?? null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Profile update ───────────────────────────────────────────────────────────

app.put('/api/auth/profile', auth, async (req, res) => {
  try {
    const allowed = ['name', 'block', 'district', 'profileImagePath'];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const user = await User.findByIdAndUpdate(req.user.id, update, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({
      success: true,
      user: {
        id: user._id.toString(), phone: user.phone, name: user.name,
        block: user.block, district: user.district,
        isAdmin: user.isAdmin,
        role: user.isAdmin ? 'admin' : 'asha_worker',
        isActive: user.isActive,
        profileImagePath: user.profileImagePath ?? null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Patients ──────────────────────────────────────────────────────────────────

app.get('/api/patients', auth, async (req, res) => {
  try {
    const patients = await Patient.find({ ashaId: req.user.id }).sort({ createdAt: -1 });
    // Normalize _id → id for Flutter model compatibility
    res.json({ success: true, data: patients.map(toClient) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/patients', auth, async (req, res) => {
  try {
    const body = { ...req.body, ashaId: req.user.id };
    const name = (body.name || '').trim();
    const mobile = (body.mobile || '').trim();

    // De-dup: if a patient already exists for this ASHA with the same name +
    // mobile, return that existing doc instead of creating a new one.
    // This prevents duplicates from accidental double-taps, retry on flaky
    // network, or the user adding the same person twice. The client
    // receives the existing _id, so subsequent triage reports correctly
    // attach to the original patient document.
    if (name) {
      const match = mobile
        ? { ashaId: req.user.id, name, mobile }
        : { ashaId: req.user.id, name, mobile: { $in: ['', null] } };
      const existing = await Patient.findOneAndUpdate(
        match,
        { $set: body, $inc: { version: 1 } },
        { new: true },
      );
      if (existing) {
        return res.status(200).json({ success: true, data: toClient(existing), deduped: true });
      }
    }

    const patient = await Patient.create(body);
    res.status(201).json({ success: true, data: toClient(patient) });
  } catch (err) {
    // E11000 here means a concurrent POST raced past the upsert check.
    // Friendly 409 so the client can show "patient already exists".
    if (err && err.code === 11000) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_NAME_MOBILE',
        message: 'A patient with this name and mobile number already exists in your list.',
      });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/patients/:id', auth, async (req, res) => {
  try {
    const patient = await Patient.findOne({ _id: req.params.id, ashaId: req.user.id });
    if (!patient) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: toClient(patient) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.put('/api/patients/:id', auth, async (req, res) => {
  try {
    // Optimistic concurrency: if the client sent `version`, only accept the
    // update when the server-side version still matches. Increments on
    // success so the next read returns the new version. If the version
    // doesn't match (someone else wrote first), return 409 with the
    // current server doc — client refetches + merges.
    const { version: clientVersion, ...updates } = req.body || {};
    if (typeof clientVersion === 'number') {
      const filter = { _id: req.params.id, ashaId: req.user.id, version: clientVersion };
      const patient = await Patient.findOneAndUpdate(
        filter,
        { ...updates, $inc: { version: 1 } },
        { new: true },
      );
      if (!patient) {
        const current = await Patient.findOne({ _id: req.params.id, ashaId: req.user.id });
        if (!current) return res.status(404).json({ success: false, message: 'Not found' });
        return res.status(409).json({
          success: false,
          message: 'Version conflict — patient was modified by another writer.',
          current: toClient(current),
        });
      }
      return res.json({ success: true, data: toClient(patient) });
    }
    // Legacy path (no version) — increments anyway so older clients still cooperate.
    const patient = await Patient.findOneAndUpdate(
      { _id: req.params.id, ashaId: req.user.id },
      { ...updates, $inc: { version: 1 } },
      { new: true }
    );
    if (!patient) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: toClient(patient) });
  } catch (err) {
    // Editing a patient's name+mobile to match another existing patient's
    // (ashaId, name, mobile) tuple hits the unique compound index. Return a
    // friendly 409 instead of a generic 500 so the client can show "a patient
    // with this name and mobile already exists" rather than a server error.
    if (err && err.code === 11000) {
      return res.status(409).json({
        success: false,
        code: 'DUPLICATE_NAME_MOBILE',
        message: 'A patient with this name and mobile number already exists in your list.',
      });
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/patients/:id', auth, async (req, res) => {
  try {
    await Patient.findOneAndDelete({ _id: req.params.id, ashaId: req.user.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Reports ───────────────────────────────────────────────────────────────────

// Re-point reports from a stale local-placeholder patientId (`p_<ts>` etc.)
// to the canonical server _id. Called by the Flutter client immediately
// after the patient's local id is swapped for its server _id — closes the
// brief window where a triage was completed before savePatient returned.
// Scoped to the calling ASHA's reports for security.
app.patch('/api/reports/repoint', auth, async (req, res) => {
  try {
    const { oldPatientId, newPatientId } = req.body || {};
    if (!oldPatientId || !newPatientId) {
      return res.status(400).json({ success: false, message: 'oldPatientId + newPatientId required' });
    }
    if (oldPatientId === newPatientId) {
      return res.json({ success: true, modifiedCount: 0 });
    }
    const result = await Report.updateMany(
      { ashaId: req.user.id, patientId: oldPatientId },
      { $set: { patientId: newPatientId } },
    );
    res.json({ success: true, modifiedCount: result.modifiedCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Attach a patient to an existing (anonymous) report. Used for the
// 'urgent triage → fill in patient details later' flow on the worker's
// Reports tab: an ASHA can run a quick anonymous triage during an
// emergency, save the result, then later open the report and link it to
// the actual patient they later identified or registered.
//
// Restricted to the calling ASHA's reports (ashaId scoped). Only the
// patientId, patientName, and patientType fields are updatable here —
// the triage data itself is immutable per clinical-record principles.
app.patch('/api/reports/:id/attach-patient', auth, async (req, res) => {
  try {
    const { patientId, patientName, patientType } = req.body || {};
    if (!patientId && !patientName) {
      return res.status(400).json({
        success: false,
        message: 'patientId or patientName required',
      });
    }
    const updates = {};
    if (patientId   !== undefined) updates.patientId   = patientId;
    if (patientName !== undefined) updates.patientName = patientName;
    if (patientType !== undefined) updates.caseType    = patientType;
    const report = await Report.findOneAndUpdate(
      { _id: req.params.id, ashaId: req.user.id },
      updates,
      { new: true },
    );
    if (!report) return res.status(404).json({ success: false, message: 'Report not found' });
    res.json({ success: true, data: toClient(report) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/reports', auth, async (req, res) => {
  try {
    const report = await Report.create({ ...req.body, ashaId: req.user.id });
    // ── Notification triggers ──────────────────────────────────────────────
    const band       = (report.finalBand || '').toUpperCase();
    const patientStr = report.patientName?.trim() || 'অজ্ঞাত রোগী';
    const caseLabel  = report.caseLabel || report.caseType || '';
    const data       = { reportId: report._id.toString(), patientId: report.patientId || '' };

    if (band === 'RED') {
      // Worker — emergency confirmation
      notifyUser({
        recipientId: req.user.id,
        type: 'red_band',
        title: 'জরুরি কেস সংরক্ষিত',
        body:  '$caseLabel — এখনই রেফার করুন। 108 কল করুন।'
                 .replace('$caseLabel', caseLabel),
        link: '/reports',
        data,
      });
      // All admins — high-priority alert
      notifyAllAdmins({
        type: 'red_band',
        title: 'RED band case reported',
        body:  `${patientStr} · ${caseLabel}`,
        link: '/admin/reports',
        data,
      });
    } else if (band === 'YELLOW') {
      notifyUser({
        recipientId: req.user.id,
        type: 'yellow_band',
        title: 'ফলো-আপ দরকার',
        body:  '$caseLabel — ২৪ ঘণ্টার মধ্যে PHC-তে রেফার করুন।'
                 .replace('$caseLabel', caseLabel),
        link: '/reports',
        data,
      });
    }
    res.status(201).json({ success: true, data: toClient(report) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Notifications API ─────────────────────────────────────────────────────────

// List the current user's notifications. Newest first. Default limit 50.
app.get('/api/notifications', auth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const [items, unreadCount] = await Promise.all([
      Notification.find({ recipientId: req.user.id })
        .sort({ createdAt: -1 })
        .limit(limit),
      Notification.countDocuments({ recipientId: req.user.id, read: false }),
    ]);
    res.json({ success: true, data: items.map(toClient), unreadCount });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch('/api/notifications/:id/read', auth, async (req, res) => {
  try {
    await Notification.updateOne(
      { _id: req.params.id, recipientId: req.user.id },
      { read: true },
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch('/api/notifications/read-all', auth, async (req, res) => {
  try {
    await Notification.updateMany(
      { recipientId: req.user.id, read: false },
      { read: true },
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/notifications/:id', auth, async (req, res) => {
  try {
    await Notification.deleteOne({ _id: req.params.id, recipientId: req.user.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/reports', auth, async (req, res) => {
  try {
    const reports = await Report.find({ ashaId: req.user.id }).sort({ createdAt: -1 });
    res.json({ success: true, data: reports.map(toClient) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── User profile ─────────────────────────────────────────────────────────────

app.put('/api/users/:id', auth, async (req, res) => {
  try {
    if (req.user.id !== req.params.id)
      return res.status(403).json({ success: false, message: 'Forbidden' });
    const allowed = ['name', 'block', 'district'];
    const update  = {};
    allowed.forEach(k => { if (req.body[k] !== undefined) update[k] = req.body[k]; });
    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, data: toClient(user) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Admin ─────────────────────────────────────────────────────────────────────

app.get('/api/admin/workers', auth, adminOnly, async (req, res) => {
  try {
    const workers = await User.find({
      $or: [{ isAdmin: false }, { isAdmin: { $exists: false } }, { role: 'asha_worker' }]
    }).select('-otp -otpExpiry');
    res.json({ success: true, data: workers.map(toClient) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/workers', auth, adminOnly, async (req, res) => {
  try {
    const worker = await User.create({ ...req.body, isAdmin: false });
    notifyUser({
      recipientId: worker._id,
      type: 'welcome',
      title: 'আশামিত্রে স্বাগতম, দিদি',
      body:  'আপনি এখন রোগী যোগ করতে ও ভয়েস ট্রায়াজ শুরু করতে পারেন।',
      link:  '/home',
    });
    res.status(201).json({ success: true, data: toClient(worker) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch('/api/admin/workers/:id/deactivate', auth, adminOnly, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, { isActive: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch('/api/admin/workers/:id/activate', auth, adminOnly, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.id, { isActive: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/reports', auth, adminOnly, async (req, res) => {
  try {
    const filter = {};
    // Band filter
    if (req.query.band) filter.finalBand = req.query.band.toUpperCase();
    // Date filters
    if (req.query.date) {
      const d = new Date(req.query.date);
      filter.createdAt = { $gte: d, $lt: new Date(d.getTime() + 86400000) };
    } else if (req.query.month) {
      const [year, month] = req.query.month.split('-').map(Number);
      const start = new Date(year, month - 1, 1);
      const end   = new Date(year, month, 1);
      filter.createdAt = { $gte: start, $lt: end };
    } else if (req.query.year) {
      const year  = Number(req.query.year);
      const start = new Date(year, 0, 1);
      const end   = new Date(year + 1, 0, 1);
      filter.createdAt = { $gte: start, $lt: end };
    }

    // ── Worker / district / block filters ─────────────────────────────────
    // `worker` is an exact ashaId. `district` / `block` are case-insensitive
    // matches against the User collection; we look up the matching ashaIds
    // first, then scope reports to those workers. Combined with band/date
    // filters via $and-like merge.
    if (req.query.worker) {
      filter.ashaId = req.query.worker;
    } else if (req.query.district || req.query.block) {
      const workerFilter = {};
      if (req.query.district) {
        workerFilter.district = { $regex: `^${escapeRegex(req.query.district)}$`, $options: 'i' };
      }
      if (req.query.block) {
        workerFilter.block = { $regex: `^${escapeRegex(req.query.block)}$`, $options: 'i' };
      }
      const workers = await User.find(workerFilter).select('_id');
      const ids = workers.map(w => w._id);
      // If no workers match, scope to empty set (no reports) rather than ignoring filter
      filter.ashaId = ids.length ? { $in: ids } : null;
    }

    const reports = await Report.find(filter).sort({ createdAt: -1 });
    res.json({ success: true, data: reports.map(toClient) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Distinct districts and blocks (for admin filter dropdown population) ─────
app.get('/api/admin/locations', auth, adminOnly, async (_req, res) => {
  try {
    const [districts, blocks] = await Promise.all([
      User.distinct('district', { district: { $nin: [null, ''] } }),
      User.distinct('block',    { block:    { $nin: [null, ''] } }),
    ]);
    res.json({ success: true, data: { districts: districts.sort(), blocks: blocks.sort() } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/stats', auth, adminOnly, async (req, res) => {
  try {
    const workerQuery = { $or: [{ isAdmin: false }, { role: 'asha_worker' }], isActive: true };
    const [totalWorkers, totalPatients, totalReports, redReports, yellowReports, greenReports] = await Promise.all([
      User.countDocuments(workerQuery),
      Patient.countDocuments(),
      Report.countDocuments(),
      Report.countDocuments({ finalBand: 'RED' }),
      Report.countDocuments({ finalBand: 'YELLOW' }),
      Report.countDocuments({ finalBand: 'GREEN' }),
    ]);
    res.json({ success: true, data: { totalWorkers, totalPatients, totalReports, redReports, yellowReports, greenReports } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Admin — per-worker data ───────────────────────────────────────────────────

app.get('/api/admin/workers/:id/patients', auth, adminOnly, async (req, res) => {
  try {
    const patients = await Patient.find({ ashaId: req.params.id }).sort({ createdAt: -1 });
    res.json({ success: true, data: patients.map(toClient) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/workers/:id/reports', auth, adminOnly, async (req, res) => {
  try {
    const reports = await Report.find({ ashaId: req.params.id }).sort({ createdAt: -1 });
    res.json({ success: true, data: reports.map(toClient) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/workers/:id/profile', auth, adminOnly, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-otp -otpExpiry');
    if (!user) return res.status(404).json({ success: false, message: 'Worker not found' });
    res.json({ success: true, data: toClient(user) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── TTS Proxy (Google Cloud — Chirp3-HD Bengali Leda voice) ─────────────────
// Key stays server-side. Flutter calls this endpoint, never Google directly.
// Returns raw MP3 bytes so Flutter can play + cache on device.
const { google: googleApis } = require('googleapis');
const ttsClient = process.env.GOOGLE_TTS_API_KEY
  ? googleApis.texttospeech({ version: 'v1', auth: process.env.GOOGLE_TTS_API_KEY })
  : null;

// Chirp3-HD voices do NOT accept `pitch` (Google controls prosody internally).
// We vary tone purely via speakingRate — empathy slows down, emergency speeds up.
const TTS_TONE_PROFILES = {
  normal:    { rate: 1.00 },
  empathy:   { rate: 0.90 },
  urgent:    { rate: 1.15 },
  emergency: { rate: 1.25 },
  positive:  { rate: 0.96 },
  question:  { rate: 0.92 },
};

function ttsToSsml(text) {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<speak>${esc
    .replace(/।/g, '।<break time="350ms"/>')
    .replace(/\?/g, '?<break time="450ms"/>')
    .replace(/,/g, ',<break time="180ms"/>')}</speak>`;
}

// Shared synth helper — used by both /api/tts (raw MP3) and
// /api/chat-with-voice (base64 in JSON). Returns a Buffer or throws.
async function synthesizeTts(text, tone = 'normal') {
  if (!ttsClient) throw new Error('TTS not configured');
  const p = TTS_TONE_PROFILES[tone] || TTS_TONE_PROFILES.normal;
  const response = await ttsClient.text.synthesize({
    requestBody: {
      input: { ssml: ttsToSsml(text.trim()) },
      voice: {
        languageCode: 'bn-IN',
        name: process.env.GOOGLE_TTS_VOICE || 'bn-IN-Chirp3-HD-Kore',
      },
      audioConfig: {
        audioEncoding: 'MP3',
        speakingRate: p.rate,
        sampleRateHertz: 24000,
        effectsProfileId: ['handset-class-device'],
      },
    },
  });
  return Buffer.from(response.data.audioContent, 'base64');
}

app.post('/api/tts', async (req, res) => {
  try {
    const { text, tone = 'normal' } = req.body;
    if (!text || text.trim().length === 0)
      return res.status(400).json({ success: false, message: 'text required' });
    if (text.length > 2000)
      return res.status(400).json({ success: false, message: 'text too long' });
    if (!ttsClient)
      return res.status(503).json({ success: false, message: 'TTS not configured' });

    const audioBytes = await synthesizeTts(text.trim(), tone);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBytes.length);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(audioBytes);
  } catch (err) {
    console.error('[TTS] Google Cloud error:', err.message);
    res.status(502).json({ success: false, message: 'TTS provider error', detail: err.message });
  }
});

// ── AI Chat Proxy (Groq primary, Gemini key-rotation fallback) ───────────────
const geminiKeys = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
].filter(Boolean);
let geminiKeyIndex = 0;

async function callGemini(prompt) {
  const total = geminiKeys.length;
  for (let attempt = 0; attempt < total; attempt++) {
    const key = geminiKeys[geminiKeyIndex % total];
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 800 },
        }),
      }
    );
    const data = await res.json();
    if (res.ok) return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    // quota exhausted on this key — rotate to next
    console.warn(`[Gemini] key ${geminiKeyIndex % total} failed (${res.status}), rotating...`);
    geminiKeyIndex++;
  }
  throw new Error('All Gemini keys exhausted');
}

// Cache key version — bump to invalidate the entire cache (e.g. on model change).
const AI_CACHE_VERSION = 'v1';
function aiCacheKey(prompt) {
  return AI_CACHE_VERSION + ':' + crypto
    .createHash('sha1')
    .update(prompt.trim().toLowerCase().replace(/\s+/g, ' '))
    .digest('hex');
}

// Returns { text, provider, cached } — shared by /api/chat and
// /api/chat-with-voice so the LLM/cache logic stays in one place.
async function resolveChatReply(prompt, skipCache) {
  const key = aiCacheKey(prompt);
  if (!skipCache) {
    const hit = await AiCache.findOne({ key });
    if (hit) {
      AiCache.updateOne({ _id: hit._id }, { $inc: { hits: 1 }, $set: { lastUsedAt: new Date() } }).catch(() => {});
      return { text: hit.text, provider: hit.provider, cached: true };
    }
  }
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 800,
      }),
    });
    const groqData = await groqRes.json();
    if (groqRes.ok) {
      const text = groqData?.choices?.[0]?.message?.content ?? '';
      if (text) await saveToAiCache(key, prompt, text, 'groq');
      return { text, provider: 'groq', cached: false };
    }
    console.warn('[Groq] failed:', groqRes.status, groqData?.error?.message);
  }
  if (geminiKeys.length === 0) throw new Error('No AI provider configured');
  const text = await callGemini(prompt);
  if (text) await saveToAiCache(key, prompt, text, 'gemini');
  return { text, provider: 'gemini', cached: false };
}

app.post('/api/chat', async (req, res) => {
  try {
    const { prompt, skipCache } = req.body;
    if (!prompt) return res.status(400).json({ success: false, message: 'prompt required' });
    const reply = await resolveChatReply(prompt, !!skipCache);
    res.json({ success: true, ...reply });
  } catch (err) {
    res.status(503).json({ success: false, message: err.message });
  }
});

// ── Combined Chat + Voice (2b) ──────────────────────────────────────────────
// Returns { text, provider, cached, audio (base64), audioMime, audioTone,
// spokenText }. One HTTP round-trip instead of two — saves ~200-500ms on
// Render and is the difference between "text shows up, then voice arrives
// a beat later" and "both land together" on weak rural signal.
//
// Body fields:
//   prompt       — LLM prompt (required)
//   skipCache    — bypass AiCache lookup (default false)
//   tone         — TTS tone (normal, empathy, urgent, emergency, ...)
//   voiceText    — exact text to speak (skips parsing; client knows best)
//   voiceField   — JSON field in LLM output to extract & speak (e.g.
//                  "spoken_response" — used by the triage conversation
//                  where LLM returns a structured object)
//
// Resolution order for what gets spoken:
//   1. voiceText if provided
//   2. JSON.parse(text)[voiceField] if voiceField provided
//   3. text itself
// If TTS synthesis fails the text response still returns (audio = null)
// so the worker is never left silent on a flaky network.
app.post('/api/chat-with-voice', async (req, res) => {
  try {
    const { prompt, skipCache, tone = 'normal', voiceText, voiceField } = req.body;
    if (!prompt) return res.status(400).json({ success: false, message: 'prompt required' });

    const reply = await resolveChatReply(prompt, !!skipCache);

    let spoken = '';
    if (voiceText && voiceText.trim()) {
      spoken = voiceText.trim();
    } else if (voiceField) {
      // LLM returns a structured JSON object (e.g. {spoken_response, ...}).
      // Strip ```json fences if present then pull the requested field.
      const raw = (reply.text || '')
        .trim()
        .replace(/^```json\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      try {
        const parsed = JSON.parse(raw);
        const v = parsed?.[voiceField];
        if (typeof v === 'string' && v.trim()) spoken = v.trim();
      } catch (_) { /* leave spoken empty → no audio, text still returns */ }
    } else {
      spoken = (reply.text || '').trim();
    }

    let audio = null;
    let audioMime = null;
    if (ttsClient && spoken && spoken.length > 0 && spoken.length <= 2000) {
      try {
        const audioBytes = await synthesizeTts(spoken, tone);
        audio = audioBytes.toString('base64');
        audioMime = 'audio/mpeg';
      } catch (e) {
        console.warn('[chat-with-voice] TTS failed (text still returned):', e.message);
      }
    }

    res.json({
      success: true,
      ...reply,
      audio,
      audioMime,
      audioTone: tone,
      spokenText: spoken || null,
    });
  } catch (err) {
    res.status(503).json({ success: false, message: err.message });
  }
});

async function saveToAiCache(key, prompt, text, provider) {
  try {
    await AiCache.findOneAndUpdate(
      { key },
      { key, prompt, text, provider, lastUsedAt: new Date(), $setOnInsert: {} },
      { upsert: true },
    );
  } catch (e) {
    console.warn('[AiCache] save failed (non-fatal):', e.message);
  }
}

// ── Helper: map Mongoose doc → plain object with id instead of _id ────────────
function toClient(doc) {
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  obj.id = obj._id.toString();
  delete obj._id;
  delete obj.__v;
  return obj;
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`AshaМітра backend running on port ${PORT}`));
