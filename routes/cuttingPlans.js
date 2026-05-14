import express from 'express';
import {
  criarProjectComPlanos,
  listarProjectsComPlanos,
  obterProjectComPlanos,
  atualizarProjectFixo,
  clonarProjectComPlanos,
  atualizarPlanoDeCorte,
  adicionarPlanoDeCorte,
  excluirPlanoDeCorte,
  excluirProjectComPlanos,
} from '../controllers/cuttingPlansController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/',                            authenticate, requirePermission('cutting_projects', 'read'),   listarProjectsComPlanos);
router.post('/',                           authenticate, requirePermission('cutting_projects', 'create'), criarProjectComPlanos);
router.get('/:id',                         authenticate, requirePermission('cutting_projects', 'read'),   obterProjectComPlanos);
router.put('/:id',                         authenticate, requirePermission('cutting_projects', 'update'), atualizarProjectFixo);
router.post('/:id/clone',                  authenticate, requirePermission('cutting_projects', 'clone'),  clonarProjectComPlanos);
router.post('/:id/plans',                  authenticate, requirePermission('cutting_plans', 'create'),    adicionarPlanoDeCorte);
router.put('/:projectId/plans/:planId',    authenticate, requirePermission('cutting_plans', 'update'),    atualizarPlanoDeCorte);
router.delete('/:projectId/plans/:planId', authenticate, requirePermission('cutting_plans', 'delete'),    excluirPlanoDeCorte);
router.delete('/:id',                      authenticate, requirePermission('cutting_projects', 'delete'), excluirProjectComPlanos);

export default router;
