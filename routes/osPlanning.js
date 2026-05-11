import express from 'express';
import {
  listarPlanejamento,
  atribuirMaterial,
  desvincularMaterial,
  moverParaPack,
  registrarImpressao,
} from '../controllers/osPlanningController.js';
import { authenticate } from '../middleware/auth.js';

const router = express.Router();

router.get('/',                          authenticate, listarPlanejamento);
router.patch('/:cardKey/material',       authenticate, atribuirMaterial);
router.delete('/:cardKey/material',      authenticate, desvincularMaterial);
router.patch('/:cardKey/pack',           authenticate, moverParaPack);
router.post('/print',                    authenticate, registrarImpressao);

export default router;
