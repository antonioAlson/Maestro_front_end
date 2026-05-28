import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  listReceipts,
  createReceipt,
  updateReceipt,
  deleteReceipt,
} from '../controllers/receiptController.js';

const router = express.Router();

router.get('/', authenticate, requirePermission('receipts', 'read'), listReceipts);
router.post('/', authenticate, requirePermission('receipts', 'create'), createReceipt);
router.put('/:id', authenticate, requirePermission('receipts', 'update'), updateReceipt);
router.delete('/', authenticate, requirePermission('receipts', 'delete'), deleteReceipt);
router.delete('/:id', authenticate, requirePermission('receipts', 'delete'), deleteReceipt);

export default router;
