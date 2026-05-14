import express from 'express';
import {
  listarPacks,
  criarPack,
  atualizarPack,
  excluirPack,
  reordenarPacks,
  reordenarItens,
} from '../controllers/productionPackController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/',                    authenticate, requirePermission('pcp_acompanhamento', 'read'), listarPacks);
router.post('/',                   authenticate, requirePermission('pcp_orders', 'update'),       criarPack);
router.patch('/reorder',           authenticate, requirePermission('pcp_orders', 'update'),       reordenarPacks);
router.patch('/:id',               authenticate, requirePermission('pcp_orders', 'update'),       atualizarPack);
router.delete('/:id',              authenticate, requirePermission('pcp_orders', 'update'),       excluirPack);
router.patch('/:id/items/reorder', authenticate, requirePermission('pcp_orders', 'update'),       reordenarItens);

export default router;
