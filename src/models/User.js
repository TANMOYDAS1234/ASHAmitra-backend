const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  phone:    { type: String, required: true, unique: true, trim: true },
  name:     { type: String, required: true, trim: true },
  role:     { type: String, enum: ['admin', 'asha_worker'], default: 'asha_worker' },
  block:    { type: String, default: '' },
  district: { type: String, default: '' },
  language: { type: String, default: 'Bengali (বাংলা)' },
  isActive: { type: Boolean, default: true },
  profileImagePath: { type: String, default: null },

  // OTP fields
  otp:          { type: String, default: null },
  otpExpiresAt: { type: Date,   default: null },
}, {
  timestamps: true,
});

// Hash OTP before saving
userSchema.methods.setOtp = async function (otp) {
  this.otp = await bcrypt.hash(otp, 10);
  this.otpExpiresAt = new Date(Date.now() + parseInt(process.env.OTP_EXPIRY_MINUTES || 10) * 60 * 1000);
};

userSchema.methods.verifyOtp = async function (otp) {
  if (!this.otp || !this.otpExpiresAt) return false;
  if (new Date() > this.otpExpiresAt) return false;
  return bcrypt.compare(otp, this.otp);
};

userSchema.methods.clearOtp = function () {
  this.otp = null;
  this.otpExpiresAt = null;
};

module.exports = mongoose.model('User', userSchema);
