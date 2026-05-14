import express from 'express';
import { listCronRuns, cronRunsSummary } from '../controllers/cronRunsController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/summary', authenticate, requirePermission('cron_runs', 'read'), cronRunsSummary);
router.get('/',        authenticate, requirePermission('cron_runs', 'read'), listCronRuns);

export default router;
