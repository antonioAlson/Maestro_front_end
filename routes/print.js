import express from 'express';
import { printPDF, listPrinters } from '../utils/printer.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission } from '../middleware/rbac.js';

const router = express.Router();

router.get('/printers', authenticate, requirePermission('pcp_orders', 'read'), async (req, res) => {
  try {
    const printers = await listPrinters();
    res.json({ success: true, printers });
  } catch (error) {
    console.error('Erro ao listar impressoras:', error);
    res.status(500).json({ success: false, message: 'Erro ao listar impressoras', error: error.message });
  }
});

router.post('/print', authenticate, requirePermission('pcp_orders', 'read'), async (req, res) => {
  try {
    const { files, printer, options = {} } = req.body;

    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ success: false, message: 'Nenhum arquivo informado para impressão' });
    }

    const printOptions = {
      grayscale: options.grayscale !== false,
      duplex:    options.duplex !== false,
      copies:    options.copies || 1
    };

    const results = [];

    for (const file of files) {
      try {
        await printPDF({ url: file.url, name: file.name, printer, options: printOptions });
        results.push({ cardId: file.cardId, name: file.name, success: true, message: 'Enviado para impressão' });
      } catch (error) {
        console.error(`Erro ao imprimir ${file.name}:`, error);
        results.push({ cardId: file.cardId, name: file.name, success: false, message: error.message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount    = results.filter(r => !r.success).length;

    res.json({
      success: failCount === 0,
      message: `${successCount} arquivo(s) enviado(s) para impressão${failCount > 0 ? `, ${failCount} com erro` : ''}`,
      results,
      printOptions
    });
  } catch (error) {
    console.error('Erro ao processar impressão:', error);
    res.status(500).json({ success: false, message: 'Erro ao processar impressão', error: error.message });
  }
});

export default router;
