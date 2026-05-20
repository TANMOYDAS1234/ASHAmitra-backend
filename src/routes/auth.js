const router = require('express').Router();
const { sendOtp, verifyOtp, getMe, updateProfile } = require('../controllers/authController');
const { protect } = require('../middleware/auth');

router.post('/send-otp',   sendOtp);
router.post('/verify-otp', verifyOtp);
router.get('/me',          protect, getMe);
router.put('/profile',     protect, updateProfile);

module.exports = router;
