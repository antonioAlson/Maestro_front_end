import express from 'express';
import {
  listJobs, getJob, createJob, deleteJob,
  createVersion, updateVersion, deleteVersion, runVersion,
} from '../controllers/cronJobsController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/',    authenticate, requirePermission('cron_jobs', 'read'),    listJobs);
router.get('/:id', authenticate, requirePermission('cron_jobs', 'read'),    getJob);
router.post('/',   authenticate, requirePermission('cron_jobs', 'create'),  createJob);
router.delete('/:id', authenticate, requirePermission('cron_jobs', 'delete'), deleteJob);

router.post('/:id/versions',         authenticate, requirePermission('cron_jobs', 'create'),  createVersion);
router.patch('/:id/versions/:vid',   authenticate, requirePermission('cron_jobs', 'update'),  updateVersion);
router.delete('/:id/versions/:vid',  authenticate, requirePermission('cron_jobs', 'delete'),  deleteVersion);
router.post('/:id/versions/:vid/run', authenticate, requirePermission('cron_jobs', 'execute'), runVersion);

export default router;
