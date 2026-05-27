import express from 'express';
import {
  listarFornecedores,
  criarFornecedor,
  atualizarFornecedor,
  excluirFornecedor,
} from '../controllers/fabricSuppliersController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/',       authenticate, requirePermission('fabric_suppliers', 'read'),   listarFornecedores);
router.post('/',      authenticate, requirePermission('fabric_suppliers', 'create'), criarFornecedor);
router.patch('/:id',  authenticate, requirePermission('fabric_suppliers', 'update'), atualizarFornecedor);
router.delete('/:id', authenticate, requirePermission('fabric_suppliers', 'delete'), excluirFornecedor);

export default router;
