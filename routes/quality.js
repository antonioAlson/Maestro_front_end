import express from 'express';
import {
  listCertificates,
  getCertificate,
  createCertificate,
  updateCertificate,
  deleteCertificate,
  generateCertificatePdf,
  fromInvoice,
  gerarCertificadosCorte,
  listarCertsPorCorte,
} from '../controllers/qualityController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/',           authenticate, requirePermission('certificates', 'read'),   listCertificates);
router.get('/by-cutting', authenticate, requirePermission('certificates', 'read'),   listarCertsPorCorte);
router.get('/:id/pdf',    authenticate, requirePermission('certificates', 'read'),   generateCertificatePdf);
router.get('/:id',        authenticate, requirePermission('certificates', 'read'),   getCertificate);
router.post('/from-invoice', authenticate, requirePermission('certificates', 'create'), fromInvoice);
router.post('/from-cutting', authenticate, requirePermission('certificates', 'create'), gerarCertificadosCorte);
router.post('/',          authenticate, requirePermission('certificates', 'create'), createCertificate);
router.put('/:id',        authenticate, requirePermission('certificates', 'update'), updateCertificate);
router.delete('/:id',     authenticate, requirePermission('certificates', 'delete'), deleteCertificate);

export default router;
