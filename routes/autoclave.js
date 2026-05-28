import express from 'express';
import {
  createCycle,
  getAll,
  listDetailedCycles,
  findIncompleteCycles,
  findByDateRange,
  duplicateCycle,
  updateStatus,
  uploadReport,
  completeCycleWithImage,
  getReport,
} from '../controllers/autoclaveCycleController.js';
import {
  createPackage,
  addPlatesToPackage,
  removePlateFromPackage,
  updatePackageStatus,
} from '../controllers/autoclavePackageController.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';
import { upload } from '../middleware/upload.js';

const router = express.Router();

// ── /cycle  ──────────────────────────────────────────────────────────────────
// Rotas estáticas antes de "/:id/*" para evitar colisão com :id
router.get('/cycle/summary',    authenticate, requirePermission('autoclave', 'read'), listDetailedCycles);
router.get('/cycle/incomplete', authenticate, requirePermission('autoclave', 'read'), findIncompleteCycles);
router.get('/cycle/by-cycle',   authenticate, requirePermission('autoclave', 'read'), findByDateRange);
router.get('/cycle',            authenticate, requirePermission('autoclave', 'read'), getAll);

router.post('/cycle',                       authenticate, requirePermission('autoclave', 'create'), createCycle);
router.post('/cycle/:id/duplicate',         authenticate, requirePermission('autoclave', 'create'), duplicateCycle);
router.patch('/cycle/:id/status',           authenticate, requirePermission('autoclave', 'update'), updateStatus);
router.post('/cycle/:id/upload',            authenticate, requirePermission('autoclave', 'upload'), upload.single('file'), uploadReport);
router.post('/cycle/complete/:id/upload',   authenticate, requirePermission('autoclave', 'upload'), upload.single('file'), completeCycleWithImage);
router.get('/cycle/:id/report',             authenticate, requirePermission('autoclave', 'download'), getReport);

// ── /package ─────────────────────────────────────────────────────────────────
router.post('/package/cycle',                authenticate, requirePermission('autoclave', 'create'), createPackage);
router.post('/package/:packid/addPlates',    authenticate, requirePermission('autoclave', 'update'), addPlatesToPackage);
router.post('/package/removePlate',          authenticate, requirePermission('autoclave', 'update'), removePlateFromPackage);
router.post('/package/:packid/updateStatus', authenticate, requirePermission('autoclave', 'approve'), updatePackageStatus);

export default router;
