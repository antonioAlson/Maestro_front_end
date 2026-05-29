import express from 'express';
import {
  getAllCuttingRecords,
  getCuttingRecordById,
  createCuttingRecord,
  updateCuttingRecord,
  deleteCuttingRecord,
  getMetadata,
  backfillJiraKeys,
} from '../controllers/cuttingController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

// Rotas estáticas antes de "/:id" para evitar colisão com :id
router.get('/metadata', authenticate, requirePermission('cutting_records', 'read'), getMetadata);

router.post('/backfill-jira-keys', authenticate, requirePermission('cutting_records', 'update'), backfillJiraKeys);

router.get('/',        authenticate, requirePermission('cutting_records', 'read'),   getAllCuttingRecords);
router.get('/:id',     authenticate, requirePermission('cutting_records', 'read'),   getCuttingRecordById);
router.post('/',       authenticate, requirePermission('cutting_records', 'create'), createCuttingRecord);
router.put('/:id',     authenticate, requirePermission('cutting_records', 'update'), updateCuttingRecord);
router.delete('/:id',  authenticate, requirePermission('cutting_records', 'delete'), deleteCuttingRecord);

export default router;
