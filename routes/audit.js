import express from 'express';
import { listProjectAudit, listOsGenerationAudit } from '../controllers/auditController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/projects',      authenticate, requirePermission('audit_logs', 'read'), listProjectAudit);
router.get('/os-generation', authenticate, requirePermission('audit_logs', 'read'), listOsGenerationAudit);

export default router;
