import express from 'express';
import {
  gerarRomaneioCorte,
  listarRomaneiosImpressos,
} from '../controllers/cuttingRomaneioController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/printed', authenticate, requirePermission('cutting_projects', 'read'), listarRomaneiosImpressos);
router.post('/', authenticate, requirePermission('cutting_projects', 'export'), gerarRomaneioCorte);

export default router;
