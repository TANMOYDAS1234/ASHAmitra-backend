require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const zlib     = require('zlib');
// Optional on-device-on-VPS OCR for Aadhaar autofill. Loaded lazily so the
// server still boots if the package / tesseract binary isn't installed yet.
let tesseract = null;
try { tesseract = require('node-tesseract-ocr'); } catch (_) { /* install: npm i node-tesseract-ocr + apt install tesseract-ocr */ }
// QR-based Aadhaar autofill (preferred — UIDAI-signed, far more accurate than
// OCR). Lazy so the server boots even before `npm install jimp jsqr`.
let Jimp = null, jsQR = null;
try { Jimp = require('jimp'); jsQR = require('jsqr'); } catch (_) { /* install: npm i jimp jsqr */ }

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// ── Atlas connection ──────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI)
  .then(() => { console.log('MongoDB Atlas connected'); migrateHierarchy(); })
  .catch(err => { console.error('Atlas connection error:', err.message); process.exit(1); });

// One-time, idempotent: fold the legacy flat admin into the supervisor tree so
// scoped queries work. The single pilot admin becomes an ANM; every ASHA with
// no supervisor is placed under her. Safe to re-run on every boot.
async function migrateHierarchy() {
  try {
    await User.updateMany(
      { isAdmin: true, $or: [{ role: { $exists: false } }, { role: null }, { role: 'asha_worker' }] },
      { $set: { role: 'anm' } });
    await User.updateMany(
      { isAdmin: { $ne: true }, $or: [{ role: { $exists: false } }, { role: null }] },
      { $set: { role: 'asha_worker' } });
    const anm = await User.findOne({ role: 'anm' }).select('_id');
    if (anm) {
      const r = await User.updateMany(
        { role: 'asha_worker', $or: [{ supervisorId: null }, { supervisorId: { $exists: false } }] },
        { $set: { supervisorId: anm._id } });
      console.log(`Hierarchy migration ok — ${r.modifiedCount ?? 0} ASHAs linked under ANM ${anm._id}`);
    }
  } catch (e) {
    console.error('Hierarchy migration failed:', e.message);
  }
}

// ── Supervisory hierarchy: asha_worker < anm < bmho < cmho ───────────────────
// Each supervisor owns the people directly below them via `supervisorId`, so a
// query can scope precisely to "my subtree". The legacy flat admin maps to anm.
const ROLES      = ['asha_worker', 'anm', 'bmho', 'cmho'];
const CHILD_ROLE = { cmho: 'bmho', bmho: 'anm', anm: 'asha_worker' }; // level each role creates
const effectiveRole = (u) => u.role || (u.isAdmin ? 'anm' : 'asha_worker');

// ── Schemas ───────────────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  phone:            { type: String, required: true, unique: true },
  name:             { type: String, default: '' },
  role:             { type: String, enum: ROLES, default: 'asha_worker' },
  supervisorId:     { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  subCentre:        { type: String, default: '' },
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
  // Demographics — REQUIRED in the schema or Mongoose strips them on save
  // (strict mode), losing them on every server round-trip / syncFromServer.
  age:       { type: String, default: '' },
  ageUnit:   { type: String, default: 'years' },
  gender:    { type: String, default: '' },
  lastVisit: { type: String, default: '' },
  risk:      { type: String, default: 'safe' },
  situation: String,
  outcome:   String,
  reason:    String,
  nextStep:  String,
  qaHistory: { type: Array, default: [] },
  // ── Maternal & child tracking (MCP-card aligned) ─────────────────────────
  // Dates are the keystone: ANC and immunization due-dates are computed from
  // LMP (pregnancy) and DOB (child/newborn). Without these, no reminder or
  // due-list is possible. All optional so existing/quick records still save.
  dob:           { type: Date,   default: null }, // child / newborn date of birth
  lmp:           { type: Date,   default: null }, // last menstrual period (pregnancy)
  edd:           { type: Date,   default: null }, // expected delivery date (auto = lmp + 280d)
  deliveryDate:  { type: Date,   default: null }, // actual delivery date → drives PNC schedule
  guardianName:  { type: String, default: '' },   // mother's name when patient is a child
  // Aadhaar: store ONLY a masked form (e.g. "XXXX-XXXX-1234") — never the raw
  // 12-digit number (Aadhaar Act sensitivity). OCR fills name/DOB/address.
  aadhaarMasked: { type: String, default: '' },
  // Mother ↔ child linkage + multiple birth (twins).
  motherId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null },
  isTwin:        { type: Boolean, default: false },
  birthOrder:    { type: Number,  default: 0 }, // 1, 2 … within a multiple birth
  // Full MCP-card identity fields (pg 3) — father's name, address, RCH/MCTS no.,
  // PMMVY/JSY + bank, gravida, birth-registration no., Anganwadi/LGD, facility,
  // masked Aadhaar, etc. Kept as a flexible map (all optional) rather than ~27
  // columns; the registration form drives the keys.
  mcpDetails:    { type: mongoose.Schema.Types.Mixed, default: {} },
  // ── Identity / de-dup keys ───────────────────────────────────────────────
  // clientId = the client-generated local id (e.g. "p_169…"). Idempotency key:
  // a retried / re-synced POST of the SAME local record matches here and updates
  // in place instead of creating a duplicate. This is what makes the offline-
  // first sync safe now that we no longer silently merge on name+mobile (two
  // real people can share a name and a household phone — see rchId below).
  clientId:      { type: String, default: '' },
  // rchId = the RCH/MCTS government registration number ("Egiya Bangla Portal
  // ID") — the canonical real-world person key, mirrored from mcpDetails.rchId.
  // When present it identifies the same person even across re-registration.
  rchId:         { type: String, default: '' },
  // Optimistic concurrency control. Incremented on every successful update.
  // PUT requests carry the version they're updating from; if it no longer
  // matches the server's, the update is rejected 409 so the client can
  // refetch + merge instead of silently overwriting another writer.
  version:   { type: Number, default: 0 },
}, { timestamps: true });

// De-dup lookup indexes (non-unique — two real people CAN share a name+phone,
// so uniqueness is decided by the client-side "possible duplicate?" prompt, not
// the DB). These two just make the idempotency/strong-key lookups in POST fast.
patientSchema.index({ ashaId: 1, clientId: 1 });
patientSchema.index({ ashaId: 1, rchId: 1 });

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

// ── Schedule events (ANC visits, immunization, HBNC newborn home visits) ──────
// One document per due item, with a computed `dueDate`. This collection powers
// (a) the worker's "due / overdue" shortlist, (b) the per-patient timeline,
// (c) the reminder cron (which scans pending events nearing/past dueDate).
// Denormalized patientName/patientMobile so list + reminder queries don't need
// a join. Uniqueness is (patientId, kind, code) so re-saving a patient re-syncs
// dates in place instead of duplicating.
const scheduleEventSchema = new mongoose.Schema({
  ashaId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true, index: true },
  patientId:     { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true, index: true },
  patientName:   { type: String, default: '' },
  patientMobile: { type: String, default: '' },
  kind:          { type: String, required: true }, // anc | vaccine | hbnc | followup
  code:          { type: String, required: true }, // ANC1 | V-6W | HBNC-D7 …
  label:         { type: String, default: '' },
  dueDate:       { type: Date,   required: true, index: true }, // window START (becomes due)
  windowEnd:     { type: Date,   default: null },  // last clinically-useful day; overdue only after this
  status:        { type: String, default: 'pending' }, // pending | done | missed | skipped
  doneDate:      { type: Date,   default: null },
  // Lead-times already fired by the reminder cron ('T-3','T-1','overdue') so a
  // single event never re-sends the same reminder.
  remindersSent: { type: [String], default: [] },
  meta:          { type: mongoose.Schema.Types.Mixed, default: {} }, // e.g. { vaccines: [...] }
  // What the worker recorded when completing the visit: ANC vitals
  // (bp/weight/hb), vaccines actually given, danger-sign flags, free notes.
  record:        { type: mongoose.Schema.Types.Mixed, default: {} },
  // Manual reminder log — the worker tapped Call / WhatsApp / SMS. Tracks that
  // (and how) the patient was reminded, even for phone calls where there is no
  // automatic trace. lastRemindedAt powers the "already reminded" hint.
  reminderLog:         { type: Array,  default: [] }, // [{ channel, at }]
  lastRemindedAt:      { type: Date,   default: null },
  lastReminderChannel: { type: String, default: '' },  // call | whatsapp | sms
}, { timestamps: true });
scheduleEventSchema.index({ patientId: 1, kind: 1, code: 1 }, { unique: true });

// ── Referrals (ASHA Form 3) ───────────────────────────────────────────────────
// A referral the worker makes to a facility (FRU/PHC/RH). Mirrors the paper
// "Form 3" but adds OUTCOME TRACKING — the #1 missing piece field workers asked
// for: today a patient vanishes once she leaves the sub-centre. status moves
// pending → reached → completed (or cancelled); the worker records who admitted
// her + the outcome when known. clientId makes the create idempotent offline.
const referralSchema = new mongoose.Schema({
  ashaId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  clientId:      { type: String, default: '' },
  patientId:     { type: String, default: '' },
  patientName:   { type: String, default: '' },
  age:           { type: String, default: '' },
  gender:        { type: String, default: '' },
  guardianName:  { type: String, default: '' },
  village:       { type: String, default: '' },
  mobile:        { type: String, default: '' },
  caseType:      { type: String, default: '' },     // pregnancy | newborn | child | other
  symptoms:      { type: String, default: '' },     // illness / danger signs
  currentWeight: { type: String, default: '' },     // child (Form 3)
  imnci:         { type: String, default: '' },     // IMNCI classification (child)
  medicinesGiven:{ type: String, default: '' },
  referredTo:    { type: String, default: '' },     // facility referred to
  reason:        { type: String, default: '' },     // why (band / danger summary)
  band:          { type: String, default: '' },     // RED | YELLOW
  status:        { type: String, default: 'pending', index: true }, // pending|reached|completed|cancelled
  reachedDate:   { type: Date,   default: null },
  admittedBy:    { type: String, default: '' },     // who took/admitted her
  relation:      { type: String, default: '' },
  facilityNotes: { type: String, default: '' },
  outcome:       { type: String, default: '' },     // admitted / treated & sent home / referred up / ...
  // Optimistic concurrency (same scheme as Patient): client sends the version
  // it edited from; the server only writes if it still matches, else 409.
  version:       { type: Number, default: 0 },
}, { timestamps: true });
referralSchema.index({ ashaId: 1, clientId: 1 });

// ── Eligible couples (family-planning register) ───────────────────────────────
// An "eligible couple" = a married couple with the wife in the reproductive age
// band (15–49). ASHAs maintain this register to counsel + track contraceptive
// use and do FP follow-ups. Mirrors the paper Eligible-Couple register but adds
// the current method + next follow-up so the reminder engine can surface it.
const eligibleCoupleSchema = new mongoose.Schema({
  ashaId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  clientId:      { type: String, default: '' },
  patientId:     { type: String, default: '' },     // optional link to a Patient (the wife)
  wifeName:      { type: String, default: '' },
  husbandName:   { type: String, default: '' },
  wifeAadhaar:   { type: String, default: '' },   // 12-digit, primary identifier
  husbandAadhaar:{ type: String, default: '' },
  wifeAge:       { type: String, default: '' },
  husbandAge:    { type: String, default: '' },
  village:       { type: String, default: '' },
  mobile:        { type: String, default: '' },
  marriageDate:  { type: Date,   default: null },
  sons:          { type: String, default: '' },     // living sons
  daughters:     { type: String, default: '' },     // living daughters
  youngestChildAge: { type: String, default: '' },  // months/years (free text)
  fpMethod:      { type: String, default: 'none' }, // none|condom|ocp|iucd|injectable|female_sterilization|male_sterilization|other
  fpAdoptedDate: { type: Date,   default: null },
  followUpDate:  { type: Date,   default: null, index: true }, // next FP follow-up
  highRisk:      { type: Boolean, default: false },
  notes:         { type: String, default: '' },
  status:        { type: String, default: 'active', index: true }, // active|closed
  version:       { type: Number, default: 0 },
}, { timestamps: true });
eligibleCoupleSchema.index({ ashaId: 1, clientId: 1 });

