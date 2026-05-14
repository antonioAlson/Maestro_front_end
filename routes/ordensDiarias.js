import express from 'express';
import {
  getOrdensDiarias,
  createOrdemDiaria,
  updateOrdemDiaria,
  deleteOrdemDiaria
} from '../controllers/ordensDiariasController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/',    authenticate, requirePermission('pcp_orders', 'read'),   getOrdensDiarias);
router.post('/',   authenticate, requirePermission('pcp_orders', 'create'), createOrdemDiaria);
router.put('/:id', authenticate, requirePermission('pcp_orders', 'update'), updateOrdemDiaria);
router.delete('/:id', authenticate, requirePermission('pcp_orders', 'delete'), deleteOrdemDiaria);

export default router;
