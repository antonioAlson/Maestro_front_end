import express from 'express';
import {
  listWorkorders,
  platesByEnfesto,
  listGrouped,
  createWorkorder,
  updateWorkorder,
  deleteWorkorder,
  exportWorkordersExcel,
} from '../controllers/workorderController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/', authenticate, requirePermission('workorders', 'read'), listWorkorders);
router.get('/plates-by-enfesto', authenticate, requirePermission('workorders', 'read'), platesByEnfesto);
router.get('/enfesto/list', authenticate, requirePermission('workorders', 'read'), listGrouped);
router.get('/export/excel', authenticate, requirePermission('workorders', 'read'), exportWorkordersExcel);
router.post('/', authenticate, requirePermission('workorders', 'create'), createWorkorder);
router.put('/:id', authenticate, requirePermission('workorders', 'update'), updateWorkorder);
router.delete('/', authenticate, requirePermission('workorders', 'delete'), deleteWorkorder);

export default router;
