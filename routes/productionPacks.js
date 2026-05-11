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

const router = express.Router();

router.get('/',                    authenticate, listarPacks);
router.post('/',                   authenticate, criarPack);
router.patch('/reorder',           authenticate, reordenarPacks);
router.patch('/:id',               authenticate, atualizarPack);
router.delete('/:id',              authenticate, excluirPack);
router.patch('/:id/items/reorder', authenticate, reordenarItens);

export default router;
