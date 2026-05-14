import express from 'express';
import { upload } from '../middleware/upload.js';
import {
  uploadFile,
  downloadFile,
  attachFile,
  removeAttachment,
  getAttachmentTypes,
} from '../controllers/filesController.js';
import { authenticate } from '../middleware/auth.js';
import { authenticateFlexible } from '../middleware/authFlexible.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

// Config for the frontend (no PII — public)
router.get('/attachment-types', getAttachmentTypes);

// File storage
router.post('/upload', authenticate, requirePermission('cutting_attachments', 'upload'), upload.single('file'), uploadFile);
// §14.5 — download requires auth; accepts Bearer header OR ?token= query param for browser links
router.get('/:id', authenticateFlexible, downloadFile);

// Cutting plan attachments
router.post('/cutting-plan/:id/attachments',         authenticate, requirePermission('cutting_attachments', 'upload'),   attachFile);
router.delete('/cutting-plan/:id/attachments/:type', authenticate, requirePermission('cutting_attachments', 'remove'),   removeAttachment);

export default router;
