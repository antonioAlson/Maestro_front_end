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

const router = express.Router();

// Fornecedores
router.get('/',       authenticate, listarFornecedores);
router.post('/',      authenticate, criarFornecedor);
router.patch('/:id',  authenticate, atualizarFornecedor);
router.delete('/:id', authenticate, excluirFornecedor);

// Tipos de placa aninhados ao fornecedor
router.post('/:supplierId/sizes',                authenticate, criarTipo);
router.patch('/:supplierId/sizes/:sizeId',       authenticate, atualizarTipo);
router.delete('/:supplierId/sizes/:sizeId',      authenticate, excluirTipo);

export default router;
