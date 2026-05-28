import express from 'express';
import {
  findAllById,
  findByInStock,
  findAvailable,
  findById,
  updateStatus,
} from '../controllers/plateController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

// Rotas específicas antes do `:id` para evitar colisão com Express
router.get('/getEstoque', authenticate, requirePermission('plates', 'read'), findByInStock);
router.get('/available',  authenticate, requirePermission('plates', 'read'), findAvailable);
router.post('/update-status', authenticate, requirePermission('plates', 'update'), updateStatus);
router.post('/', authenticate, requirePermission('plates', 'read'), findAllById);
router.get('/:id', authenticate, requirePermission('plates', 'read'), findById);

export default router;
