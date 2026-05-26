import express from 'express';
import {
  listarRastreabilidades,
  proximoSequencial,
  criarRastreabilidade,
  obterRastreabilidade,
  excluirRastreabilidade,
} from '../controllers/rastreabilidadesController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/',                authenticate, requirePermission('rastreabilidades', 'read'),   listarRastreabilidades);
router.get('/next-sequencial', authenticate, requirePermission('rastreabilidades', 'read'),   proximoSequencial);
router.post('/',               authenticate, requirePermission('rastreabilidades', 'create'), criarRastreabilidade);
router.get('/:id',             authenticate, requirePermission('rastreabilidades', 'read'),   obterRastreabilidade);
router.delete('/:id',          authenticate, requirePermission('rastreabilidades', 'delete'), excluirRastreabilidade);

export default router;