// ── Vital events (birth & death register, CRS reporting) ──────────────────────
// Births and deaths the ASHA reports to the ANM/sub-centre each month for civil
// registration (CRS). One schema covers both via `eventType`; only the relevant
// fields are filled. Tracks whether it was registered (CRS number) so the worker
// knows what is still pending registration.
const vitalEventSchema = new mongoose.Schema({
  ashaId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  clientId:      { type: String, default: '' },
  patientId:     { type: String, default: '' },     // optional link to a Patient
  eventType:     { type: String, default: 'birth', index: true }, // birth|death
  // Common
  personName:    { type: String, default: '' },     // newborn / deceased (may be blank for a birth)
  sex:           { type: String, default: '' },      // Male|Female|Other
  eventDate:     { type: Date,   default: null, index: true }, // DOB or DOD
  place:         { type: String, default: '' },      // home|institution|transit|other
  facilityName:  { type: String, default: '' },
  village:       { type: String, default: '' },
  mobile:        { type: String, default: '' },
  motherName:    { type: String, default: '' },
  fatherName:    { type: String, default: '' },
  // Birth-specific
  birthWeight:   { type: String, default: '' },      // kg
  deliveryType:  { type: String, default: '' },      // normal|caesarean|assisted
  attendedBy:    { type: String, default: '' },      // doctor|anm|sba|tba|relative
  // Death-specific
  ageAtDeath:    { type: String, default: '' },      // free text (e.g. "32 বছর", "5 দিন")
  causeOfDeath:  { type: String, default: '' },
  maternalDeath: { type: Boolean, default: false },  // death during pregnancy/childbirth/42d
  infantDeath:   { type: Boolean, default: false },  // <1 year
  // Registration tracking
  registered:    { type: Boolean, default: false },
  registrationNo:{ type: String, default: '' },
  notes:         { type: String, default: '' },
  version:       { type: Number, default: 0 },
}, { timestamps: true });
vitalEventSchema.index({ ashaId: 1, clientId: 1 });

// ── NCD / CBAC (Community-Based Assessment Checklist, 30+) ─────────────────────
// The CBAC is the population-based screening checklist every adult 30+ fills once
// (and is re-screened periodically). Part A is a 6-item risk score (≥4 = high
// risk → refer for blood-pressure/sugar testing); Part B is a symptom checklist
// for early detection of TB, oral/breast/cervical cancer and COPD (any "yes" →
// refer). We store the raw option values (so the score can be recomputed/audited)
// plus the computed riskScore and the symptom list. Optional patientId links the
// person to a Patient record; otherwise the ASHA enters them ad-hoc.
const ncdCbacSchema = new mongoose.Schema({
  ashaId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  clientId:      { type: String, default: '' },
  patientId:     { type: String, default: '' },     // optional link to a Patient
  personName:    { type: String, default: '' },
  sex:           { type: String, default: '' },      // Female|Male|Other (waist scoring is sex-specific)
  age:           { type: String, default: '' },
  aadhaar:       { type: String, default: '' },
  village:       { type: String, default: '' },
  mobile:        { type: String, default: '' },
  // ── Part A: risk-score components (stored as the chosen option) ──
  ageBand:       { type: String, default: '' },      // 30-39|40-49|50-59|60+  (0/1/2/3)
  tobacco:       { type: String, default: 'never' }, // never|past|current     (0/1/2)
  alcohol:       { type: Boolean, default: false },  // daily alcohol          (0/1)
  waist:         { type: String, default: 'normal' },// normal|medium|high     (0/1/2, sex-specific)
  inactive:      { type: Boolean, default: false },  // physically inactive    (0/1)
  familyHistory: { type: Boolean, default: false },  // HTN/diabetes/heart in 1st-degree relative (0/2)
  riskScore:     { type: Number, default: 0 },       // computed total (0–11)
  // ── Part B: early-detection symptoms (any → refer) ──
  symptoms:      { type: [String], default: [] },
  // ── Known conditions + measurements ──
  knownHtn:      { type: Boolean, default: false },
  knownDiabetes: { type: Boolean, default: false },
  knownHeart:    { type: Boolean, default: false },  // known CVD / stroke
  knownCopd:     { type: Boolean, default: false },  // known asthma / COPD
  bp:            { type: String, default: '' },      // e.g. "130/85"
  bloodSugar:    { type: String, default: '' },      // mg/dL
  // ── Outcome ──
  referred:      { type: Boolean, default: false },
  referredTo:    { type: String, default: '' },
  followUpDate:  { type: Date,   default: null, index: true },
  notes:         { type: String, default: '' },
  status:        { type: String, default: 'active', index: true }, // active|closed
  version:       { type: Number, default: 0 },
}, { timestamps: true });
ncdCbacSchema.index({ ashaId: 1, clientId: 1 });

// ── TB cases (presumptive screening + DOTS adherence) ─────────────────────────
// Two-stage: (1) presumptive screening — symptom checklist; any "yes" means the
// person is a presumptive TB case → refer for sputum/CBNAAT. (2) once a diagnosis
// is confirmed, the same record tracks DOTS treatment (start date, regimen,
// doses taken/missed, follow-up sputum, outcome) so the ASHA can support
// adherence. `stage` switches the record between the two.
const tbCaseSchema = new mongoose.Schema({
  ashaId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  clientId:      { type: String, default: '' },
  patientId:     { type: String, default: '' },     // optional link to a Patient
  personName:    { type: String, default: '' },
  sex:           { type: String, default: '' },
  age:           { type: String, default: '' },
  village:       { type: String, default: '' },
  mobile:        { type: String, default: '' },
  stage:         { type: String, default: 'presumptive', index: true }, // presumptive|on_treatment|completed
  // ── Presumptive screening ──
  symptoms:      { type: [String], default: [] },    // cough2w|fever2w|weight_loss|night_sweats|blood_sputum|contact
  referredForTest:{ type: Boolean, default: false }, // referred for sputum/CBNAAT
  testResult:    { type: String, default: '' },      // pending|positive|negative
  // ── Treatment / DOTS ──
  tbType:        { type: String, default: '' },      // pulmonary|extra_pulmonary
  treatmentStart:{ type: Date,   default: null },
  regimen:       { type: String, default: '' },      // free text (e.g. "HRZE 2m + HRE 4m")
  dosesTaken:    { type: String, default: '' },
  dosesMissed:   { type: String, default: '' },
  followUpSputum:{ type: String, default: '' },      // pending|positive|negative
  nikshayId:     { type: String, default: '' },      // Ni-kshay (national TB registry) id
  outcome:       { type: String, default: '' },      // cured|completed|lost|died|failed
  followUpDate:  { type: Date,   default: null, index: true },
  notes:         { type: String, default: '' },
  version:       { type: Number, default: 0 },
}, { timestamps: true });
tbCaseSchema.index({ ashaId: 1, clientId: 1 });

// ── Medicine stock (ASHA monthly drug account — "Form 2") ─────────────────────
// The ASHA keeps a monthly account of every medicine in her drug kit (Form 2,
// "three copies"). One row = one medicine for one month: opening balance, what
// was received (+date), what was distributed/used, what expired, and the closing
// balance (opening + received − issued − expired). Stored per (medicine, month)
// so the app can regenerate the submittable Form-2 PDF and carry the closing
// balance forward as next month's opening.
const medicineStockSchema = new mongoose.Schema({
  ashaId:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  clientId:      { type: String, default: '' },
  medicineName:  { type: String, default: '' },
  unit:          { type: String, default: 'tablet' }, // tablet|strip|packet|bottle|piece|tube
  month:         { type: String, default: '', index: true }, // 'YYYY-MM'
  openingStock:  { type: Number, default: 0 },        // in hand at start of month
  receivedQty:   { type: Number, default: 0 },        // received this month
  receivedDate:  { type: Date,   default: null },
  issuedQty:     { type: Number, default: 0 },        // distributed / used this month
  expiredQty:    { type: Number, default: 0 },        // expired / discarded
  closingStock:  { type: Number, default: 0 },        // computed: opening + received − issued − expired
  lowStockThreshold: { type: Number, default: 0 },    // flag when closing ≤ this
  notes:         { type: String, default: '' },
  status:        { type: String, default: 'active', index: true }, // active|closed
  version:       { type: Number, default: 0 },
}, { timestamps: true });
medicineStockSchema.index({ ashaId: 1, clientId: 1 });

const User          = mongoose.model('User',          userSchema);
const Patient       = mongoose.model('Patient',       patientSchema);
const Report        = mongoose.model('Report',        reportSchema);
const Notification  = mongoose.model('Notification',  notificationSchema);
const AiCache       = mongoose.model('AiCache',       aiCacheSchema);
const ScheduleEvent = mongoose.model('ScheduleEvent', scheduleEventSchema);
const Referral      = mongoose.model('Referral',      referralSchema);
const EligibleCouple= mongoose.model('EligibleCouple',eligibleCoupleSchema);
const VitalEvent    = mongoose.model('VitalEvent',    vitalEventSchema);
const NcdCbac       = mongoose.model('NcdCbac',       ncdCbacSchema);
const TbCase        = mongoose.model('TbCase',        tbCaseSchema);
const MedicineStock = mongoose.model('MedicineStock', medicineStockSchema);

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

// Everyone ABOVE a worker in the supervisor tree: her ANM, that ANM's BMHO, and
// so on to the CMHO. Walks upward, guarding against a cycle.
async function supervisorChain(userId) {
  const chain = [];
  const seen = new Set([String(userId)]);
  let cur = await User.findById(userId).select('supervisorId');
  while (cur && cur.supervisorId && !seen.has(String(cur.supervisorId))) {
    const sup = String(cur.supervisorId);
    seen.add(sup);
    chain.push(sup);
    cur = await User.findById(sup).select('supervisorId');
  }
  return chain;
}

