import express from 'express';
import { authenticate } from '../middleware/auth.js';
import { authenticateFlexible } from '../middleware/authFlexible.js';
import { requirePermission } from '../middleware/rbac.js';
import {
  updateCuttingRecordInvoices,
  getAging,
  getComplianceChecklist,
  uploadInvoiceDocumentMiddleware,
  uploadInvoiceDocument,
  listInvoiceDocuments,
  listInvoiceDocumentHistory,
  downloadInvoiceDocument,
  runIntegrity,
  listIntegrityFailures,
  listDocumentIntegrityHistory,
} from '../controllers/invoiceController.js';

const router = express.Router();

router.put(
  '/cutting-records/invoices',
  authenticate,
  requirePermission('invoices', 'update'),
  updateCuttingRecordInvoices,
);
router.get(
  '/cutting-records/invoices/aging',
  authenticate,
  requirePermission('invoices', 'read'),
  getAging,
);
router.get(
  '/cutting-records/:id/compliance-checklist',
  authenticate,
  requirePermission('invoices', 'read'),
  getComplianceChecklist,
);

router.post(
  '/invoices/:invoiceNumber/documents',
  authenticate,
  requirePermission('invoices', 'upload'),
  uploadInvoiceDocumentMiddleware,
  uploadInvoiceDocument,
);
router.get(
  '/invoices/:invoiceNumber/documents',
  authenticate,
  requirePermission('invoices', 'read'),
  listInvoiceDocuments,
);
router.get(
  '/invoices/:invoiceNumber/documents/history',
  authenticate,
  requirePermission('invoices', 'read'),
  listInvoiceDocumentHistory,
);
router.get(
  '/invoices/:invoiceNumber/documents/:documentId/download',
  authenticateFlexible,
  requirePermission('invoices', 'download'),
  downloadInvoiceDocument,
);

router.post(
  '/invoices/integrity/run',
  authenticate,
  requirePermission('invoices', 'approve'),
  runIntegrity,
);
router.get(
  '/invoices/integrity/failures',
  authenticate,
  requirePermission('invoices', 'read'),
  listIntegrityFailures,
);
router.get(
  '/invoices/integrity/document/:documentId',
  authenticate,
  requirePermission('invoices', 'read'),
  listDocumentIntegrityHistory,
);

export default router;
