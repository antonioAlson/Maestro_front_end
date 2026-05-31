import express from 'express';
import multer from 'multer';
import {
  listTemplates, getTemplate, getVersionJrxml,
  createTemplate, deleteTemplate,
  createVersion, updateVersion, deleteVersion,
  renderByKey, renderVersion,
} from '../controllers/reportTemplatesController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

// .jrxml é XML pequeno → guardamos em memória para parsear/armazenar o conteúdo.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// Render do uso (versão OPE). Mantido antes do '/:id' para não colidir com a rota param.
router.post('/render/:key', authenticate, requirePermission('report_templates', 'execute'), renderByKey);

router.get('/',    authenticate, requirePermission('report_templates', 'read'),   listTemplates);
router.get('/:id', authenticate, requirePermission('report_templates', 'read'),   getTemplate);
router.post('/',   authenticate, requirePermission('report_templates', 'create'), upload.single('jrxml'), createTemplate);
router.delete('/:id', authenticate, requirePermission('report_templates', 'delete'), deleteTemplate);

router.get('/:id/versions/:vid/jrxml',   authenticate, requirePermission('report_templates', 'read'),    getVersionJrxml);
router.post('/:id/versions',             authenticate, requirePermission('report_templates', 'create'),  upload.single('jrxml'), createVersion);
router.patch('/:id/versions/:vid',       authenticate, requirePermission('report_templates', 'update'),  upload.single('jrxml'), updateVersion);
router.delete('/:id/versions/:vid',      authenticate, requirePermission('report_templates', 'delete'),  deleteVersion);
router.post('/:id/versions/:vid/render', authenticate, requirePermission('report_templates', 'execute'), renderVersion);

export default router;