// Escalate UP the chain above the worker who raised it — NOT to every admin.
// Before the hierarchy existed, "all admins" was one person and notifyAllAdmins
// was correct. Now it would ping an ANM in another block about a patient she
// cannot act on and has no business seeing: alert fatigue plus a scoping leak.
// The people who can actually act are exactly her supervisors.
async function notifySupervisors(workerId, { type, title, body, link = '', data = {} }) {
  try {
    const ids = await supervisorChain(workerId);
    if (!ids.length) return;
    const active = await User.find({ _id: { $in: ids }, isActive: true }).select('_id');
    if (!active.length) return;
    await Notification.insertMany(active.map(u => ({
      recipientId: u._id, type, title, body, link, data,
    })));
  } catch (e) {
    console.error('[notifySupervisors]', e.message);
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

// ── Schedule generation (ANC / immunization / HBNC) ───────────────────────────
// Due-dates are derived from LMP (ANC) and DOB (vaccines, HBNC). The vaccine
// plan follows the UIP national schedule as printed on the MCP card (pg 38),
// including PCV. One schedule-event per visit milestone (vaccines for that
// visit live in meta.vaccines) so the worker's list stays ~10 rows per child.
const DAY = 24 * 60 * 60 * 1000;
function addDays(date, n) { return new Date(new Date(date).getTime() + n * DAY); }

// GoI / WB NHM 4-visit ANC schedule (min 4 visits). Visit 1 within the first
// trimester (early registration — the most critical ANC timing), then one per
// later window. Due weeks from LMP; labels carry the recommended window so the
// worker/mother can see when each is due. (If a woman registers late, the early
// visit simply shows overdue and is done at once.)
// `weeks` = when the visit becomes due (window START); `endWeeks` = last
// clinically-useful week (window END — overdue only after this). The gap is the
// window the worker has to do the visit; doing it before `weeks` is "too early".
// West Bengal revised 4-visit ANC schedule (per the state ANC card): 1st 14–26,
// 2nd 28–32, 3rd 34→delivery, 4th before delivery.
const ANC_PLAN = [
  { code: 'ANC1', label: 'ANC ১ম পরীক্ষা (১৪–২৬ সপ্তাহ)',           weeks: 14, endWeeks: 26 },
  { code: 'ANC2', label: 'ANC ২য় পরীক্ষা (২৮–৩২ সপ্তাহ)',           weeks: 28, endWeeks: 32 },
  { code: 'ANC3', label: 'ANC ৩য় পরীক্ষা (৩৪ সপ্তাহ – প্রসবের আগে)', weeks: 34, endWeeks: 38 },
  { code: 'ANC4', label: 'ANC ৪র্থ পরীক্ষা (প্রসবের আগ পর্যন্ত)',     weeks: 38, endWeeks: 42 },
];

const VACCINE_PLAN = [
  { code: 'V-BIRTH', label: 'জন্মের টিকা',          days: 0,    vaccines: ['BCG', 'OPV-0', 'Hepatitis B-0', 'Vitamin K'] },
  { code: 'V-6W',    label: '৬ সপ্তাহের টিকা',       days: 42,   vaccines: ['Pentavalent-1', 'OPV-1', 'Rotavirus-1', 'fIPV-1', 'PCV-1'] },
  { code: 'V-10W',   label: '১০ সপ্তাহের টিকা',      days: 70,   vaccines: ['Pentavalent-2', 'OPV-2', 'Rotavirus-2'] },
  { code: 'V-14W',   label: '১৪ সপ্তাহের টিকা',      days: 98,   vaccines: ['Pentavalent-3', 'OPV-3', 'Rotavirus-3', 'fIPV-2', 'PCV-2'] },
  { code: 'V-9M',    label: '৯ মাসের টিকা',          days: 270,  vaccines: ['MR-1', 'Vitamin A-1', 'JE-1', 'PCV-Booster'] },
  { code: 'V-16M',   label: '১৬–২৪ মাসের টিকা',      days: 480,  vaccines: ['DPT booster-1', 'MR-2', 'OPV booster', 'Vitamin A-2', 'JE-2'] },
  { code: 'V-5Y',    label: '৫–৬ বছরের টিকা',        days: 1825, vaccines: ['DPT booster-2'] },
  { code: 'V-10Y',   label: '১০ বছরের টিকা',         days: 3650, vaccines: ['TD'] },
  { code: 'V-16Y',   label: '১৬ বছরের টিকা',         days: 5840, vaccines: ['TD'] },
];

// Home-Based Newborn Care visits (institutional-delivery schedule).
const HBNC_PLAN = [
  { code: 'HBNC-D3',  label: 'গৃহ পরিদর্শন — ৩য় দিন',   days: 3 },
  { code: 'HBNC-D7',  label: 'গৃহ পরিদর্শন — ৭ম দিন',    days: 7 },
  { code: 'HBNC-D14', label: 'গৃহ পরিদর্শন — ১৪তম দিন',  days: 14 },
  { code: 'HBNC-D21', label: 'গৃহ পরিদর্শন — ২১তম দিন',  days: 21 },
  { code: 'HBNC-D28', label: 'গৃহ পরিদর্শন — ২৮তম দিন',  days: 28 },
  { code: 'HBNC-D42', label: 'গৃহ পরিদর্শন — ৪২তম দিন',  days: 42 },
];

// Home-Based care for Young Child (HBYC / IIBYC card) — quarterly home visits
// for growth, feeding, immunization-completeness and danger-sign screening.
const HBYC_PLAN = [
  { code: 'HBYC-3M',  label: 'গৃহভিত্তিক শিশু যত্ন — ৩ মাস',  days: 90 },
  { code: 'HBYC-6M',  label: 'গৃহভিত্তিক শিশু যত্ন — ৬ মাস',  days: 180 },
  { code: 'HBYC-9M',  label: 'গৃহভিত্তিক শিশু যত্ন — ৯ মাস',  days: 270 },
  { code: 'HBYC-12M', label: 'গৃহভিত্তিক শিশু যত্ন — ১২ মাস', days: 365 },
  { code: 'HBYC-15M', label: 'গৃহভিত্তিক শিশু যত্ন — ১৫ মাস', days: 455 },
];

// Postnatal care for the MOTHER — generated from her delivery date (distinct
// from the newborn's HBNC home visits). MCP card PNC schedule: days 3, 7, 42.
const PNC_PLAN = [
  { code: 'PNC-D3',  label: 'প্রসব-পরবর্তী পরিচর্যা — ৩য় দিন',  days: 3 },
  { code: 'PNC-D7',  label: 'প্রসব-পরবর্তী পরিচর্যা — ৭ম দিন',   days: 7 },
  { code: 'PNC-D42', label: 'প্রসব-পরবর্তী পরিচর্যা — ৪২তম দিন', days: 42 },
];

// Re-sync a patient's schedule after create/update. Upserts each computed event
// by (patientId, kind, code): dates/labels are refreshed in place, but an
// event already marked done/missed keeps its status (only set on insert).
async function syncScheduleForPatient(p) {
  try {
    if (!p || !p._id) return;
    const type = (p.type || '').toLowerCase();
    const isPregnancy = type.includes('preg') || type.includes('গর্ভ');
    const isNewborn   = type.includes('newborn') || type.includes('নবজাত');
    const isChild     = type.includes('child') || type.includes('infant') || type.includes('শিশু');

    const planned = [];
    if (p.lmp && isPregnancy) {
      for (const a of ANC_PLAN) planned.push({
        kind: 'anc', code: a.code, label: a.label,
        dueDate: addDays(p.lmp, a.weeks * 7),
        windowEnd: a.endWeeks ? addDays(p.lmp, a.endWeeks * 7) : null,
        meta: {},
      });
    }
    // Mother's postnatal (PNC) schedule — from her delivery date. Gated to an
    // adult mother (never a child/newborn record) so a stray date can't make
    // PNC events for a baby.
    if (p.deliveryDate && !isNewborn && !isChild) {
      for (const n of PNC_PLAN) planned.push({ kind: 'pnc', code: n.code, label: n.label, dueDate: addDays(p.deliveryDate, n.days), meta: {} });
    }
    // ONLY a child/newborn DOB drives the vaccine/HBNC schedule. A DOB stored on
    // a mother (pregnancy) or 'other' patient is just a record — it must never
    // generate baby-vaccine reminders for an adult.
    if (p.dob && (isNewborn || isChild)) {
      for (const v of VACCINE_PLAN) planned.push({ kind: 'vaccine', code: v.code, label: v.label, dueDate: addDays(p.dob, v.days), meta: { vaccines: v.vaccines } });
      for (const y of HBYC_PLAN) planned.push({ kind: 'hbyc', code: y.code, label: y.label, dueDate: addDays(p.dob, y.days), meta: {} });
      if (isNewborn) {
        for (const h of HBNC_PLAN) planned.push({ kind: 'hbnc', code: h.code, label: h.label, dueDate: addDays(p.dob, h.days), meta: {} });
      }
    }
    for (const e of planned) {
      await ScheduleEvent.updateOne(
        { patientId: p._id, kind: e.kind, code: e.code },
        {
          $set: {
            ashaId: p.ashaId, patientName: p.name || '', patientMobile: p.mobile || '',
            label: e.label, dueDate: e.dueDate, windowEnd: e.windowEnd ?? null, meta: e.meta,
          },
          $setOnInsert: { status: 'pending', remindersSent: [] },
        },
        { upsert: true },
      );
    }
  } catch (e) {
    console.error('[syncScheduleForPatient]', e.message);
  }
}

// EDD defaults to LMP + 280 days (Naegele) when not explicitly provided.
function normalizeMchDates(body) {
  if (body && body.lmp && !body.edd) {
    body.edd = addDays(body.lmp, 280);
  }
  return body;
}

// Mirror the RCH/MCTS id from the flexible mcpDetails map into the top-level
// indexed `rchId` field so the strong-key de-dup lookup can use an index. The
// registration form only writes mcpDetails.rchId; this keeps one source of
// truth while still giving us a fast, indexable key.
function mirrorRchId(body) {
  if (!body) return body;
  const fromMcp = body.mcpDetails && body.mcpDetails.rchId;
  const v = String((fromMcp != null ? fromMcp : body.rchId) || '').trim();
  if (v) body.rchId = v;
  return body;
}

// ── Automatic reminder engine ─────────────────────────────────────────────────
// A lightweight in-process scheduler (no extra dependency) scans pending
// schedule events and reminds across the whole visit lifecycle, deduped via each
// event's `remindersSent`:
//   • T-1     — one day before / on the checkup date (patient reminder).
//   • missed  — the day the checkup date passes with the visit still pending:
//               the WORKER gets an in-app notification (works without SMS), then
//   • weekly  — a patient reminder every following week while it stays pending
//               and within the window, so a missed visit keeps nudging.
//   • overdue — once the window fully closes.
// Patient reminders go to the MOTHER over:
//   1. SMS      — MSG91 Flow; active when SMS_API_KEY + SMS_TEMPLATE_ID are set.
//   2. WhatsApp — Meta Cloud API; active when WHATSAPP_TOKEN + WHATSAPP_PHONE_ID set.
// Both are no-ops until their credentials exist in .env; the worker's missed-
// visit notification still fires regardless.

function reminderText(e) {
  const who = e.patientName || 'রোগী';
  const days = Math.round((new Date(e.dueDate) - new Date()) / DAY);
  const when = days < 0
    ? `${Math.abs(days)} দিন পার হয়ে গেছে`
    : days === 0
      ? 'আজ দেয়'
      : `${days} দিন পরে (${new Date(e.dueDate).toLocaleDateString('en-GB')})`;
  if (e.kind === 'anc') return `নমস্কার, ${who}-এর ANC পরীক্ষা (${e.label}) ${when}। অনুগ্রহ করে নিকটতম স্বাস্থ্যকেন্দ্রে যান।`;
  if (e.kind === 'vaccine') return `${who}-এর টিকা (${e.label}) ${when}। সময়মতো অঙ্গনওয়াড়ি/স্বাস্থ্যকেন্দ্রে টিকা দিন।`;
  if (e.kind === 'hbnc') return `${who}-এর গৃহ পরিদর্শন (${e.label}) ${when}।`;
  return `${who} — ${e.label}: ${when}।`;
}

// Variables for the DLT SMS template. Free-text SMS to Indian numbers is not
// allowed — the content must match a template registered on the DLT portal, so
// we send the template id + these variables (not a composed sentence).
function reminderVars(e) {
  const days = Math.round((new Date(e.dueDate) - new Date()) / DAY);
  const when = days < 0 ? `${Math.abs(days)} দিন পার`
    : days === 0 ? 'আজ' : `${days} দিন পরে`;
  return { name: e.patientName || 'রোগী', service: e.label || 'চেকআপ', due: when };
}

// SMS via MSG91 Flow API (DLT-compliant). Configure on the server (.env):
//   SMS_API_KEY     = MSG91 authkey
//   SMS_TEMPLATE_ID = the DLT-approved MSG91 flow template id
//   SMS_SENDER      = 6-char DLT sender/header id (optional; usually set in tmpl)
//   SMS_API_URL     = optional override (default = MSG91 flow endpoint)
// Register a DLT template whose variables are name / service / due, e.g.:
//   "Nomoskar ##name##, apnar ##service## ##due##. Onugroho kore nikotostho
//    sasthyokendre jogajog korun."
async function sendSmsReminder(mobile, vars) {
  const key = process.env.SMS_API_KEY;
  const templateId = process.env.SMS_TEMPLATE_ID;
  if (!mobile || !key || !templateId) return false; // not configured → skip silently
  const url = process.env.SMS_API_URL || 'https://control.msg91.com/api/v5/flow/';
  const to = String(mobile).length === 10 ? `91${mobile}` : String(mobile);
  try {
    const body = {
      template_id: templateId,
      recipients: [{ mobiles: to, name: vars.name, service: vars.service, due: vars.due }],
    };
    if (process.env.SMS_SENDER) body.sender = process.env.SMS_SENDER;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', authkey: key },
      body: JSON.stringify(body),
    });
    return res.ok; // only mark "sent" when MSG91 accepted it
  } catch (err) { console.warn('[sms]', err.message); return false; }
}

