import express from 'express';
import {
  listarMateriais,
  criarMaterial,
  atualizarMaterial,
  excluirMaterial,
} from '../controllers/materialsController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/',       authenticate, requirePermission('materials', 'read'),   listarMateriais);
router.post('/',      authenticate, requirePermission('materials', 'create'), criarMaterial);
router.patch('/:id',  authenticate, requirePermission('materials', 'update'), atualizarMaterial);
router.delete('/:id', authenticate, requirePermission('materials', 'delete'), excluirMaterial);

export default router;
