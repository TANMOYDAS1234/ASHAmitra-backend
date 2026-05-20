const router = require('express').Router();
const {
  getWorkers, addWorker, deactivateWorker, activateWorker, deleteWorker,
  getReports, getStats,
} = require('../controllers/adminController');
const { protect, adminOnly } = require('../middleware/auth');

router.use(protect, adminOnly);

router.get('/stats',                    getStats);
router.get('/workers',                  getWorkers);
router.post('/workers',                 addWorker);
router.patch('/workers/:id/deactivate', deactivateWorker);
router.patch('/workers/:id/activate',   activateWorker);
router.delete('/workers/:id',           deleteWorker);
router.get('/reports',                  getReports);

module.exports = router;