async function sendWhatsappReminder(mobile, text) {
  const token = process.env.WHATSAPP_TOKEN, phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!mobile || !token || !phoneId) return false; // not configured → skip silently
  try {
    // Meta WhatsApp Cloud API. Free-form text only works inside the 24-h
    // customer window; PROACTIVE reminders need an APPROVED TEMPLATE. So when
    // WHATSAPP_TEMPLATE (the approved template name) is set we send a template
    // payload — the message body text rides in the first body variable {{1}}.
    // Until then we fall back to a plain text payload (works in the 24-h window
    // / for testing). Set WHATSAPP_TEMPLATE_LANG to match the template locale.
    const to = mobile.length === 10 ? `91${mobile}` : mobile;
    const tmpl = process.env.WHATSAPP_TEMPLATE;
    const payload = tmpl
      ? {
          messaging_product: 'whatsapp', to, type: 'template',
          template: {
            name: tmpl,
            language: { code: process.env.WHATSAPP_TEMPLATE_LANG || 'bn' },
            components: [
              { type: 'body', parameters: [{ type: 'text', text }] },
            ],
          },
        }
      : { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } };
    await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    return true;
  } catch (err) { console.warn('[whatsapp]', err.message); return false; }
}

let _reminderScanRunning = false;
async function runReminderScan() {
  if (mongoose.connection.readyState !== 1 || _reminderScanRunning) return;
  _reminderScanRunning = true;
  try {
    const now = new Date();
    // From 1 day before each visit's due date onward — covers the T-1 nudge, the
    // weekly nudges through the open window, and overdue once the window closes.
    const horizon = addDays(now, 1);
    const events = await ScheduleEvent.find({
      status: 'pending', dueDate: { $lte: horizon },
    }).limit(3000);
    let fired = 0;
    for (const e of events) {
      const end = e.windowEnd || e.dueDate;
      const daysToDue = Math.round((e.dueDate - now) / DAY); // checkup date (window opens)
      const daysToEnd = Math.round((end - now) / DAY);       // window closes
      let tag = null;
      let firstMiss = false;
      if (daysToEnd < 0) {
        tag = 'overdue';                                     // window fully closed
      } else if (daysToDue >= 0 && daysToDue <= 1) {
        tag = 'T-1';                                         // one day before / on the date
      } else if (daysToDue < 0) {
        // Past the checkup date but still inside the window → weekly nudge until
        // it's done or the window closes. Week 0 = the week it was missed.
        const weekIdx = Math.floor((-daysToDue) / 7);
        tag = `miss-W${weekIdx}`;
        firstMiss = !(e.remindersSent || []).some((t) => String(t).startsWith('miss-'));
      }
      if (!tag || (e.remindersSent || []).includes(tag)) continue;

      // The moment a checkup is missed, notify the worker in-app — this works
      // even before SMS/WhatsApp are enabled. Fires once per missed visit.
      if (firstMiss) {
        await notifyUser({
          recipientId: e.ashaId,
          type: 'visit_missed',
          title: 'চেকআপ বকেয়া পড়েছে',
          body: `${e.patientName || 'রোগী'} — ${e.label || ''} বকেয়া। সম্পন্ন না হওয়া পর্যন্ত সপ্তাহে একবার মনে করানো হবে।`,
          link: '/schedule/due',
          data: { eventId: String(e._id), kind: e.kind, code: e.code },
        });
      }

      // Patient-facing reminder (only actually delivers once a channel is on).
      const text = reminderText(e);
      if (await sendSmsReminder(e.patientMobile, reminderVars(e))) { /* delivered */ }
      if (await sendWhatsappReminder(e.patientMobile, text)) { /* delivered */ }

      // Mark this lead-time / week done so it isn't repeated within the same
      // window slice (and the worker isn't re-notified hourly). Future weeks
      // still fire — and start delivering patient SMS the day channels are added.
      e.remindersSent = [...(e.remindersSent || []), tag];
      await e.save();
      fired++;
    }
    if (fired) console.log(`[reminderScan] fired ${fired} reminder(s)`);
  } catch (err) {
    console.error('[reminderScan]', err.message);
  } finally {
    _reminderScanRunning = false;
  }
}

// Run shortly after boot, then hourly. Date-based lead-times + the remindersSent
// dedup mean a skipped or extra tick can never double-send.
setTimeout(runReminderScan, 30 * 1000);
setInterval(runReminderScan, 60 * 60 * 1000);

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

// ── Hierarchy scoping ────────────────────────────────────────────────────────
// Everyone strictly below `rootId` in the supervisor tree (BFS over supervisorId).
async function subtreeUserIds(rootId) {
  const out = [];
  let frontier = [rootId.toString()];
  const seen = new Set(frontier);
  while (frontier.length) {
    const kids = await User.find({ supervisorId: { $in: frontier } }).select('_id').lean();
    const next = [];
    for (const k of kids) {
      const s = k._id.toString();
      if (!seen.has(s)) { seen.add(s); out.push(s); next.push(s); }
    }
    frontier = next;
  }
  return out;
}

// ASHA-level ids anywhere in a supervisor's subtree — scopes patients/reports.
async function subtreeAshaIds(user) {
  const ids = await subtreeUserIds(user.id);
  if (!ids.length) return [];
  const ashas = await User.find({ _id: { $in: ids }, role: 'asha_worker' }).select('_id').lean();
  return ashas.map(u => u._id.toString());
}

// The people directly below the requester (the one level they manage).
function directReports(user) {
  return User.find({ supervisorId: user.id }).select('-otp -otpExpiry');
}

// Gate: supervisor roles only (anm/bmho/cmho); legacy admin passes as anm.
function requireSupervisor(req, res, next) {
  if (effectiveRole(req.user) === 'asha_worker')
    return res.status(403).json({ success: false, message: 'Supervisor only' });
  next();
}

