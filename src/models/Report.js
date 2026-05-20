const mongoose = require('mongoose');

const reportSchema = new mongoose.Schema({
  sessionId:          { type: String, required: true, unique: true },
  caseType:           { type: String, required: true },
  caseLabel:          { type: String, default: '' },
  moduleId:           { type: String, required: true },
  finalBand:          { type: String, enum: ['RED', 'YELLOW', 'GREEN', 'UNKNOWN'], required: true },
  outcome:            { type: String, default: '' },
  reason:             { type: String, default: '' },
  nextStep:           { type: String, default: '' },
  situation:          { type: String, default: '' },
  triggeredRules:     [String],
  riskScore:          { type: Number, default: 0 },
  riskLevel:          { type: String, default: '' },
  dangerSigns:        [String],
  suspectedConditions:[String],
  facilityType:       { type: String, default: '' },
  recheckAfterHours:  { type: Number, default: 0 },
  patientId:          { type: String, default: '' },
  patientName:        { type: String, default: '' },
  ashaId:             { type: String, default: '' },
  ashaName:           { type: String, default: '' },
  ashaPhone:          { type: String, default: '' },
  qaHistory:          [{ question: String, answer: String }],
}, {
  timestamps: true,
});

// Index for fast date-range queries in admin panel
reportSchema.index({ createdAt: -1 });
reportSchema.index({ ashaId: 1, createdAt: -1 });
reportSchema.index({ finalBand: 1 });

module.exports = mongoose.model('Report', reportSchema);
