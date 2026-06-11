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
  // ── Soft-delete ────────────────────────────────────────────────────────
  // Worker-initiated deletes mark `deletedAt` instead of removing the doc.
  // Clinical records are auditable so admin still sees these via the
  // /api/admin/reports/deleted endpoint; the worker's /api/reports filters
  // them out. Undo restores by clearing the field.
  deletedAt:           { type: Date, default: null, index: true },
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
// `build` is a deploy marker — bump it on every deploy so GET /health proves
// the new code actually restarted (if the marker is stale, the auto-deploy
// pulled but did NOT restart Node — the #1 cause of "my fix isn't live").
// Also reports the chat provider order, Gemini key count, and which Mongo DB
// this process is connected to (so you can confirm patients land in the Atlas
// you're inspecting). No credentials are exposed.
app.get('/health', (_, res) => {
  const c = mongoose.connection;
  res.json({
    success: true,
    message: 'AshaMitra backend is running',
    version: '1.0.0',
    build: 'gemini-primary+bn-as-hi-fix-2026-06',
    chatPrimary: 'gemini', // resolveChatReply tries Gemini first, Groq fallback
    geminiKeys: (typeof geminiKeys !== 'undefined' && geminiKeys) ? geminiKeys.length : 0,
    db: {
      name: c && c.name ? c.name : null,
      host: c && c.host ? c.host : null,
      readyState: c ? c.readyState : -1, // 1 = connected
    },
  });
});

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
    const reports = await Report.find({
      ashaId: req.user.id,
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    }).sort({ createdAt: -1 });
    res.json({ success: true, data: reports.map(toClient) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Soft-delete a report (worker-initiated) ─────────────────────────────────
// Sets deletedAt to now instead of removing the doc — admin can still audit
// via /api/admin/reports/deleted and the worker can undo within their UI.
app.delete('/api/reports/:id', auth, async (req, res) => {
  try {
    const report = await Report.findOneAndUpdate(
      { _id: req.params.id, ashaId: req.user.id },
      { deletedAt: new Date() },
      { new: true },
    );
    if (!report) return res.status(404).json({ success: false, message: 'Report not found' });
    res.json({ success: true, data: toClient(report) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Restore a soft-deleted report ───────────────────────────────────────────
// Powers the "Undo" snackbar after a worker deletes by mistake.
app.patch('/api/reports/:id/restore', auth, async (req, res) => {
  try {
    const report = await Report.findOneAndUpdate(
      { _id: req.params.id, ashaId: req.user.id },
      { deletedAt: null },
      { new: true },
    );
    if (!report) return res.status(404).json({ success: false, message: 'Report not found' });
    res.json({ success: true, data: toClient(report) });
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
    // Soft-deleted reports are hidden from the default admin view but
    // accessible via /api/admin/reports/deleted for audit purposes.
    const filter = {
      $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
    };
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

// ── Admin audit: soft-deleted reports ───────────────────────────────────────
// Lists every report where deletedAt is set, sorted by most-recent deletion.
// Populated with worker name so admin can see who deleted what. Used by the
// admin panel's "Deleted reports" view — clinical records must be auditable.
app.get('/api/admin/reports/deleted', auth, adminOnly, async (req, res) => {
  try {
    const reports = await Report.find({ deletedAt: { $ne: null } })
      .sort({ deletedAt: -1 })
      .populate('ashaId', 'name district block');
    res.json({
      success: true,
      data: reports.map(r => {
        const obj = toClient(r);
        if (r.ashaId && typeof r.ashaId === 'object') {
          obj.ashaName     = r.ashaId.name;
          obj.ashaDistrict = r.ashaId.district;
          obj.ashaBlock    = r.ashaId.block;
          obj.ashaId       = r.ashaId._id.toString();
        }
        return obj;
      }),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Admin: restore a soft-deleted report ────────────────────────────────────
// Clears deletedAt on any report (regardless of which worker owns it).
// Distinct from the worker /api/reports/:id/restore route which is
// ashaId-scoped — admin can restore reports across workers.
app.patch('/api/admin/reports/:id/restore', auth, adminOnly, async (req, res) => {
  try {
    const report = await Report.findByIdAndUpdate(
      req.params.id,
      { deletedAt: null },
      { new: true },
    );
    if (!report) return res.status(404).json({ success: false, message: 'Report not found' });
    res.json({ success: true, data: toClient(report) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Admin: permanent (hard) delete ───────────────────────────────────────────
// Truly removes the document from the database. Only allowed on reports
// that are already soft-deleted (deletedAt is set) — that's the policy
// "audit first, then erase" so a worker's accidental delete can be
// permanent only after an admin reviews it.
app.delete('/api/admin/reports/:id/permanent', auth, adminOnly, async (req, res) => {
  try {
    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found' });
    if (!report.deletedAt) {
      return res.status(400).json({
        success: false,
        message: 'Report is not soft-deleted. Soft-delete first, then erase.',
      });
    }
    await Report.findByIdAndDelete(req.params.id);
    res.json({ success: true });
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

// ── TTS Proxy (Google Cloud — Bengali Wavenet-A, distinctly Indian) ────────
// Key stays server-side. Flutter calls this endpoint, never Google directly.
// Returns raw MP3 bytes so Flutter can play + cache on device.
const { google: googleApis } = require('googleapis');
const ttsClient = process.env.GOOGLE_TTS_API_KEY
  ? googleApis.texttospeech({ version: 'v1', auth: process.env.GOOGLE_TTS_API_KEY })
  : null;

// Chirp3-HD voices do NOT accept `pitch` (Google controls prosody internally).
// Rates pulled slightly under 1.0 — real West Bengal conversational pace is a
// touch slower than Aoede's default, and that small drop is what reads as
// "didi talking" rather than "voice assistant reading".
const TTS_TONE_PROFILES = {
  normal:    { rate: 0.94 },
  empathy:   { rate: 0.90 },
  urgent:    { rate: 1.05 },
  emergency: { rate: 1.12 },
  positive:  { rate: 0.94 },
  question:  { rate: 0.92 },
};

// ── Pronunciation normalization ──────────────────────────────────────────────
// The bn-IN voice mispronounces (or spells out wrong) the Latin acronyms,
// units, and number formats the assistant routinely produces — "BP 150/95",
// "37.5°C", "ORS", "PHC", "mg/kg". We rewrite those into Bengali script the
// voice says correctly, BEFORE building SSML, so a worker hears the term the
// way she'd say it. Runs on every TTS path (/tts + /chat-with-voice) so the
// fix is universal and the synthesized MP3 cache stores the good version.
//
// Matching notes:
//   - Latin acronyms are matched case-sensitively with \b so we never touch
//     lowercase substrings inside ordinary words (e.g. "ml" in "calmly").
//   - Compound units (mg/kg, /day) are handled before the bare-unit rules.
//   - Longer acronyms are listed before shorter ones to avoid partial hits.
const TTS_TERM_MAP = [
  // Compound units first (so the slash rule below doesn't split them)
  [/\bmg\s*\/\s*kg\b/g, ' মিলিগ্রাম প্রতি কেজি'],
  [/\b\/\s*day\b/gi, ' প্রতিদিন'],
  // Facility / programme / clinical acronyms → Bengali letter-sounds
  [/\bSNCU\b/g, 'এস এন সি ইউ'], [/\bNICU\b/g, 'এন আই সি ইউ'],
  [/\bHBNC\b/g, 'এইচ বি এন সি'], [/\bVHND\b/g, 'ভি এইচ এন ডি'],
  [/\bMDSR\b/g, 'এম ডি এস আর'], [/\bJSSK\b/g, 'জে এস এস কে'],
  [/\bPHC\b/g, 'পি এইচ সি'], [/\bCHC\b/g, 'সি এইচ সি'],
  [/\bSDH\b/g, 'এস ডি এইচ'], [/\bORS\b/g, 'ও আর এস'],
  [/\bFRU\b/g, 'এফ আর ইউ'], [/\bDH\b/g, 'ডি এইচ'],
  [/\bANC\b/g, 'এ এন সি'], [/\bPNC\b/g, 'পি এন সি'],
  [/\bANM\b/g, 'এ এন এম'], [/\bOPD\b/g, 'ও পি ডি'],
  [/\bIPD\b/g, 'আই পি ডি'], [/\bIFA\b/g, 'আই এফ এ'],
  [/\bIUD\b/g, 'আই ইউ ডি'], [/\bEDD\b/g, 'ই ডি ডি'],
  [/\bLMP\b/g, 'এল এম পি'], [/\bMCP\b/g, 'এম সি পি'],
  [/\bJSY\b/g, 'জে এস ওয়াই'], [/\bPPH\b/g, 'পি পি এইচ'],
  [/\bBP\b/g, 'বি পি'], [/\bTT\b/g, 'টি টি'],
  [/\bHb\b/g, 'হিমোগ্লোবিন'], [/\bHB\b/g, 'হিমোগ্লোবিন'],
  // Emergency dial numbers — spoken digit-by-digit so they're unambiguous
  // ("এক শূন্য আট", not "একশো আট"). Both Latin and Bengali digits, guarded
  // so they never match inside a longer number.
  [/(?<![0-9০-৯])108(?![0-9০-৯])/g, 'এক শূন্য আট'], [/(?<![0-9০-৯])১০৮(?![0-9০-৯])/g, 'এক শূন্য আট'],
  [/(?<![0-9০-৯])102(?![0-9০-৯])/g, 'এক শূন্য দুই'], [/(?<![0-9০-৯])১০২(?![0-9০-৯])/g, 'এক শূন্য দুই'],
  [/(?<![0-9০-৯])104(?![0-9০-৯])/g, 'এক শূন্য চার'], [/(?<![0-9০-৯])১০৪(?![0-9০-৯])/g, 'এক শূন্য চার'],
  // Common English domain words the bn voice garbles
  [/\bvaccination\b/gi, 'ভ্যাকসিনেশন'], [/\bvaccine\b/gi, 'ভ্যাকসিন'],
  [/\breferral\b/gi, 'রেফারেল'], [/\brefer\b/gi, 'রেফার'],
  [/\breport\b/gi, 'রিপোর্ট'], [/\bcheck\s*up\b/gi, 'চেকআপ'],
  // Units
  [/°\s*C\b/g, ' ডিগ্রি সেলসিয়াস'], [/°\s*F\b/g, ' ডিগ্রি ফারেনহাইট'],
  [/\bmg\b/g, ' মিলিগ্রাম'], [/\bml\b/g, ' মিলিলিটার'],
  [/\bkg\b/g, ' কেজি'], [/%/g, ' শতাংশ'],
];

// Hindi (Devanagari) equivalents — used when the reply is in Hindi so the
// HINDI voice says these terms naturally instead of a Bengali voice mangling
// them. Mirrors TTS_TERM_MAP but in Devanagari.
const TTS_TERM_MAP_HI = [
  [/\bmg\s*\/\s*kg\b/g, ' मिलीग्राम प्रति किलो'],
  [/\b\/\s*day\b/gi, ' प्रतिदिन'],
  [/\bSNCU\b/g, 'एस एन सी यू'], [/\bNICU\b/g, 'एन आई सी यू'],
  [/\bHBNC\b/g, 'एच बी एन सी'], [/\bMDSR\b/g, 'एम डी एस आर'],
  [/\bPHC\b/g, 'पी एच सी'], [/\bCHC\b/g, 'सी एच सी'],
  [/\bSDH\b/g, 'एस डी एच'], [/\bORS\b/g, 'ओ आर एस'],
  [/\bFRU\b/g, 'एफ आर यू'], [/\bDH\b/g, 'डी एच'],
  [/\bANC\b/g, 'ए एन सी'], [/\bPNC\b/g, 'पी एन सी'],
  [/\bANM\b/g, 'ए एन एम'], [/\bMCP\b/g, 'एम सी पी'],
  [/\bPPH\b/g, 'पी पी एच'], [/\bBP\b/g, 'बी पी'],
  [/\bHb\b/g, 'हीमोग्लोबिन'], [/\bHB\b/g, 'हीमोग्लोबिन'],
  [/(?<![0-9০-৯०-९])108(?![0-9০-৯०-९])/g, 'एक शून्य आठ'],
  [/(?<![0-9০-৯०-९])102(?![0-9০-৯०-९])/g, 'एक शून्य दो'],
  [/(?<![0-9০-৯०-९])104(?![0-9০-৯०-९])/g, 'एक शून्य चार'],
  [/\bvaccination\b/gi, 'वैक्सीनेशन'], [/\bvaccine\b/gi, 'वैक्सीन'],
  [/\breferral\b/gi, 'रेफ़रल'], [/\brefer\b/gi, 'रेफ़र'],
  [/\breport\b/gi, 'रिपोर्ट'], [/\bcheck\s*up\b/gi, 'चेकअप'],
  [/°\s*C\b/g, ' डिग्री सेल्सियस'], [/°\s*F\b/g, ' डिग्री फ़ारेनहाइट'],
  [/\bmg\b/g, ' मिलीग्राम'], [/\bml\b/g, ' मिलीलीटर'],
  [/\bkg\b/g, ' किलो'], [/%/g, ' प्रतिशत'],
];

// Per-language TTS config: voice, Google languageCode, term map, and the words
// for a number range ("X to Y") and the BP slash ("X over Y"). Hindi voice is
// env-overridable (GOOGLE_TTS_VOICE_HI) so it can be tuned without a code change.
const TTS_LANGS = {
  bn: { voice: process.env.GOOGLE_TTS_VOICE    || 'bn-IN-Wavenet-A', terms: TTS_TERM_MAP,    range: 'থেকে', slash: 'বাটা' },
  hi: { voice: process.env.GOOGLE_TTS_VOICE_HI || 'hi-IN-Neural2-A', terms: TTS_TERM_MAP_HI, range: 'से',   slash: 'बटा' },
};

// Pick the spoken language from the dominant script of the reply. Devanagari
// present → Hindi voice; otherwise Bengali voice (which also reads Indian
// English acceptably — that path is unchanged).
function detectTtsLang(text) {
  const hi = (text.match(/[ऀ-ॿ]/g) || []).length;
  const bn = (text.match(/[ঀ-৿]/g) || []).length;
  return (hi > 0 && hi >= bn) ? 'hi' : 'bn';
}

function normalizeForSpeech(text, lang = 'bn') {
  const cfg = TTS_LANGS[lang] || TTS_LANGS.bn;
  // Number ranges "X-Y" → "X <range> Y" (Bengali "থেকে" / Hindi "से") so the
  // voice doesn't read the hyphen as "minus". Includes Devanagari digits.
  // Guarded so phone numbers (1800-180-1104) and decimals (38.5-41.0) stay put.
  let t = text.replace(
    /(?<![0-9০-৯०-९.])([0-9০-৯०-९]{1,3})\s*[-–—]\s*([0-9০-৯०-९]{1,3})(?![0-9০-৯०-९.])/g,
    `$1 ${cfg.range} $2`,
  );
  // "X/Y" between digits → "X <slash> Y" (BP reading) instead of a literal slash.
  t = t.replace(/([0-9০-৯०-९])\s*\/\s*([0-9০-৯०-९])/g, `$1 ${cfg.slash} $2`);
  for (const [re, sub] of cfg.terms) t = t.replace(re, sub);
  return t.replace(/\s+/g, ' ').trim();
}

// Richer SSML so short clinical sentences don't sound staccato. The pauses
// after দণ্ড / ? / ! are the most impactful — Chirp3 otherwise runs sentences
// together. Slightly longer breaks here feel more like a human pausing to
// breathe.
//
// Commas are STRIPPED from the source text (not just break-tagged) because
// pilot listeners reported the "didi[, dadu]" pause as the most robotic
// part of the voice. Chirp3-HD already shapes prosody from sentence
// structure at clause boundaries — adding even a 200ms comma break makes
// every clause feel beat-by-beat instead of flowing. Periods, question
// marks, and the new sentence-break-on-". A" rule still give the engine
// the breath cues it needs.
function ttsToSsml(text, lang = 'bn') {
  // Pronunciation pass FIRST — turns "BP 150/95" etc. into speakable script
  // before comma-strip / escaping / break-tagging below.
  const spoken = normalizeForSpeech(text, lang);
  const cleaned = spoken.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  const esc = cleaned.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<speak>${esc
    .replace(/।\s*/g, '।<break time="500ms"/>')
    .replace(/\?\s*/g, '?<break time="580ms"/>')
    .replace(/!\s*/g, '!<break time="450ms"/>')
    .replace(/—/g, '<break time="260ms"/>—<break time="260ms"/>')
    .replace(/:\s*/g, ':<break time="260ms"/>')
    .replace(/\.\s+(?=[A-Z])/g, '.<break time="450ms"/>')}</speak>`;
}

// Plain-text (no-SSML) variant of the spoken text — normalized pronunciation
// + comma strip, but no <break> tags. Used for voices that reject SSML.
function ttsPlainText(text, lang = 'bn') {
  return normalizeForSpeech(text, lang).replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
}

// Shared synth helper — used by /api/tts, /api/chat-with-voice, and the voice
// preview. [voiceName] overrides the configured voice (for A/B previews and
// future per-language voices). Returns a Buffer or throws.
//
// All voices are bn-IN (India / West Bengal accent). Chirp3-HD voices do NOT
// accept SSML, so they get normalized PLAIN text (they shape prosody natively);
// Wavenet/Standard get the richer SSML with breath pauses. This lets us switch
// the voice freely via GOOGLE_TTS_VOICE without the SSML path breaking HD voices.
async function synthesizeTts(text, tone = 'normal', voiceName) {
  if (!ttsClient) throw new Error('TTS not configured');
  const p = TTS_TONE_PROFILES[tone] || TTS_TONE_PROFILES.normal;
  // Pick voice + languageCode + normalization from the reply's script, so
  // Hindi is read by a Hindi voice (not the Bengali one). An explicit
  // voiceName (A/B preview) still wins; its languageCode comes from its prefix.
  const lang = detectTtsLang(text);
  const name = voiceName || (TTS_LANGS[lang] || TTS_LANGS.bn).voice;
  const languageCode = /^[a-z]{2}-[A-Z]{2}/.test(name) ? name.slice(0, 5) : 'bn-IN';
  const input = /chirp/i.test(name)
    ? { text: ttsPlainText(text.trim(), lang) }
    : { ssml: ttsToSsml(text.trim(), lang) };
  const response = await ttsClient.text.synthesize({
    requestBody: {
      input,
      voice: { languageCode, name },
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

// ── Voice A/B preview ────────────────────────────────────────────────────────
// Pick the right Indian-Bengali voice by EAR: open in a phone browser
//   /api/voice-preview?voice=bn-IN-Wavenet-A
// and listen. Same sample line each time (it includes "didi", an acronym, a
// BP reading and a temperature, so tone AND pronunciation are auditioned).
// All candidates are bn-IN (India / West Bengal); voice is allowlisted so the
// query param can't be abused. Whichever you pick, set it as GOOGLE_TTS_VOICE.
const PREVIEW_VOICES = new Set([
  'bn-IN-Wavenet-A', 'bn-IN-Wavenet-C',          // female, classic
  'bn-IN-Standard-A', 'bn-IN-Standard-C',        // female, lighter
  'bn-IN-Chirp3-HD-Aoede', 'bn-IN-Chirp3-HD-Leda', 'bn-IN-Chirp3-HD-Kore', // female, HD
]);
const PREVIEW_SAMPLE =
  'নমস্কার দিদি আমি আশামিত্র। রোগীর BP ১৪০/৯০ আর জ্বর ৩৮.৫°C। এখনই PHC-তে রেফার করুন।';

app.get('/api/voice-preview', async (req, res) => {
  try {
    if (!ttsClient)
      return res.status(503).json({ success: false, message: 'TTS not configured' });
    const voice = String(req.query.voice || 'bn-IN-Wavenet-A');
    if (!PREVIEW_VOICES.has(voice))
      return res.status(400).json({
        success: false, message: 'unknown voice', allowed: [...PREVIEW_VOICES],
      });
    const text = req.query.text
      ? String(req.query.text).slice(0, 500)
      : PREVIEW_SAMPLE;
    const audioBytes = await synthesizeTts(text, 'normal', voice);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBytes.length);
    res.set('Cache-Control', 'no-store');
    res.send(audioBytes);
  } catch (err) {
    console.error('[voice-preview] error:', err.message);
    res.status(502).json({ success: false, message: 'voice failed (may be unavailable)', detail: err.message });
  }
});

// ── AI Chat Proxy (Gemini primary, Groq fallback) ────────────────────────────
// Gemini keys are picked up dynamically from any env var matching
// /^GEMINI_API_KEY(_\d+)?$/ — adding keys is an env-var change, not a
// code change:
//   GEMINI_API_KEY        ← set this to the PAID key (no daily cap → reliable)
//   GEMINI_API_KEY_2/_3…  ← optional extra (free) keys, round-robined in
// Recommended for production: ONE paid key as GEMINI_API_KEY and no free
// extras — the paid key has no daily quota, so it never fails on
// "AI at capacity", and there's nothing to rotate. (Free keys give only
// 1,500 req/day each, which is why multiple were stacked before.)
// Gemini is the PRIMARY provider — its Bengali/clinical replies follow the
// triage prompt far better than Groq's llama. Groq is the FALLBACK, hit only
// when Gemini is unavailable/rate-limited, so the app never drops to offline
// rules while online.
function loadGeminiKeys() {
  const keys = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (/^GEMINI_API_KEY(_\d+)?$/.test(name) && value && value.trim()) {
      keys.push(value.trim());
    }
  }
  return keys;
}
const geminiKeys = loadGeminiKeys();
console.log(`[Gemini] loaded ${geminiKeys.length} key(s)`);
let geminiKeyIndex = 0;

// Tracks keys temporarily benched after a 429/403 so we don't keep hammering
// a rate-limited / quota-dead key. Each entry: keyIndex → epoch ms until
// which it's benched.
const keyDeadUntil = new Map();
// Bench duration after a 429/403. Deliberately SHORT: a transient rate limit
// (the common case for a single PAID key) recovers in minutes; a genuinely
// quota-dead free key just re-benches on its next turn — Groq (primary) and
// the AiCache absorb the occasional retry. Was 24h, which would have
// disabled a lone paid fallback key for a whole day on one transient 429.
const KEY_BENCH_MS = 15 * 60 * 1000;

async function callGemini(prompt) {
  const total = geminiKeys.length;
  if (total === 0) throw new Error('No Gemini keys configured');
  let lastStatus = 0;

  // gemini-2.5-flash (override via GEMINI_MODEL). NOTE: 2.5 models enable
  // "thinking" by default, and those reasoning tokens are drawn from the SAME
  // maxOutputTokens budget — which was truncating these short replies
  // mid-sentence (the visible answer ran out of budget after thinking). We
  // disable thinking (thinkingBudget: 0) for 2.5 models so the full budget
  // goes to the actual reply, and raise the cap for headroom.
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const genConfig = { temperature: 0.2, maxOutputTokens: 1024 };
  if (/2\.5/.test(model)) genConfig.thinkingConfig = { thinkingBudget: 0 };

  const tryKey = async (idx) => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKeys[idx]}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: genConfig,
        }),
      }
    );
    if (res.ok) {
      const data = await res.json();
      keyDeadUntil.delete(idx); // it works → un-bench
      return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    }
    lastStatus = res.status;
    if (res.status === 429 || res.status === 403) {
      keyDeadUntil.set(idx, Date.now() + KEY_BENCH_MS);
      console.warn(`[Gemini] key #${idx} rate/quota (${res.status}), benched ${KEY_BENCH_MS / 60000}m`);
    } else {
      console.warn(`[Gemini] key #${idx} failed (${res.status}), rotating`);
    }
    return null;
  };

  // Pass 1: round-robin over keys that aren't currently benched.
  let attempted = false;
  for (let i = 0; i < total; i++) {
    const idx = geminiKeyIndex % total;
    geminiKeyIndex++;
    const benchedUntil = keyDeadUntil.get(idx);
    if (benchedUntil && Date.now() < benchedUntil) continue;
    attempted = true;
    const text = await tryKey(idx);
    if (text !== null) return text;
  }
  // Pass 2: every key was already benched from earlier calls (we made no
  // request above) — force one attempt ignoring the bench, so a lone paid
  // fallback key is never left dark waiting out a stale bench.
  if (!attempted) {
    const idx = geminiKeyIndex % total;
    geminiKeyIndex++;
    const text = await tryKey(idx);
    if (text !== null) return text;
  }
  // Distinguish "all keys are quota-dead" from generic failures so the
  // client can show a specific message instead of generic "server slow".
  const e = new Error('All Gemini keys exhausted');
  e.code = lastStatus === 429 || lastStatus === 403 ? 'AI_QUOTA' : 'AI_FAIL';
  throw e;
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
  // ── Primary: Gemini (paid key — best Bengali/clinical quality) ──
  // A thrown/empty Gemini result falls through to Groq below so a hiccup or
  // rate-limit never drops triage to the client's offline rules.
  if (geminiKeys.length > 0) {
    try {
      const text = await callGemini(prompt);
      if (text) {
        await saveToAiCache(key, prompt, text, 'gemini');
        return { text, provider: 'gemini', cached: false };
      }
      console.warn('[Gemini] primary returned empty, falling back to Groq');
    } catch (err) {
      console.warn('[Gemini] primary failed, falling back to Groq:', err.message);
    }
  }
  // ── Fallback: Groq ──
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
    console.warn('[Groq] fallback failed:', groqRes.status, groqData?.error?.message);
  }
  throw new Error('No AI provider available (Gemini + Groq both failed)');
}

app.post('/api/chat', async (req, res) => {
  try {
    const { prompt, skipCache } = req.body;
    if (!prompt) return res.status(400).json({ success: false, message: 'prompt required' });
    const reply = await resolveChatReply(prompt, !!skipCache);
    res.json({ success: true, ...reply });
  } catch (err) {
    res.status(503).json({
      success: false,
      message: err.message,
      errorCode: err.code || 'SERVER_ERROR',
    });
  }
});

// ── Case detection (triage situation → case classifier) ──────────────────────
// Moved server-side so the Gemini key never ships inside the APK. The Flutter
// client used to call Google directly with a hardcoded key (trivially
// extractable from the binary); now it POSTs the transcript + the case list
// and we run the SAME low-temperature classification through the rotating
// Gemini keys. Rule-based detection still runs client-side first — this
// endpoint is only hit for the ambiguous-confidence fallback, and the client
// falls back to its rule result if this call fails, so a 5xx here degrades
// gracefully and never blocks triage.
//
// Body: { transcript: string, cases: [{ id, titleEn }] }
// Returns: { success, caseId, confidence }
app.post('/api/detect-case', async (req, res) => {
  try {
    const { transcript, cases } = req.body;
    if (!transcript || !Array.isArray(cases) || cases.length === 0) {
      return res.status(400).json({ success: false, message: 'transcript and cases[] required' });
    }
    const ids = cases.map((c) => c && c.id).filter(Boolean);
    const caseList = cases
      .map((c) => `${c.id}: ${c.titleEn || c.title || ''}`)
      .join('\n');
    // Prompt kept byte-for-byte equivalent to the old client-side prompt so
    // classification behaviour is unchanged — only WHERE Gemini is called moved.
    const prompt = `You are a medical triage classifier for ASHA workers in rural India.
Given the following speech transcript, classify it into exactly one case type.

Available cases:
${caseList}

Transcript: "${transcript}"

Respond with ONLY a JSON object like:
{"caseId": "pregnancy", "confidence": 0.95}

Rules:
- caseId must be one of: ${ids.join(', ')}
- confidence must be between 0.0 and 1.0
- No explanation, no markdown, just the JSON object`;

    const raw = await callGemini(prompt);
    const cleaned = (raw || '')
      .trim()
      .replace(/```json/g, '')
      .replace(/```/g, '')
      .trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (_) {
      return res.status(502).json({ success: false, message: 'AI returned unparseable output' });
    }
    const caseId = typeof parsed.caseId === 'string' ? parsed.caseId : null;
    let confidence = typeof parsed.confidence === 'number' ? parsed.confidence : null;
    if (!caseId || confidence === null || !ids.includes(caseId)) {
      return res.status(502).json({ success: false, message: 'AI returned an invalid case' });
    }
    confidence = Math.max(0, Math.min(1, confidence)); // clamp to [0,1]
    res.json({ success: true, caseId, confidence });
  } catch (err) {
    res.status(503).json({
      success: false,
      message: err.message,
      errorCode: err.code || 'SERVER_ERROR',
    });
  }
});

// Robustly pull the speakable text out of an LLM reply that may be pure JSON,
// prose-then-JSON, fenced JSON, TRUNCATED JSON (no closing brace), or plain
// prose. Regex-first on the field itself: this is the only approach that
// survives a cut-off reply like `{"spoken_text":"…",` (missing the closing
// `}`) — a balanced-brace scan fails there and dumps raw JSON to the worker
// (and speaks it). ALWAYS returns something speakable so the combined
// endpoint never comes back silent.
function extractSpokenText(text, voiceField) {
  const t = (text || '').trim();
  if (!t) return '';
  // 1. Direct field extraction — works for valid, fenced, prose-wrapped, AND
  //    truncated JSON (incl. cut off MID-value, with no closing quote). The
  //    NO trailing-quote pattern: capture the value up to the closing quote
  //    if present, else to end-of-string. Handles escaped quotes/backslashes.
  const m = t.match(
    new RegExp('"' + voiceField + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)'),
  );
  if (m && m[1].trim()) {
    return m[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, ' ')
      .replace(/\\\\/g, '\\')
      .trim();
  }
  // 2. No such field → it's plain prose; strip any JSON block (closed or not)
  //    and speak the prose.
  return t.replace(/\{[\s\S]*\}?\s*$/m, '').trim() || t;
}

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
      // Robust extraction (pure JSON / prose+JSON / fenced / plain prose) —
      // always yields something speakable so we never return silent audio.
      spoken = extractSpokenText(reply.text, voiceField);
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
    res.status(503).json({
      success: false,
      message: err.message,
      errorCode: err.code || 'SERVER_ERROR',
    });
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

// ── Groq Whisper transcription proxy ────────────────────────────────────────
// The Flutter assistant + triage flows record raw audio (because the
// Android SpeechRecognizer plugin proved unreliable on Infinix HiOS —
// an audio session race between turns left the mic stuck) and POST it
// here as multipart/form-data with field name "audio". We forward the
// bytes to Groq's whisper-large-v3-turbo, which has excellent Bengali
// support and consistently returns in ~500 ms - 2 s.
//
// Key stays server-side (GROQ_API_KEY) so it never ships in the APK.
// Falls through with 503 if no key, so the client knows to use its
// device-STT fallback. Returns plain { success, text } on success.
//
// Body parsing:
//   We can't use express.json() for multipart — instead we accept the
//   audio as a raw Buffer up to 10 MB (an average ASHA-worker utterance
//   at 64 kbps Opus is well under 200 KB, 10 MB is generous headroom)
//   in a separate express.raw() middleware mounted just on this route.
const audioRawParser = express.raw({
  type: () => true, // any content-type — client may send audio/m4a, audio/webm, etc.
  limit: '10mb',
});

// One Groq Whisper transcription. `language` null → auto-detect, else pinned
// (ISO-639-1, e.g. 'bn'). Always verbose_json so we learn the detected language.
// Throws Error('groq_failed') with .status/.detail on a non-2xx from Groq.
async function groqTranscribe(key, bytes, contentType, ext, language) {
  const form = new FormData();
  const blob = new Blob([bytes], { type: contentType || 'audio/m4a' });
  form.append('file', blob, `audio.${ext}`);
  form.append('model', 'whisper-large-v3-turbo');
  if (language) form.append('language', language);
  form.append('response_format', 'verbose_json');
  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}` },
    body: form,
  });
  if (!resp.ok) {
    const err = new Error('groq_failed');
    err.status = resp.status;
    err.detail = (await resp.text()).slice(0, 200);
    throw err;
  }
  return resp.json();
}

// Whisper sometimes mis-detects spoken Bengali as Hindi and transcribes the
// Bengali WORDS phonetically in Devanagari script — so a West-Bengal worker
// speaking Bengali sees their sentence in हिन्दी letters. These multi-character
// sequences are distinctive to Bengali (verb endings -ছেন/-বেন/-য়েছে, the
// words সেটা/এটা/এখন, pronouns আমি/তুমি/আপনি, possessive জলের …) and essentially
// never appear in genuine Hindi. We require ≥2 distinct hits so a coincidental
// single match (e.g. अच्छे) can't flip real Hindi to Bengali.
const BENGALI_IN_DEVANAGARI_MARKERS = [
  'छेन', 'बेन', 'येछे', 'येछ', 'छिलो', 'कोरछि', 'कोरबे', 'होयेछे', 'होछे', 'हछे',
  'आमि', 'आमी', 'आमार', 'तुमि', 'आपनि', 'केमोन', 'होबे', 'हबे', 'जोलेर', 'जोल',
  'दिदि', 'शेटा', 'सेटा', 'एटा', 'एखोन', 'कोतो', 'किछु', 'नेबेन', 'देबेन', 'खेयेछ',
];
function looksLikeBengaliInDevanagari(text) {
  if (!text) return false;
  let hits = 0;
  for (const m of BENGALI_IN_DEVANAGARI_MARKERS) {
    if (text.includes(m) && ++hits >= 2) return true;
  }
  return false;
}

app.post('/api/transcribe', audioRawParser, async (req, res) => {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return res.status(503).json({ success: false, message: 'transcribe_not_configured' });
  }
  if (!req.body || req.body.length === 0) {
    return res.status(400).json({ success: false, message: 'no_audio' });
  }
  try {
    const lang = (req.query.lang || 'bn').toString();
    // The recording on the client uses Opus in WebM container or AAC in m4a —
    // either way Groq/Whisper auto-detects. Filename's extension carries the hint.
    const ext = (req.query.ext || 'm4a').toString().replace(/[^a-z0-9]/gi, '');
    const ctype = req.headers['content-type'] || 'audio/m4a';
    // lang='auto' (or empty) → let Whisper auto-detect the spoken language, so a
    // worker can speak Bengali/Hindi/English and it's transcribed in the right
    // script. Otherwise pin the language.
    const wantAuto = !lang || lang === 'auto';

    let data = await groqTranscribe(key, req.body, ctype, ext, wantAuto ? null : lang);
    let text = (data.text || '').trim();
    let language = data.language || null;

    // Bengali-as-Hindi correction (auto-detect only): Whisper called it Hindi
    // but the text is clearly Bengali rendered in Devanagari. Re-transcribe the
    // same audio forcing Bengali so the worker gets proper Bengali script — and
    // the app's session language, reply and voice all follow Bengali downstream.
    if (wantAuto && language === 'hindi' && looksLikeBengaliInDevanagari(text)) {
      try {
        const bn = await groqTranscribe(key, req.body, ctype, ext, 'bn');
        const bnText = (bn.text || '').trim();
        if (bnText) { text = bnText; language = 'bengali'; }
      } catch (e) {
        console.warn('[transcribe] bn re-transcribe failed:', e.message);
      }
    }

    res.json({ success: true, text, language });
  } catch (e) {
    if (e.message === 'groq_failed') {
      console.warn('[transcribe] Groq error:', e.status, e.detail);
      return res.status(502).json({
        success: false, message: 'groq_failed', status: e.status, detail: e.detail,
      });
    }
    console.error('[transcribe]', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Google Directions proxy ──────────────────────────────────────────────────
// The Flutter referral map calls this endpoint to get road-routed
// directions from the worker to a referral facility. We go through the
// backend (rather than letting the client call Google directly) for two
// reasons:
//   1. The API key stays server-side. Embedding it in the APK would
//      let anyone with the APK make calls on our billing account.
//   2. We can swap providers (OSRM, Mapbox, Google) here without
//      reshipping the app.
//
// Falls through with 503 if no GOOGLE_DIRECTIONS_API_KEY is set, so the
// client knows to use its public-OSRM fallback. We accept the existing
// GOOGLE_TTS_API_KEY as the default since most setups use one project
// for the whole Google Cloud surface.
//
// Response shape (kept as flat / minimal as possible):
//   { points: [[lat,lng], ...], distanceM, durationS, durationInTrafficS }
function _decodeGooglePolyline(encoded) {
  // Google's encoded-polyline algorithm. Returns an array of [lat,lng]
  // tuples. Standard implementation — see
  // https://developers.google.com/maps/documentation/utilities/polylinealgorithm
  const points = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;
    shift = 0; result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

app.get('/api/directions', async (req, res) => {
  const key = process.env.GOOGLE_DIRECTIONS_API_KEY ||
              process.env.GOOGLE_TTS_API_KEY;
  if (!key) {
    return res.status(503).json({ success: false, message: 'directions_not_configured' });
  }
  const { olat, olng, dlat, dlng } = req.query;
  if (!olat || !olng || !dlat || !dlng) {
    return res.status(400).json({ success: false, message: 'missing_coords' });
  }
  try {
    // departure_time=now requests live-traffic duration on top of the
    // free duration estimate. Worth doing for emergency referrals
    // where rush-hour can double the realistic travel time.
    const url = 'https://maps.googleapis.com/maps/api/directions/json' +
      `?origin=${encodeURIComponent(olat + ',' + olng)}` +
      `&destination=${encodeURIComponent(dlat + ',' + dlng)}` +
      '&mode=driving&departure_time=now' +
      `&key=${key}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== 'OK' || !Array.isArray(data.routes) || data.routes.length === 0) {
      return res.status(404).json({ success: false, message: 'no_route', google_status: data.status });
    }
    const route = data.routes[0];
    const leg = route.legs && route.legs[0];
    if (!leg) {
      return res.status(404).json({ success: false, message: 'no_leg' });
    }
    const points = _decodeGooglePolyline(route.overview_polyline.points);
    res.json({
      success: true,
      points,
      distanceM: leg.distance && leg.distance.value,
      durationS: leg.duration && leg.duration.value,
      durationInTrafficS: leg.duration_in_traffic ? leg.duration_in_traffic.value : (leg.duration && leg.duration.value),
    });
  } catch (e) {
    console.error('[directions]', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`AshaМітра backend running on port ${PORT}`));
