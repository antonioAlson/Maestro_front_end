import express from 'express';
import { listCronRuns, cronRunsSummary } from '../controllers/cronRunsController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

router.get('/summary', authenticate, cronRunsSummary);
router.get('/',        authenticate, listCronRuns);

export default router;
