const jwt  = require('jsonwebtoken');
const User = require('../models/User');

const signToken = (id) =>
  jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '30d',
  });

const generateOtp = () =>
  Math.floor(100000 + Math.random() * 900000).toString();

// ── POST /api/auth/send-otp ───────────────────────────────────────────────────
exports.sendOtp = async (req, res) => {
  try {
    const phone = req.body.phone?.toString().trim();
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone required.' });
    }

    // Find user in MongoDB — works for both admin and asha_worker
    const user = await User.findOne({ phone, isActive: true });
    if (!user) {
      return res.status(404).json({ success: false, message: 'এই নম্বর নিবন্ধিত নয়।' });
    }

    // Generate OTP — random in production, fixed 123456 in demo mode
    const otp = process.env.USE_REAL_OTP === 'true'
      ? generateOtp()
      : '123456';

    await user.setOtp(otp);
    await user.save();

    // TODO: send SMS via Twilio/MSG91 when USE_REAL_OTP=true
    // await smsService.send(phone, `Your ASHA Mitra OTP is ${otp}`);

    // Always log OTP to server console (visible during development)
    console.log(`[OTP] Phone: ${phone}  Role: ${user.role}  OTP: ${otp}`);

    const isPilot = process.env.USE_REAL_OTP !== 'true';
    res.json({ success: true, message: 'OTP পাঠানো হয়েছে।', ...(isPilot && { otp }) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────
exports.verifyOtp = async (req, res) => {
  try {
    const phone = req.body.phone?.toString().trim();
    const otp   = req.body.otp?.toString().trim();

    if (!phone || !otp) {
      return res.status(400).json({ success: false, message: 'Phone and OTP required.' });
    }
    if (otp.length !== 6) {
      return res.status(400).json({ success: false, message: 'OTP must be 6 digits.' });
    }

    const user = await User.findOne({ phone, isActive: true });
    if (!user) {
      return res.status(404).json({ success: false, message: 'ব্যবহারকারী পাওয়া যায়নি।' });
    }

    const valid = await user.verifyOtp(otp);
    if (!valid) {
      return res.status(401).json({ success: false, message: 'ভুল বা মেয়াদোত্তীর্ণ OTP।' });
    }

    user.clearOtp();
    await user.save();

    const token = signToken(user._id.toString());

    res.json({
      success: true,
      token,
      user: {
        id:               user._id.toString(),
        phone:            user.phone,
        name:             user.name,
        role:             user.role,
        block:            user.block,
        district:         user.district,
        language:         user.language,
        isActive:         user.isActive,
        profileImagePath: user.profileImagePath ?? null,  // ← include photo
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── PUT /api/auth/profile ─────────────────────────────────────────────────────
exports.updateProfile = async (req, res) => {
  try {
    const { name, block, district, profileImagePath } = req.body;
    const update = {};
    if (name  !== undefined) update.name     = name.trim();
    if (block !== undefined) update.block    = block.trim();
    if (district !== undefined) update.district = district.trim();
    if (profileImagePath !== undefined) update.profileImagePath = profileImagePath; // base64 or null

    const user = await User.findByIdAndUpdate(
      req.user._id,
      update,
      { new: true, select: '-otp -otpExpiresAt' }
    );
    res.json({
      success: true,
      user: {
        id:               user._id.toString(),
        phone:            user.phone,
        name:             user.name,
        role:             user.role,
        block:            user.block,
        district:         user.district,
        language:         user.language,
        isActive:         user.isActive,
        profileImagePath: user.profileImagePath ?? null,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
};

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
exports.getMe = (req, res) => {
  const u = req.user;
  res.json({
    success: true,
    user: {
      id:               u._id.toString(),
      phone:            u.phone,
      name:             u.name,
      role:             u.role,
      block:            u.block,
      district:         u.district,
      language:         u.language,
      isActive:         u.isActive,
      profileImagePath: u.profileImagePath ?? null,
    },
  });
};