// True if `targetId` is within the requester's subtree (or is them).
async function inSubtree(user, targetId) {
  if (targetId.toString() === user.id.toString()) return true;
  const ids = await subtreeUserIds(user.id);
  return ids.includes(targetId.toString());
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
    build: 'gemini-primary+lang-normalize+mch-schedule+reminders+ocr+remindlog+hbyc+aadhaarqr2+patientversionfix+agegenderfix+editlegacyversionfix+dobschedguard+identitydedup+referrals+pncschedule+watemplate+eligiblecouples+vitalevents+ecaadhaar+ancplan+ancwindow+reminderhealth+msg91sms+ncdcbac+tbcases+medstock+ancwb+missweekly+adminmodstats+hierarchy-roles+district-hmis+teamrollup+defaulters+chainalerts+periodfix-2026-07',
    ocr: !!tesseract,
    qr: !!(Jimp && jsQR), // Aadhaar QR engine loaded? (false ⇒ npm i jimp jsqr on VPS)
    chatPrimary: 'gemini', // resolveChatReply tries Gemini first, Groq fallback
    geminiKeys: (typeof geminiKeys !== 'undefined' && geminiKeys) ? geminiKeys.length : 0,
    // Auto-reminder delivery channels (booleans only — never the secrets).
    // The cron always runs; messages send only when a channel is configured.
    reminders: {
      cron: true, // scan scheduled (boot+hourly)
      sms: !!(process.env.SMS_API_KEY && process.env.SMS_TEMPLATE_ID), // MSG91 flow
      whatsapp: !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID),
    },
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

    const role = effectiveRole(user);
    const token = jwt.sign(
      { id: user._id, phone: user.phone, isAdmin: user.isAdmin, role,
        supervisorId: user.supervisorId ? user.supervisorId.toString() : null },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({
      success: true,
      token,
      user: {
        id: user._id.toString(), phone: user.phone, name: user.name,
        role, supervisorId: user.supervisorId ? user.supervisorId.toString() : null,
        subCentre: user.subCentre ?? '',
        block: user.block, district: user.district,
        isAdmin: user.isAdmin,
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
        role: effectiveRole(user),
        supervisorId: user.supervisorId ? user.supervisorId.toString() : null,
        subCentre: user.subCentre ?? '',
        block: user.block, district: user.district,
        isAdmin: user.isAdmin,
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
    // Capture the client-generated local id as the idempotency key BEFORE we
    // strip it. `version` must be touched ONLY by `$inc` below (else Mongo
    // errors "Updating the path 'version' would create a conflict"), and
    // `_id`/`id` must never be $set on an existing doc.
    const clientId = String(body.clientId || body.id || '').trim();
    delete body.version;
    delete body._id;
    delete body.id;
    if (clientId) body.clientId = clientId;
    normalizeMchDates(body);
    mirrorRchId(body);

    // ── De-dup, in priority order ────────────────────────────────────────────
    // We deliberately do NOT merge on name+mobile: two real people can share a
    // name and a household phone, and a child often has neither Aadhaar nor a
    // phone — so a name+mobile merge silently loses a beneficiary. Instead the
    // client surfaces a "possible duplicate?" prompt to the worker (who knows
    // the family). The server only merges on UNAMBIGUOUS keys:
    //
    //   1. clientId — the SAME local record being retried / re-synced. Makes
    //      offline-first POST idempotent (no dupes from double-tap, flaky
    //      network, or a slow-but-successful POST that the client re-queues).
    //   2. rchId — the government RCH/MCTS id: the same real person, even if
    //      re-registered as a fresh local record on another device.
    for (const match of [
      clientId   ? { ashaId: req.user.id, clientId } : null,
      body.rchId ? { ashaId: req.user.id, rchId: body.rchId } : null,
    ]) {
      if (!match) continue;
      const existing = await Patient.findOneAndUpdate(
        match,
        { $set: body, $inc: { version: 1 } },
        { new: true },
      );
      if (existing) {
        await syncScheduleForPatient(existing);
        return res.status(200).json({ success: true, data: toClient(existing), deduped: true });
      }
    }

    const patient = await Patient.create(body);
    await syncScheduleForPatient(patient);
    res.status(201).json({ success: true, data: toClient(patient) });
  } catch (err) {
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
    delete updates.clientId; // never overwrite the idempotency key on edit
    normalizeMchDates(updates);
    mirrorRchId(updates); // keep top-level rchId in sync when the worker edits it
    if (typeof clientVersion === 'number') {
      // Match the expected version OR a doc with no version yet — legacy rows
      // (created before the version field existed) have `version` ABSENT, and
      // in Mongo {version: 0} does NOT match a missing field, which 409'd every
      // edit of those patients. $in [clientVersion, null] also matches absent.
      const filter = {
        _id: req.params.id,
        ashaId: req.user.id,
        version: { $in: [clientVersion, null] },
      };
      const patient = await Patient.findOneAndUpdate(
        filter,
        { $set: updates, $inc: { version: 1 } },
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
      await syncScheduleForPatient(patient);
      return res.json({ success: true, data: toClient(patient) });
    }
    // Legacy path (no version) — increments anyway so older clients still cooperate.
    const patient = await Patient.findOneAndUpdate(
      { _id: req.params.id, ashaId: req.user.id },
      { $set: updates, $inc: { version: 1 } },
      { new: true }
    );
    if (!patient) return res.status(404).json({ success: false, message: 'Not found' });
    await syncScheduleForPatient(patient);
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
    await ScheduleEvent.deleteMany({ patientId: req.params.id, ashaId: req.user.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Referrals (ASHA Form 3 + outcome tracking) ────────────────────────────────
// Same offline-first contract as patients: clientId makes create idempotent,
// `version` gives optimistic-concurrency on edit (so two devices updating the
// same referral don't silently clobber each other).

// List the worker's referrals, newest first.
app.get('/api/referrals', auth, async (req, res) => {
  try {
    const referrals = await Referral.find({ ashaId: req.user.id }).sort({ createdAt: -1 }).limit(1000);
    res.json({ success: true, data: referrals.map(toClient) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Create a referral. De-dups on clientId so an offline-queued create that is
// retried (double-tap / flaky network) updates the same row instead of duping.
app.post('/api/referrals', auth, async (req, res) => {
  try {
    const body = { ...req.body, ashaId: req.user.id };
    const clientId = String(body.clientId || body.id || '').trim();
    delete body.version;
    delete body._id;
    delete body.id;
    if (clientId) body.clientId = clientId;

    if (clientId) {
      const existing = await Referral.findOneAndUpdate(
        { ashaId: req.user.id, clientId },
        { $set: body, $inc: { version: 1 } },
        { new: true },
      );
      if (existing) {
        return res.status(200).json({ success: true, data: toClient(existing), deduped: true });
      }
    }

    const referral = await Referral.create(body);
    res.status(201).json({ success: true, data: toClient(referral) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Update a referral — typically the OUTCOME (status reached/completed, who
// admitted her, facility notes). Optimistic concurrency mirrors patients.
app.put('/api/referrals/:id', auth, async (req, res) => {
  try {
    const { version: clientVersion, ...updates } = req.body || {};
    delete updates.clientId; // never overwrite the idempotency key on edit
    if (typeof clientVersion === 'number') {
      const filter = {
        _id: req.params.id,
        ashaId: req.user.id,
        version: { $in: [clientVersion, null] }, // null matches legacy rows
      };
      const referral = await Referral.findOneAndUpdate(
        filter,
        { $set: updates, $inc: { version: 1 } },
        { new: true },
      );
      if (!referral) {
        const current = await Referral.findOne({ _id: req.params.id, ashaId: req.user.id });
        if (!current) return res.status(404).json({ success: false, message: 'Not found' });
        return res.status(409).json({
          success: false,
          message: 'Version conflict — referral was modified by another writer.',
          current: toClient(current),
        });
      }
      return res.json({ success: true, data: toClient(referral) });
    }
    const referral = await Referral.findOneAndUpdate(
      { _id: req.params.id, ashaId: req.user.id },
      { $set: updates, $inc: { version: 1 } },
      { new: true },
    );
    if (!referral) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: toClient(referral) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.delete('/api/referrals/:id', auth, async (req, res) => {
  try {
    await Referral.findOneAndDelete({ _id: req.params.id, ashaId: req.user.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Generic owner-scoped CRUD for the simple sync'd collections ────────────────
// EligibleCouple + VitalEvent share the exact offline-first contract used by
// referrals (clientId de-dup on create, optimistic version on update). This
// factory wires GET/POST/PUT/DELETE for a model so both modules stay identical
// to the proven referral path.
function registerSyncedCrud(path, Model) {
  app.get(`/api/${path}`, auth, async (req, res) => {
    try {
      const docs = await Model.find({ ashaId: req.user.id }).sort({ createdAt: -1 }).limit(2000);
      res.json({ success: true, data: docs.map(toClient) });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post(`/api/${path}`, auth, async (req, res) => {
    try {
      const body = { ...req.body, ashaId: req.user.id };
      const clientId = String(body.clientId || body.id || '').trim();
      delete body.version;
      delete body._id;
      delete body.id;
      if (clientId) body.clientId = clientId;

      if (clientId) {
        const existing = await Model.findOneAndUpdate(
          { ashaId: req.user.id, clientId },
          { $set: body, $inc: { version: 1 } },
          { new: true },
        );
        if (existing) {
          return res.status(200).json({ success: true, data: toClient(existing), deduped: true });
        }
      }
      const doc = await Model.create(body);
      res.status(201).json({ success: true, data: toClient(doc) });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.put(`/api/${path}/:id`, auth, async (req, res) => {
    try {
      const { version: clientVersion, ...updates } = req.body || {};
      delete updates.clientId;
      if (typeof clientVersion === 'number') {
        const filter = {
          _id: req.params.id,
          ashaId: req.user.id,
          version: { $in: [clientVersion, null] },
        };
        const doc = await Model.findOneAndUpdate(
          filter,
          { $set: updates, $inc: { version: 1 } },
          { new: true },
        );
        if (!doc) {
          const current = await Model.findOne({ _id: req.params.id, ashaId: req.user.id });
          if (!current) return res.status(404).json({ success: false, message: 'Not found' });
          return res.status(409).json({
            success: false,
            message: 'Version conflict — modified by another writer.',
            current: toClient(current),
          });
        }
        return res.json({ success: true, data: toClient(doc) });
      }
      const doc = await Model.findOneAndUpdate(
        { _id: req.params.id, ashaId: req.user.id },
        { $set: updates, $inc: { version: 1 } },
        { new: true },
      );
      if (!doc) return res.status(404).json({ success: false, message: 'Not found' });
      res.json({ success: true, data: toClient(doc) });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.delete(`/api/${path}/:id`, auth, async (req, res) => {
    try {
      await Model.findOneAndDelete({ _id: req.params.id, ashaId: req.user.id });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
}

registerSyncedCrud('eligible-couples', EligibleCouple);
registerSyncedCrud('vital-events', VitalEvent);
registerSyncedCrud('ncd-cbac', NcdCbac);
registerSyncedCrud('tb-cases', TbCase);
registerSyncedCrud('medicine-stock', MedicineStock);

// ── Schedule (ANC / immunization / HBNC due tracking) ─────────────────────────

// Worker's "due / overdue" shortlist — the heart of the reminder workflow.
// Returns pending events due within `withinDays` (default 14) OR already
// overdue, soonest first. Optional `kind` filter (vaccine | anc | hbnc).
app.get('/api/schedule/due', auth, async (req, res) => {
  try {
    const withinDays = Math.min(parseInt(req.query.withinDays, 10) || 14, 365);
    const horizon = addDays(new Date(), withinDays);
    const q = { ashaId: req.user.id, status: 'pending', dueDate: { $lte: horizon } };
    if (req.query.kind) q.kind = req.query.kind;
    const events = await ScheduleEvent.find(q).sort({ dueDate: 1 }).limit(500);
    const now = new Date();
    const data = events.map((e) => {
      const o = toClient(e);
      const end = e.windowEnd || e.dueDate; // no window → due date is the cutoff
      // Overdue only once the clinical window has closed; between due date and
      // window end the visit is "due now, still in window".
      o.overdue = end < now;
      o.inWindow = e.dueDate <= now && now <= end;
      o.daysUntil = Math.round((e.dueDate - now) / DAY);
      o.daysToWindowEnd = Math.round((end - now) / DAY);
      return o;
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Per-patient timeline (all events, any status), soonest first.
app.get('/api/schedule', auth, async (req, res) => {
  try {
    const q = { ashaId: req.user.id };
    if (req.query.patientId) q.patientId = req.query.patientId;
    const events = await ScheduleEvent.find(q).sort({ dueDate: 1 }).limit(500);
    res.json({ success: true, data: events.map(toClient) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Mark an event done / missed / skipped (worker tap on the shortlist).
app.patch('/api/schedule/:id', auth, async (req, res) => {
  try {
    const { status, doneDate, record } = req.body || {};
    const allowed = ['pending', 'done', 'missed', 'skipped'];
    const set = {};
    if (status && allowed.includes(status)) set.status = status;
    if (status === 'done') set.doneDate = doneDate ? new Date(doneDate) : new Date();
    if (record && typeof record === 'object') set.record = record;
    const event = await ScheduleEvent.findOneAndUpdate(
      { _id: req.params.id, ashaId: req.user.id },
      { $set: set },
      { new: true },
    );
    if (!event) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: toClient(event) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Log that the worker reminded the patient (Call / WhatsApp / SMS). Records the
// channel + timestamp so a phone call is tracked just like an SMS/WhatsApp.
app.post('/api/schedule/:id/remind', auth, async (req, res) => {
  try {
    const allowed = ['call', 'whatsapp', 'sms'];
    const channel = allowed.includes((req.body || {}).channel) ? req.body.channel : 'call';
    const at = new Date();
    const event = await ScheduleEvent.findOneAndUpdate(
      { _id: req.params.id, ashaId: req.user.id },
      {
        $push: { reminderLog: { channel, at } },
        $set: { lastRemindedAt: at, lastReminderChannel: channel },
      },
      { new: true },
    );
    if (!event) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: toClient(event) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Aadhaar autofill (on-VPS; image discarded, nothing stored) ────────────────
// The phone POSTs the Aadhaar photo bytes. We FIRST try to decode the Secure QR
// (UIDAI-signed → far more accurate, gives full demographics incl. address);
// if no QR, we fall back to Tesseract text-OCR. The image is deleted / never
// stored (Aadhaar Act / data minimization); only masked number + demographics
// are returned.
const imageRawParser = express.raw({ type: () => true, limit: '10mb' });

function maskAadhaarServer(s) {
  const d = (s || '').replace(/\D/g, '');
  return d.length >= 4 ? `XXXX-XXXX-${d.slice(-4)}` : '';
}

// ---- Text-OCR fallback ----
function parseAadhaarText(text) {
  const out = { source: 'ocr', name: null, dob: null, gender: null, aadhaar: null };
  const a = text.match(/\b(\d{4}\s?\d{4}\s?\d{4})\b/);
  if (a) out.aadhaar = maskAadhaarServer(a[1]);
  const d = text.match(/(\d{2}[/-]\d{2}[/-]\d{4})/) ||
            text.match(/year of birth\D*(\d{4})/i);
  if (d) out.dob = d[1];
  if (/female|মহিলা|महिला/i.test(text)) out.gender = 'Female';
  else if (/\bmale\b|पुरुষ|पुरुष/i.test(text)) out.gender = 'Male';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const di = lines.findIndex((l) => /\d{2}[/-]\d{2}[/-]\d{4}|year of birth/i.test(l));
  if (di > 0) {
    const c = lines[di - 1];
    if (/^[A-Za-z][A-Za-z .]{2,}$/.test(c) && !/government|india|male|female/i.test(c)) {
      out.name = c;
    }
  }
  return out;
}

// ---- QR decode (preferred) ----
function _xmlAttr(s, k) { const m = s.match(new RegExp(`${k}="([^"]*)"`)); return m ? m[1] : ''; }

// Older "PrintLetterBarcodeData" XML QR.
function parseXmlAadhaar(s) {
  const name = _xmlAttr(s, 'name');
  if (!name) return null;
  const g = _xmlAttr(s, 'gender');
  const parts = ['house', 'street', 'lm', 'loc', 'vtc', 'po', 'subdist', 'dist', 'state', 'pc']
    .map((k) => _xmlAttr(s, k)).filter(Boolean);
  return {
    source: 'qr',
    name,
    dob: _xmlAttr(s, 'dob') || _xmlAttr(s, 'yob'),
    gender: g === 'F' ? 'Female' : g === 'M' ? 'Male' : null,
    aadhaar: maskAadhaarServer(_xmlAttr(s, 'uid')),
    address: parts.join(', '),
    district: _xmlAttr(s, 'dist'),
    pincode: _xmlAttr(s, 'pc'),
    careOf: _xmlAttr(s, 'co'),
  };
}

// Newer numeric "Secure QR" (big integer → [gzip] → 0xFF-delimited fields).
function parseSecureAadhaar(s) {
  try {
    let n = BigInt(s);
    const bytes = [];
    while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
    let data = Buffer.from(bytes);
    try { data = zlib.gunzipSync(data); } catch (_) { /* v1: not gzipped */ }
    const f = [];
    let start = 0;
    for (let i = 0; i < data.length && f.length < 16; i++) {
      if (data[i] === 255) { f.push(data.slice(start, i).toString('utf8')); start = i + 1; }
    }
    if (f.length < 5 || !f[2]) return null;
    const refId = f[1] || '', g = f[4] || '';
    const last4 = refId.slice(0, 4);
    const addr = [f[8], f[13], f[7], f[9], f[15], f[11], f[14], f[6], f[12], f[10]]
      .filter(Boolean).join(', '); // house,street,landmark,loc,vtc,po,subdist,dist,state,pin
    return {
      source: 'qr',
      name: f[2],
      dob: f[3] || '',
      gender: g === 'F' ? 'Female' : g === 'M' ? 'Male' : null,
      aadhaar: /^\d{4}$/.test(last4) ? `XXXX-XXXX-${last4}` : '',
      address: addr,
      district: f[6] || '',
      pincode: f[10] || '',
      careOf: f[5] || '',
    };
  } catch (_) { return null; }
}

function parseAadhaarQrString(s) {
  s = (s || '').trim();
  if (!s) return null;
  if (s.startsWith('<?xml') || s.includes('PrintLetterBarcodeData')) return parseXmlAadhaar(s);
  if (/^\d+$/.test(s)) return parseSecureAadhaar(s);
  return null;
}

// Run jsQR over one prepared Jimp image (both polarities — Aadhaar QRs are
// dark-on-light but phone glare / inversion can flip that).
function _scanJimp(img) {
  const { data, width, height } = img.bitmap; // RGBA
  const code = jsQR(new Uint8ClampedArray(data), width, height,
    { inversionAttempts: 'attemptBoth' });
  return code && code.data ? code.data : null;
}

// Normalize a photo to a QR-locator-friendly size: a phone photo of the whole
// card puts the QR in a small region, so we want enough resolution there
// without making jsQR crawl over a 4000px frame. Target ~1600px on the long
// edge (upscale tiny crops, downscale huge photos).
function _fitForQr(img) {
  const w = img.bitmap.width;
  if (w < 900) img.scale(Math.min(3, Math.ceil(1600 / w)));
  else if (w > 2200) img.scale(2200 / w);
  return img;
}

async function decodeAadhaarQr(bytes) {
  if (!Jimp || !jsQR) return null;
  try {
    const base = await Jimp.read(bytes);
    // Try progressively-enhanced variants and stop at the first decode. QR
    // locators are sensitive to size and contrast; a single pass on a raw
    // full-card photo (glare, skew, JPEG noise) fails far too often.
    const variants = [
      (im) => _fitForQr(im),
      (im) => _fitForQr(im).greyscale().normalize(),
      (im) => _fitForQr(im).greyscale().contrast(0.35).normalize(),
    ];
    for (const make of variants) {
      let s = null;
      try { s = _scanJimp(make(base.clone())); } catch (_) { /* try next */ }
      if (s) {
        const parsed = parseAadhaarQrString(s);
        if (parsed && parsed.name) return parsed;
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

app.post('/api/ocr/aadhaar', auth, imageRawParser, async (req, res) => {
  if (!req.body || !req.body.length) {
    return res.status(400).json({ success: false, message: 'image required' });
  }
  // 1) Preferred: decode the Secure QR (signed, full demographics).
  const qr = await decodeAadhaarQr(req.body);
  if (qr && qr.name) return res.json({ success: true, ...qr });

  // 2) Fallback: Tesseract text-OCR.
  if (!tesseract) {
    return res.json({ success: false, message: 'QR not found and OCR not available' });
  }
  const tmp = path.join(os.tmpdir(),
      `aad_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
  try {
    fs.writeFileSync(tmp, req.body);
    const text = await tesseract.recognize(tmp, { lang: 'eng', oem: 1, psm: 3 });
    const parsed = parseAadhaarText(text);
    // Don't claim success on an empty read — that produced a green "filled"
    // banner with no data. Require at least one usable field; otherwise tell
    // the worker to re-shoot the QR (or type it).
    if (!parsed.name && !parsed.aadhaar && !parsed.dob && !parsed.gender) {
      return res.json({
        success: false,
        source: 'ocr',
        message: 'QR না পড়ায় OCR করা হয়েছে, কিন্তু কিছু পড়া যায়নি — QR কোডটি স্পষ্ট করে আবার তুলুন।',
      });
    }
    res.json({ success: true, ...parsed });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
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
      // Escalate up HER chain only — ANM → BMHO → CMHO. Not every admin in the
      // district: an ANM in another block cannot act on this and should not see
      // the patient.
      notifySupervisors(req.user.id, {
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

app.get('/api/admin/workers', auth, requireSupervisor, async (req, res) => {
  try {
    // The level directly below the requester: ANM→ASHAs, BMHO→ANMs, CMHO→BMHOs.
    const workers = await directReports(req.user);

    // Enrich each row with the aggregate that makes the list usable: for a
    // supervisor child it's their WHOLE subtree (so a BMHO sees how big each
    // ANM's team is and how active it is); for an ASHA it's her own numbers.
    const data = await Promise.all(workers.map(async (w) => {
      const obj = toClient(w);
      const wid = w._id.toString();
      const isLeaf = effectiveRole(w) === 'asha_worker';
      const ashaIds = isLeaf ? [wid] : await subtreeAshaIds({ id: wid });
      obj.teamSize = isLeaf ? 0 : ashaIds.length;

      const A = { ashaId: { $in: ashaIds } };
      const [patientCount, reportCount, redCount] = await Promise.all([
        Patient.countDocuments(A),
        Report.countDocuments({
          ...A,
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
        }),
        Report.countDocuments({ ...A, finalBand: 'RED' }),
      ]);
      obj.patientCount = patientCount;
      obj.reportCount = reportCount;
      obj.redCount = redCount;
      return obj;
    }));

    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Members at my child-level who aren't attached to anyone yet. This is how an
// existing ANM (orphaned by the migration) gets slotted under a newly created
// BMHO — without it the tree could never be assembled above the ANM.
app.get('/api/admin/unassigned', auth, requireSupervisor, async (req, res) => {
  try {
    const childRole = CHILD_ROLE[effectiveRole(req.user)];
    if (!childRole) return res.json({ success: true, data: [] });
    const list = await User.find({
      role: childRole,
      $or: [{ supervisorId: null }, { supervisorId: { $exists: false } }],
    }).select('-otp -otpExpiry');
    res.json({ success: true, data: list.map(toClient) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Re-parent a member (adopt an unassigned one, or move someone already inside
// my subtree). Guardrails: you may only touch someone who is unattached or
// already yours, and the new supervisor must be you or someone in your subtree
// — so a BMHO can never poach out of another block.
app.patch('/api/admin/workers/:id/supervisor', auth, requireSupervisor, async (req, res) => {
  try {
    const { supervisorId } = req.body;
    if (!supervisorId)
      return res.status(400).json({ success: false, message: 'supervisorId required' });
    if (supervisorId.toString() === req.params.id.toString())
      return res.status(400).json({ success: false, message: 'Cannot report to self' });

    const target = await User.findById(req.params.id).select('supervisorId');
    if (!target) return res.status(404).json({ success: false, message: 'User not found' });

    const isOrphan = !target.supervisorId;
    if (!isOrphan && !(await inSubtree(req.user, req.params.id)))
      return res.status(403).json({ success: false, message: 'Not in your team' });
    if (!(await inSubtree(req.user, supervisorId)))
      return res.status(403).json({ success: false, message: 'Target supervisor not in your team' });

    await User.findByIdAndUpdate(req.params.id, { supervisorId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/admin/workers', auth, requireSupervisor, async (req, res) => {
  try {
    // A supervisor can only create the level directly below their own role,
    // and the new user is rooted under them (supervisorId), inheriting scope.
    const childRole = CHILD_ROLE[effectiveRole(req.user)];
    if (!childRole)
      return res.status(403).json({ success: false, message: 'Your role cannot create users' });
    const me = await User.findById(req.user.id).select('block district subCentre');
    const worker = await User.create({
      ...req.body,
      role: childRole,
      supervisorId: req.user.id,
      isAdmin: childRole !== 'asha_worker',
      // Inherit geography unless the caller supplied it explicitly.
      district: req.body.district ?? me?.district ?? '',
      block:    req.body.block    ?? me?.block    ?? '',
    });
    const welcome = {
      asha_worker: { t: 'আশামিত্রে স্বাগতম, দিদি', b: 'আপনি এখন রোগী যোগ করতে ও ভয়েস ট্রায়াজ শুরু করতে পারেন।', l: '/home' },
      anm:  { t: 'স্বাগতম — ANM প্যানেল', b: 'আপনার ASHA-দের রেকর্ড ও রিপোর্ট এখানে দেখুন।', l: '/admin' },
      bmho: { t: 'স্বাগতম — BMHO প্যানেল', b: 'আপনার ব্লকের ANM ও ASHA-দের তথ্য এখানে।', l: '/admin' },
    }[childRole] ?? { t: 'স্বাগতম', b: '', l: '/home' };
    notifyUser({ recipientId: worker._id, type: 'welcome', title: welcome.t, body: welcome.b, link: welcome.l });
    res.status(201).json({ success: true, data: toClient(worker) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch('/api/admin/workers/:id/deactivate', auth, requireSupervisor, async (req, res) => {
  try {
    if (!(await inSubtree(req.user, req.params.id)))
      return res.status(403).json({ success: false, message: 'Not in your team' });
    await User.findByIdAndUpdate(req.params.id, { isActive: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.patch('/api/admin/workers/:id/activate', auth, requireSupervisor, async (req, res) => {
  try {
    if (!(await inSubtree(req.user, req.params.id)))
      return res.status(403).json({ success: false, message: 'Not in your team' });
    await User.findByIdAndUpdate(req.params.id, { isActive: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/reports', auth, requireSupervisor, async (req, res) => {
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
    // Base scope: only ASHAs anywhere in the requester's subtree. Any explicit
    // worker/district/block filter is INTERSECTED with this — a supervisor can
    // never query outside their own team.
    const scopeIds = await subtreeAshaIds(req.user);
    const scopeSet = new Set(scopeIds);
    if (req.query.worker) {
      filter.ashaId = scopeSet.has(req.query.worker) ? req.query.worker : null;
    } else if (req.query.district || req.query.block) {
      const workerFilter = {};
      if (req.query.district) {
        workerFilter.district = { $regex: `^${escapeRegex(req.query.district)}$`, $options: 'i' };
      }
      if (req.query.block) {
        workerFilter.block = { $regex: `^${escapeRegex(req.query.block)}$`, $options: 'i' };
      }
      const workers = await User.find(workerFilter).select('_id');
      const ids = workers.map(w => w._id.toString()).filter(id => scopeSet.has(id));
      filter.ashaId = ids.length ? { $in: ids } : null;
    } else {
      filter.ashaId = scopeIds.length ? { $in: scopeIds } : null;
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
app.get('/api/admin/reports/deleted', auth, requireSupervisor, async (req, res) => {
  try {
    const scopeIds = await subtreeAshaIds(req.user);
    const reports = await Report.find({ deletedAt: { $ne: null }, ashaId: { $in: scopeIds } })
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
app.patch('/api/admin/reports/:id/restore', auth, requireSupervisor, async (req, res) => {
  try {
    const existing = await Report.findById(req.params.id).select('ashaId');
    if (!existing) return res.status(404).json({ success: false, message: 'Report not found' });
    if (!(await inSubtree(req.user, existing.ashaId)))
      return res.status(403).json({ success: false, message: 'Not in your team' });
    const report = await Report.findByIdAndUpdate(
      req.params.id,
      { deletedAt: null },
      { new: true },
    );
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
app.delete('/api/admin/reports/:id/permanent', auth, requireSupervisor, async (req, res) => {
  try {
    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ success: false, message: 'Report not found' });
    if (!(await inSubtree(req.user, report.ashaId)))
      return res.status(403).json({ success: false, message: 'Not in your team' });
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
app.get('/api/admin/locations', auth, requireSupervisor, async (req, res) => {
  try {
    // Only the districts/blocks present within the requester's own subtree.
    const ids = await subtreeUserIds(req.user.id);
    const [districts, blocks] = await Promise.all([
      User.distinct('district', { _id: { $in: ids }, district: { $nin: [null, ''] } }),
      User.distinct('block',    { _id: { $in: ids }, block:    { $nin: [null, ''] } }),
    ]);
    res.json({ success: true, data: { districts: districts.sort(), blocks: blocks.sort() } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/stats', auth, requireSupervisor, async (req, res) => {
  try {
    // Everything is scoped to the ASHAs in the requester's own subtree.
    const scopeIds = await subtreeAshaIds(req.user);
    const A = { ashaId: { $in: scopeIds } };
    const [
      totalWorkers, totalPatients, totalReports, redReports, yellowReports, greenReports,
      // ── Module aggregates (within the subtree) ──
      ncdScreened, ncdHighRisk,
      tbPresumptive, tbOnTreatment,
      medLowStock,
      vitalPendingCrs,
      referralOpen,
    ] = await Promise.all([
      Promise.resolve(scopeIds.length),
      Patient.countDocuments(A),
      Report.countDocuments(A),
      Report.countDocuments({ ...A, finalBand: 'RED' }),
      Report.countDocuments({ ...A, finalBand: 'YELLOW' }),
      Report.countDocuments({ ...A, finalBand: 'GREEN' }),
      // NCD/CBAC: total screened + high-risk (score ≥ 4 or any symptom)
      NcdCbac.countDocuments(A),
      NcdCbac.countDocuments({ ...A, $or: [{ riskScore: { $gte: 4 } }, { 'symptoms.0': { $exists: true } }] }),
      // TB: presumptive (screening) + currently on DOTS
      TbCase.countDocuments({ ...A, stage: 'presumptive' }),
      TbCase.countDocuments({ ...A, stage: 'on_treatment' }),
      // Medicine stock: lines running low (threshold set & closing ≤ threshold)
      MedicineStock.countDocuments({
        ...A,
        lowStockThreshold: { $gt: 0 },
        $expr: { $lte: ['$closingStock', '$lowStockThreshold'] },
      }),
      // Vital events: births/deaths not yet registered with CRS
      VitalEvent.countDocuments({ ...A, registered: { $ne: true } }),
      // Referrals still open (not completed)
      Referral.countDocuments({ ...A, status: { $nin: ['completed', 'closed'] } }),
    ]);
    res.json({
      success: true,
      data: {
        totalWorkers, totalPatients, totalReports, redReports, yellowReports, greenReports,
        modules: {
          ncdScreened, ncdHighRisk,
          tbPresumptive, tbOnTreatment,
          medLowStock,
          vitalPendingCrs,
          referralOpen,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── District analytics — the CMHO's dashboard ────────────────────────────────
// Indicators follow the government's own HMIS key-indicator formulas. A CMHO
// cross-checks these against the HMIS portal, so a tile whose percentage
// disagrees destroys trust in the whole panel — hence the denominators here are
// deliberately MoHFW's (e.g. LBW% is over births WITH a recorded weight, not all
// births; institutional-delivery% is over total reported births).
//
// A percentage is null — never 0 — when there is no denominator, so the UI can
// show "—" instead of a confident, wrong zero.
//
// Everything is scoped to the caller's subtree and then broken down BY BLOCK,
// because district → block is the accountability axis a CMHO actually manages on.
app.get('/api/admin/district', auth, requireSupervisor, async (req, res) => {
  try {
    const months = Math.max(1, Math.min(24, Number(req.query.months) || 12));
    const since = new Date();
    since.setMonth(since.getMonth() - months);
    const now = new Date();
    const d30 = new Date(Date.now() - 30 * 86400000);

    const ashaIds = await subtreeAshaIds(req.user);
    if (!ashaIds.length) {
      return res.json({
        success: true,
        data: {
          periodMonths: months, indicators: {}, blocks: [],
          alerts: { maternalDeaths: [], infantDeaths: [], stockouts: [], silentAshas: [], overdueReferrals: [] },
        },
      });
    }

    const ashaDocs = await User.find({ _id: { $in: ashaIds } })
      .select('_id name block isActive').lean();
    const blockOf = new Map(ashaDocs.map(a => [String(a._id), a.block || 'অজানা']));
    const nameOf  = new Map(ashaDocs.map(a => [String(a._id), a.name || '—']));
    const A = { ashaId: { $in: ashaIds } };

    // Attribute every ASHA to the DIRECT REPORT they roll up under, so the same
    // indicators can rank the level immediately below the caller. Blocks are the
    // CMHO's axis, but a BMHO's whole subtree IS one block — he needs his ANMs
    // ranked, and an ANM needs her ASHAs. Same accountability, one level down.
    const directs = await directReports(req.user);
    const ownerOf = new Map(); // ashaId → direct-report id
    const teamMeta = new Map(); // direct-report id → { name, role }
    for (const d of directs) {
      const did = String(d._id);
      teamMeta.set(did, { name: d.name || '—', role: effectiveRole(d) });
      const leaf = effectiveRole(d) === 'asha_worker';
      const ids = leaf ? [did] : await subtreeAshaIds({ id: did });
      for (const a of ids) ownerOf.set(String(a), did);
    }

    const [births, deaths, pregnancies, ancDone, vac, pncDone, referrals, lowStock, activeEvents, reports] =
      await Promise.all([
        VitalEvent.find({ ...A, eventType: 'birth', eventDate: { $gte: since } }).lean(),
        VitalEvent.find({ ...A, eventType: 'death', eventDate: { $gte: since } }).lean(),
        // Pregnancies REGISTERED in the window. Previously this was every
        // pregnancy ever, so the header said "last 12 months" while the number
        // was lifetime — and switching 12mo→3mo changed nothing.
        Patient.find({ ...A, type: { $regex: /^pregnan/i }, createdAt: { $gte: since } })
          .select('_id ashaId lmp createdAt mcpDetails').lean(),
        // All completed ANC (needed to know how many a woman has had), but with
        // doneDate so the 4th visit is attributed to the period it happened in —
        // HMIS counts EVENTS in a month, not lifetime cohorts.
        ScheduleEvent.find({ ...A, kind: 'anc', status: 'done' })
          .select('patientId ashaId doneDate').lean(),
        // Carry the patient identity too: an officer cannot act on the number
        // "13" — they need to know WHO is overdue, for what, and whose ASHA.
        ScheduleEvent.find({ ...A, kind: 'vaccine' })
          .select('ashaId status windowEnd dueDate label patientId patientName patientMobile').lean(),
        // PNC/HBNC visits DONE in the window (not every one ever performed).
        ScheduleEvent.find({ ...A, kind: { $in: ['hbnc', 'pnc'] }, status: 'done', doneDate: { $gte: since } })
          .select('ashaId').lean(),
        // All referrals: closure % is computed over those RAISED in the window,
        // but "still stranded" must stay a snapshot of NOW — a referral that has
        // been open 400 days must not vanish because the window is 3 months.
        Referral.find({ ...A }).select('ashaId status band createdAt patientName village').lean(),
        MedicineStock.find({
          ...A, lowStockThreshold: { $gt: 0 },
          $expr: { $lte: ['$closingStock', '$lowStockThreshold'] },
        }).select('ashaId medicineName closingStock lowStockThreshold').lean(),
        ScheduleEvent.find({ ...A, status: 'done', doneDate: { $gte: d30 } }).select('ashaId').lean(),
        Report.find({
          ...A, createdAt: { $gte: since },
          $or: [{ deletedAt: null }, { deletedAt: { $exists: false } }],
        }).select('ashaId finalBand').lean(),
      ]);

    const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
    const kg = (s) => {
      const v = parseFloat(String(s || '').replace(/[^0-9.]/g, ''));
      return Number.isFinite(v) && v > 0 ? v : null;
    };

    const blocks = new Map();
    const B = (id) => {
      const b = blockOf.get(String(id)) || 'অজানা';
      if (!blocks.has(b)) {
        blocks.set(b, {
          block: b, ashas: 0, births: 0, institutional: 0, caesarean: 0,
          lbw: 0, lbwWeighed: 0, maternalDeaths: 0, infantDeaths: 0,
          vacDue: 0, vacDone: 0, vacOverdue: 0, reports: 0, red: 0,
        });
      }
      return blocks.get(b);
    };
    // Per-direct-report accumulator — the same shape as the block one.
    const team = new Map();
    const T = (id) => {
      const owner = ownerOf.get(String(id));
      if (!owner) return null;
      if (!team.has(owner)) {
        const m = teamMeta.get(owner) || { name: '—', role: '' };
        team.set(owner, {
          id: owner, name: m.name, role: m.role,
          ashas: 0, births: 0, institutional: 0, caesarean: 0,
          lbw: 0, lbwWeighed: 0, maternalDeaths: 0, infantDeaths: 0,
          vacDue: 0, vacDone: 0, vacOverdue: 0, reports: 0, red: 0,
        });
      }
      return team.get(owner);
    };

    // Apply one increment to BOTH rollups, so block and team can never drift.
    const both = (ashaId, fn) => {
      const b = B(ashaId); if (b) fn(b);
      const t = T(ashaId); if (t) fn(t);
    };

    for (const a of ashaDocs) both(a._id, r => r.ashas++);

    // Births → institutional delivery, C-section, SBA attendance, LBW.
    let nBirths = 0, inst = 0, cs = 0, sba = 0, lbw = 0, weighed = 0;
    for (const b of births) {
      nBirths++;
      both(b.ashaId, r => r.births++);
      if (b.place === 'institution') { inst++; both(b.ashaId, r => r.institutional++); }
      if (b.deliveryType === 'caesarean') { cs++; both(b.ashaId, r => r.caesarean++); }
      if (['doctor', 'anm', 'sba'].includes(b.attendedBy)) sba++;
      const w = kg(b.birthWeight);
      if (w !== null) {
        weighed++;
        both(b.ashaId, r => r.lbwWeighed++);
        if (w < 2.5) { lbw++; both(b.ashaId, r => r.lbw++); }
      }
    }

    // Deaths → MDSR / CDR. These are the CMHO's hardest escalations.
    const maternalDeaths = deaths.filter(d => d.maternalDeath);
    const infantDeaths = deaths.filter(d => d.infantDeath);
    for (const d of maternalDeaths) both(d.ashaId, r => r.maternalDeaths++);
    for (const d of infantDeaths) both(d.ashaId, r => r.infantDeaths++);

    // ANC → 1st-trimester registration and 4+ visits, per HMIS.
    //
    // HMIS derives "PW given 4+ ANC" as an EVENT counted in the reporting month:
    // the woman's 4th check-up happened in this window. It is not a cohort
    // follow-up of women registered in the window (a woman registered in month 1
    // gets her 4th visit in month 8 — a cohort reading would report ~0%).
    const ancDates = new Map(); // patientId → [doneDate, …]
    for (const e of ancDone) {
      if (!e.doneDate) continue;
      const k = String(e.patientId);
      if (!ancDates.has(k)) ancDates.set(k, []);
      ancDates.get(k).push(new Date(e.doneDate));
    }
    let anc4 = 0;
    for (const [, dates] of ancDates) {
      if (dates.length < 4) continue;
      dates.sort((a, b) => a - b);
      const fourth = dates[3]; // her 4th ANC
      if (fourth >= since) anc4++; // …happened inside this window
    }

    // Registration-side indicators, over women REGISTERED in the window.
    let firstTri = 0, highRisk = 0;
    for (const p of pregnancies) {
      if (p.lmp && p.createdAt) {
        const wks = (new Date(p.createdAt) - new Date(p.lmp)) / (7 * 86400000);
        if (wks >= 0 && wks < 12) firstTri++;
      }
      if (p.mcpDetails && p.mcpDetails.highRisk === true) highRisk++;
    }

    // Immunization → coverage and defaulters (pending past the clinical window).
    // Coverage is period-scoped: of the doses that came DUE inside this window,
    // how many were actually given? Defaulters are deliberately NOT — "who is
    // overdue" is a snapshot of NOW, and hiding a child who fell overdue last
    // year just because the window is 3 months would be the worst kind of
    // reassuring lie.
    let vacDue = 0, vacDone = 0, vacOverdue = 0;
    const defaulterRows = []; // the actual children, not just the count
    for (const e of vac) {
      const due = e.dueDate ? new Date(e.dueDate) : null;
      if (due && due >= since) {
        vacDue++;
        both(e.ashaId, r => r.vacDue++);
        if (e.status === 'done') {
          vacDone++;
          both(e.ashaId, r => r.vacDone++);
        }
      }
      if (e.status === 'pending') {
        const end = e.windowEnd || e.dueDate;
        if (end && new Date(end) < now) {
          vacOverdue++;
          both(e.ashaId, r => r.vacOverdue++);
          defaulterRows.push({
            id: String(e._id),
            patientId: e.patientId ? String(e.patientId) : '',
            patientName: e.patientName || '—',
            patientMobile: e.patientMobile || '',
            label: e.label || '',
            daysOverdue: Math.floor((now - new Date(end)) / 86400000),
            asha: nameOf.get(String(e.ashaId)) || '—',
            block: blockOf.get(String(e.ashaId)) || 'অজানা',
          });
        }
      }
    }
    // Longest-overdue first — that's the order an officer works the list in.
    defaulterRows.sort((a, b) => b.daysOverdue - a.daysOverdue);

    for (const rep of reports) {
      both(rep.ashaId, r => r.reports++);
      if (String(rep.finalBand).toUpperCase() === 'RED') {
        both(rep.ashaId, r => r.red++);
      }
    }

    // ── Previous equivalent window ─────────────────────────────────────────
    // "Are we improving?" is the question a monthly review actually asks, and a
    // snapshot cannot answer it. Only birth/death-derived indicators go here:
    // they are cleanly event-dated, so a like-for-like comparison is honest.
    const prevSince = new Date(since);
    prevSince.setMonth(prevSince.getMonth() - months);

    const [prevBirths, prevDeaths] = await Promise.all([
      VitalEvent.find({ ...A, eventType: 'birth', eventDate: { $gte: prevSince, $lt: since } })
        .select('place deliveryType attendedBy birthWeight').lean(),
      VitalEvent.find({ ...A, eventType: 'death', eventDate: { $gte: prevSince, $lt: since } })
        .select('maternalDeath infantDeath').lean(),
    ]);

    let qB = 0, qInst = 0, qCs = 0, qSba = 0, qLbw = 0, qWeighed = 0;
    for (const b of prevBirths) {
      qB++;
      if (b.place === 'institution') qInst++;
      if (b.deliveryType === 'caesarean') qCs++;
      if (['doctor', 'anm', 'sba'].includes(b.attendedBy)) qSba++;
      const w = kg(b.birthWeight);
      if (w !== null) { qWeighed++; if (w < 2.5) qLbw++; }
    }

    const prev = {
      births: qB,
      institutionalDeliveryPct: pct(qInst, qB),
      cSectionPct: pct(qCs, qB),
      sbaAttendedPct: pct(qSba, qB),
      lbwPct: pct(qLbw, qWeighed),
      maternalDeaths: prevDeaths.filter(d => d.maternalDeath).length,
      infantDeaths: prevDeaths.filter(d => d.infantDeath).length,
    };

    // "Silent" ASHAs — no completed visit in 30 days. HMIS calls the facility
    // equivalent zero-reporting; it's the first thing a CMHO chases.
    const activeSet = new Set(activeEvents.map(e => String(e.ashaId)));
    const silentAshas = ashaDocs
      .filter(a => a.isActive !== false && !activeSet.has(String(a._id)))
      .map(a => ({ id: String(a._id), name: a.name || '—', block: a.block || 'অজানা' }));

    // Closure is measured on referrals RAISED inside the window…
    const inWindow = referrals.filter(
      r => r.createdAt && new Date(r.createdAt) >= since);
    const refsRaised = inWindow.length;
    const refsClosed =
      inWindow.filter(r => ['reached', 'completed'].includes(r.status)).length;

    // …but "still stranded" is a snapshot of NOW. A referral open for 400 days
    // must not disappear from the alert just because the window is 3 months.
    const openReferrals = referrals.filter(r => !['reached', 'completed', 'cancelled'].includes(r.status));
    const overdueReferrals = openReferrals
      .filter(r => r.createdAt && now - new Date(r.createdAt) > 7 * 86400000)
      .map(r => ({
        patientName: r.patientName || '—', village: r.village || '', band: r.band || '',
        days: Math.floor((now - new Date(r.createdAt)) / 86400000),
        block: blockOf.get(String(r.ashaId)) || 'অজানা',
      }))
      .sort((a, b) => b.days - a.days);

    res.json({
      success: true,
      data: {
        periodMonths: months,
        indicators: {
          ashas: ashaDocs.length,
          pregnanciesRegistered: pregnancies.length,
          ancFirstTrimesterPct: pct(firstTri, pregnancies.length),
          anc4PlusPct: pct(anc4, pregnancies.length),
          highRiskPregnancies: highRisk,
          births: nBirths,
          institutionalDeliveryPct: pct(inst, nBirths),
          cSectionPct: pct(cs, nBirths),
          sbaAttendedPct: pct(sba, nBirths),
          lbwPct: pct(lbw, weighed),
          lbwWeighed: weighed,
          // Of the doses that came DUE in this window, how many were given.
          immunizationCoveragePct: pct(vacDone, vacDue),
          // Snapshot of NOW — deliberately not windowed (see the loop above).
          immunizationDefaulters: vacOverdue,
          pncVisits: pncDone.length,
          maternalDeaths: maternalDeaths.length,
          infantDeaths: infantDeaths.length,
          // Closure over referrals RAISED in the window. One raised two years
          // ago and closed yesterday must not flatter this window.
          referralClosurePct: pct(refsClosed, refsRaised),
          openReferrals: openReferrals.length,
        },
        // The previous equivalent window, so the panel can answer the officer's
        // actual question — "are we improving?" — which a snapshot cannot.
        // Only the genuinely period-comparable indicators are here; comparing a
        // current-state count (like defaulters) against a past window would be
        // meaningless.
        prev,
        blocks: [...blocks.values()].map(b => ({
          ...b,
          institutionalPct: pct(b.institutional, b.births),
          lbwPct: pct(b.lbw, b.lbwWeighed),
          immunizationPct: pct(b.vacDone, b.vacDue),
        })).sort((x, y) => y.reports - x.reports),
        // The level directly below the caller, same indicators. This is what
        // makes the BMHO and ANM panels real: a BMHO ranks his ANMs, an ANM
        // ranks her ASHAs — blocks are only meaningful to a CMHO.
        team: [...team.values()].map(t => ({
          ...t,
          institutionalPct: pct(t.institutional, t.births),
          lbwPct: pct(t.lbw, t.lbwWeighed),
          immunizationPct: pct(t.vacDone, t.vacDue),
        })).sort((x, y) => y.reports - x.reports),
        // The immunisation defaulters themselves, capped so a huge district
        // can't blow up the payload. `immunizationDefaulters` stays the TRUE
        // total, so the UI can say "showing 100 of 240" rather than silently
        // truncating and looking like the problem is smaller than it is.
        defaulters: defaulterRows.slice(0, 100),
        defaultersTotal: defaulterRows.length,
        alerts: {
          maternalDeaths: maternalDeaths.map(d => ({
            name: d.personName || '—', village: d.village || '', date: d.eventDate,
            cause: d.causeOfDeath || '', block: blockOf.get(String(d.ashaId)) || 'অজানা',
          })),
          infantDeaths: infantDeaths.map(d => ({
            name: d.personName || '—', village: d.village || '', date: d.eventDate,
            age: d.ageAtDeath || '', block: blockOf.get(String(d.ashaId)) || 'অজানা',
          })),
          stockouts: lowStock.map(s => ({
            medicine: s.medicineName, left: s.closingStock, threshold: s.lowStockThreshold,
            asha: nameOf.get(String(s.ashaId)) || '—',
            block: blockOf.get(String(s.ashaId)) || 'অজানা',
          })),
          silentAshas,
          overdueReferrals,
        },
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Admin — per-worker data ───────────────────────────────────────────────────

app.get('/api/admin/workers/:id/patients', auth, requireSupervisor, async (req, res) => {
  try {
    if (!(await inSubtree(req.user, req.params.id)))
      return res.status(403).json({ success: false, message: 'Not in your team' });
    const patients = await Patient.find({ ashaId: req.params.id }).sort({ createdAt: -1 });
    res.json({ success: true, data: patients.map(toClient) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/workers/:id/reports', auth, requireSupervisor, async (req, res) => {
  try {
    if (!(await inSubtree(req.user, req.params.id)))
      return res.status(403).json({ success: false, message: 'Not in your team' });
    const reports = await Report.find({ ashaId: req.params.id }).sort({ createdAt: -1 });
    res.json({ success: true, data: reports.map(toClient) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/admin/workers/:id/profile', auth, requireSupervisor, async (req, res) => {
  try {
    if (!(await inSubtree(req.user, req.params.id)))
      return res.status(403).json({ success: false, message: 'Not in your team' });
    const user = await User.findById(req.params.id).select('-otp -otpExpiry');
    if (!user) return res.status(404).json({ success: false, message: 'Worker not found' });
    res.json({ success: true, data: toClient(user) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Direct reports of a specific member of my subtree — powers drilling down the
// tree (BMHO taps an ANM → sees that ANM's ASHAs, and so on).
app.get('/api/admin/workers/:id/team', auth, requireSupervisor, async (req, res) => {
  try {
    if (!(await inSubtree(req.user, req.params.id)))
      return res.status(403).json({ success: false, message: 'Not in your team' });
    const team = await User.find({ supervisorId: req.params.id }).select('-otp -otpExpiry');
    res.json({ success: true, data: team.map(toClient) });
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

// The app supports only three languages. Whisper auto-detect, however, only
// loosely distinguishes South-Asian languages and frequently MISLABELS spoken
// Bengali/Hindi as a neighbour with a different script — observed in the field:
//   Hindi → Urdu (Perso-Arabic),  Bengali → Gujarati / Assamese / Odia,
//   Bengali → Hindi (Devanagari).
// So any detected language is normalised to the nearest supported one. The
// audio is real Bengali or Hindi (or English); we just need the right script.
const SUPPORTED_LANGS = { bengali: 'bn', hindi: 'hi', english: 'en' };
// Family → supported language. Perso-Arabic + Devanagari-script tongues map to
// Hindi (Hindustani / Devanagari); Eastern-Indic, Gujarati and Dravidian map to
// Bengali (this is a West-Bengal, Bengali-primary deployment).
const LANG_TO_SUPPORTED = {
  bengali: 'bn', assamese: 'bn', oriya: 'bn', odia: 'bn', gujarati: 'bn',
  punjabi: 'bn', panjabi: 'bn', tamil: 'bn', telugu: 'bn', kannada: 'bn',
  malayalam: 'bn', sinhala: 'bn', sinhalese: 'bn',
  hindi: 'hi', urdu: 'hi', arabic: 'hi', persian: 'hi', farsi: 'hi',
  pashto: 'hi', nepali: 'hi', marathi: 'hi', sanskrit: 'hi', maithili: 'hi',
  konkani: 'hi', dogri: 'hi',
  english: 'en',
};
const SUPPORTED_TO_NAME = { bn: 'bengali', hi: 'hindi', en: 'english' };

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

    // Language normalisation (auto-detect only). Decide which supported language
    // Whisper SHOULD have used, then re-transcribe forcing it so the worker's
    // words come back in the correct script — and the app's session language,
    // reply and voice all follow it downstream.
    if (wantAuto) {
      const detected = (language || '').toLowerCase().trim();
      let target = null;
      if (detected === 'hindi' && looksLikeBengaliInDevanagari(text)) {
        // Bengali spoken but written in Devanagari and labelled Hindi.
        target = 'bn';
      } else if (detected && !SUPPORTED_LANGS[detected]) {
        // Detected an UNSUPPORTED language (urdu, gujarati, assamese …) — a
        // mis-detection of one of our three. Map it to the nearest supported.
        target = LANG_TO_SUPPORTED[detected] || 'bn';
      }
      if (target) {
        try {
          const re = await groqTranscribe(key, req.body, ctype, ext, target);
          const reText = (re.text || '').trim();
          if (reText) { text = reText; language = SUPPORTED_TO_NAME[target]; }
        } catch (e) {
          console.warn(`[transcribe] re-transcribe (${target}) failed:`, e.message);
        }
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

// ── Report PDF — server-side render ─────────────────────────────────────────
// The app posts fully self-contained HTML (SolaimanLipi embedded as base64) and
// we render it to a PDF with headless Chromium, so Bengali shaping is perfect
// and doesn't depend on the worker's (often budget) phone WebView. One shared
// browser instance is reused across requests.
let _pdfBrowser = null;
async function _getPdfBrowser() {
  let puppeteer;
  try { puppeteer = require('puppeteer'); }
  catch { throw new Error('puppeteer not installed — run `npm install` on the server'); }
  if (_pdfBrowser && _pdfBrowser.connected) return _pdfBrowser;
  _pdfBrowser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  return _pdfBrowser;
}

app.post('/api/report/pdf', auth, async (req, res) => {
  const { html, landscape } = req.body || {};
  if (!html || typeof html !== 'string') {
    return res.status(400).json({ success: false, message: 'html required' });
  }
  let page;
  try {
    const browser = await _getPdfBrowser();
    page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
    const pdf = await page.pdf({
      printBackground: true,
      landscape: !!landscape,
      format: 'A4',
      margin: { top: '12mm', bottom: '12mm', left: '9mm', right: '9mm' },
    });
    res.set('Content-Type', 'application/pdf');
    res.send(pdf);
  } catch (e) {
    console.error('[report/pdf]', e.message);
    res.status(500).json({ success: false, message: e.message });
  } finally {
    if (page) { try { await page.close(); } catch (_) {} }
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`AshaМітра backend running on port ${PORT}`));
