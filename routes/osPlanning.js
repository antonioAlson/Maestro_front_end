import express from 'express';
import {
  listarPlanejamento,
  atribuirMaterial,
  desvincularMaterial,
  moverParaPack,
  registrarImpressao,
} from '../controllers/osPlanningController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/',                    authenticate, requirePermission('pcp_orders', 'read'),   listarPlanejamento);
router.patch('/:cardKey/material', authenticate, requirePermission('pcp_orders', 'update'), atribuirMaterial);
router.delete('/:cardKey/material', authenticate, requirePermission('pcp_orders', 'update'), desvincularMaterial);
router.patch('/:cardKey/pack',     authenticate, requirePermission('pcp_orders', 'update'), moverParaPack);
router.post('/print',              authenticate, requirePermission('pcp_orders', 'read'),   registrarImpressao);

export default router;
