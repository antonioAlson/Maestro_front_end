import express from 'express';
import {
  listarMateriais,
  criarMaterial,
  atualizarMaterial,
  excluirMaterial,
  criarVariacaoMaterial,
  atualizarVariacaoMaterial,
  excluirVariacaoMaterial,
  listarTiposMedida,
  criarTipoMedida,
} from '../controllers/materialsController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/',       authenticate, requirePermission('materials', 'read'),   listarMateriais);
router.get('/measure-types',  authenticate, requirePermission('materials', 'read'),   listarTiposMedida);
router.post('/measure-types', authenticate, requirePermission('materials', 'create'), criarTipoMedida);
router.post('/:materialId/variants', authenticate, requirePermission('materials', 'update'), criarVariacaoMaterial);
router.patch('/:materialId/variants/:variantId', authenticate, requirePermission('materials', 'update'), atualizarVariacaoMaterial);
router.delete('/:materialId/variants/:variantId', authenticate, requirePermission('materials', 'update'), excluirVariacaoMaterial);
router.post('/',      authenticate, requirePermission('materials', 'create'), criarMaterial);
router.patch('/:id',  authenticate, requirePermission('materials', 'update'), atualizarMaterial);
router.delete('/:id', authenticate, requirePermission('materials', 'delete'), excluirMaterial);

export default router;
