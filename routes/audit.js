import express from 'express';
import { listProjectAudit, listOsGenerationAudit, rollbackOsGenerationAudit } from '../controllers/auditController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/projects',      authenticate, requirePermission('audit_logs', 'read'), listProjectAudit);
router.get('/os-generation', authenticate, requirePermission('audit_logs', 'read'), listOsGenerationAudit);
router.post('/os-generation/:id/rollback', authenticate, requirePermission('audit_logs', 'export'), rollbackOsGenerationAudit);

export default router;
