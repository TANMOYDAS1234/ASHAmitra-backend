const Report = require('../models/Report');

// ── POST /api/reports ─────────────────────────────────────────────────────────
// Called by Flutter app after every triage session
exports.saveReport = async (req, res) => {
  try {
    const body = req.body;
    if (!body.sessionId || !body.moduleId) {
      return res.status(400).json({ success: false, message: 'sessionId and moduleId required.' });
    }

    // Normalise — guard against missing/wrong-case values
    body.caseType  = body.caseType  || body.moduleId;
    body.finalBand = (body.finalBand || 'UNKNOWN').toString().toUpperCase();
    if (!['RED', 'YELLOW', 'GREEN', 'UNKNOWN'].includes(body.finalBand)) {
      body.finalBand = 'UNKNOWN';
    }

    // Attach ASHA identity from JWT
    body.ashaId    = req.user.id    || body.ashaId    || '';
    body.ashaName  = req.user.name  || body.ashaName  || '';
    body.ashaPhone = req.user.phone || body.ashaPhone || '';

    // Upsert — safe to call multiple times for same session
    const report = await Report.findOneAndUpdate(
      { sessionId: body.sessionId },
      body,
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.status(201).json({ success: true, data: report });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// ── GET /api/reports/my ───────────────────────────────────────────────────────
// ASHA worker sees only their own reports
exports.getMyReports = async (req, res) => {
  try {
    const reports = await Report.find({ ashaId: req.user.id })
      .sort({ createdAt: -1 })
      .limit(100);
    res.json({ success: true, data: reports });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};
