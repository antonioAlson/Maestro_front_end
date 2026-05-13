import express from 'express';
import {
  listJobs, getJob, createJob, deleteJob,
  createVersion, updateVersion, deleteVersion, runVersion,
} from '../controllers/cronJobsController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

router.get('/',                                authenticate, listJobs);
router.get('/:id',                             authenticate, getJob);
router.post('/',                               authenticate, createJob);
router.delete('/:id',                          authenticate, deleteJob);

router.post('/:id/versions',                   authenticate, createVersion);
router.patch('/:id/versions/:vid',             authenticate, updateVersion);
router.delete('/:id/versions/:vid',            authenticate, deleteVersion);
router.post('/:id/versions/:vid/run',          authenticate, runVersion);

export default router;
