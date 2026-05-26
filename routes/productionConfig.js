import express from 'express';
import {
  obterConfig,
  atualizarConfig,
} from '../controllers/productionConfigController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/',   authenticate, requirePermission('production_config', 'read'),   obterConfig);
router.patch('/', authenticate, requirePermission('production_config', 'update'), atualizarConfig);

export default router;
