const User   = require('../models/User');
const Report = require('../models/Report');

// ── GET /api/admin/workers ────────────────────────────────────────────────────
exports.getWorkers = async (req, res) => {
  try {
    const workers = await User.find({ role: 'asha_worker' })
      .select('-otp -otpExpiresAt')
      .sort({ createdAt: -1 });
    res.json({ success: true, data: workers });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── POST /api/admin/workers ───────────────────────────────────────────────────
exports.addWorker = async (req, res) => {
  try {
    const { phone, name, block = '', district = '' } = req.body;
    if (!phone || !name) {
      return res.status(400).json({ success: false, message: 'Phone and name required.' });
    }

    const trimmedPhone = phone.trim();
    const existing = await User.findOne({ phone: trimmedPhone });

    if (existing) {
      if (existing.isActive) {
        // Active worker with same phone — reject
        return res.status(409).json({ success: false, message: 'এই নম্বর ইতিমধ্যে নিবন্ধিত।' });
      }
      // Inactive worker — reactivate with updated details
      existing.name     = name.trim();
      existing.block    = block.trim();
      existing.district = district.trim();
      existing.isActive = true;
      await existing.save();
      return res.status(200).json({ success: true, data: existing });
    }

    const worker = await User.create({
      phone:    trimmedPhone,
      name:     name.trim(),
      role:     'asha_worker',
      block:    block.trim(),
      district: district.trim(),
      isActive: true,
    });
    res.status(201).json({ success: true, data: worker });
  } catch (err) {
    // Catch MongoDB duplicate key race condition
    if (err.code === 11000) {
      return res.status(409).json({ success: false, message: 'এই নম্বর ইতিমধ্যে নিবন্ধিত।' });
    }
    res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
};

// ── PATCH /api/admin/workers/:id/deactivate ───────────────────────────────────
exports.deactivateWorker = async (req, res) => {
  try {
    const worker = await User.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    ).select('-otp -otpExpiresAt');
    if (!worker) return res.status(404).json({ success: false, message: 'Worker not found.' });
    res.json({ success: true, data: worker });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── PATCH /api/admin/workers/:id/activate ────────────────────────────────────
exports.activateWorker = async (req, res) => {
  try {
    const worker = await User.findByIdAndUpdate(
      req.params.id,
      { isActive: true },
      { new: true }
    ).select('-otp -otpExpiresAt');
    if (!worker) return res.status(404).json({ success: false, message: 'Worker not found.' });
    res.json({ success: true, data: worker });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── DELETE /api/admin/workers/:id ────────────────────────────────────────────
exports.deleteWorker = async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Worker deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── GET /api/admin/reports ────────────────────────────────────────────────────
exports.getReports = async (req, res) => {
  try {
    const { filter, date, ashaId, band } = req.query;
    const query = {};

    if (filter && date) {
      const d = new Date(date);
      let start, end;
      if (filter === 'day') {
        start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        end   = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      } else if (filter === 'month') {
        start = new Date(d.getFullYear(), d.getMonth(), 1);
        end   = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      } else if (filter === 'year') {
        start = new Date(d.getFullYear(), 0, 1);
        end   = new Date(d.getFullYear() + 1, 0, 1);
      }
      if (start && end) query.createdAt = { $gte: start, $lt: end };
    }

    if (ashaId) query.ashaId = ashaId;
    if (band)   query.finalBand = band.toUpperCase();

    const reports = await Report.find(query).sort({ createdAt: -1 });

    const stats = {
      total:  reports.length,
      red:    reports.filter(r => r.finalBand === 'RED').length,
      yellow: reports.filter(r => r.finalBand === 'YELLOW').length,
      green:  reports.filter(r => r.finalBand === 'GREEN').length,
    };

    res.json({ success: true, stats, data: reports });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
exports.getStats = async (req, res) => {
  try {
    const [totalWorkers, totalReports, redReports, yellowReports] = await Promise.all([
      User.countDocuments({ role: 'asha_worker', isActive: true }),
      Report.countDocuments(),
      Report.countDocuments({ finalBand: 'RED' }),
      Report.countDocuments({ finalBand: 'YELLOW' }),
    ]);
    res.json({
      success: true,
      data: { totalWorkers, totalReports, redReports, yellowReports,
              greenReports: totalReports - redReports - yellowReports },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};
