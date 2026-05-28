import express from 'express';
import { findByPlate, metadata } from '../controllers/plateEventController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/metadata', authenticate, requirePermission('plates', 'read'), metadata);
router.get('/plate/:plateId', authenticate, requirePermission('plates', 'read'), findByPlate);

export default router;
