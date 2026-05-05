import express from 'express';
import { listProjectAudit, listOsGenerationAudit } from '../controllers/auditController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

router.get('/projects',      authenticate, listProjectAudit);
router.get('/os-generation', authenticate, listOsGenerationAudit);

export default router;
