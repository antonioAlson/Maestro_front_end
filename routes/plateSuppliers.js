import express from 'express';
import {
  listarFornecedores,
  criarFornecedor,
  atualizarFornecedor,
  excluirFornecedor,
  criarTipo,
  atualizarTipo,
  excluirTipo,
} from '../controllers/plateSuppliersController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

// Fornecedores
router.get('/',       authenticate, requirePermission('plate_suppliers', 'read'),   listarFornecedores);
router.post('/',      authenticate, requirePermission('plate_suppliers', 'create'), criarFornecedor);
router.patch('/:id',  authenticate, requirePermission('plate_suppliers', 'update'), atualizarFornecedor);
router.delete('/:id', authenticate, requirePermission('plate_suppliers', 'delete'), excluirFornecedor);

// Tipos de placa aninhados ao fornecedor
router.post('/:supplierId/sizes',             authenticate, requirePermission('plate_suppliers', 'update'), criarTipo);
router.patch('/:supplierId/sizes/:sizeId',    authenticate, requirePermission('plate_suppliers', 'update'), atualizarTipo);
router.delete('/:supplierId/sizes/:sizeId',   authenticate, requirePermission('plate_suppliers', 'update'), excluirTipo);

export default router;
