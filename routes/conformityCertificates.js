import express from 'express';
import {
  listarCertificados,
  obterCertificado,
  criarCertificado,
  atualizarCertificado,
  excluirCertificado,
} from '../controllers/conformityCertificatesController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/',       authenticate, requirePermission('conformity_certificates', 'read'),   listarCertificados);
router.get('/:id',    authenticate, requirePermission('conformity_certificates', 'read'),   obterCertificado);
router.post('/',      authenticate, requirePermission('conformity_certificates', 'create'), criarCertificado);
router.patch('/:id',  authenticate, requirePermission('conformity_certificates', 'update'), atualizarCertificado);
router.delete('/:id', authenticate, requirePermission('conformity_certificates', 'delete'), excluirCertificado);

export default router;
