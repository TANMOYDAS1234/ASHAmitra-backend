const router = require('express').Router();
const { saveReport, getMyReports } = require('../controllers/reportController');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post('/',   saveReport);
router.get('/my',  getMyReports);

module.exports = router;
