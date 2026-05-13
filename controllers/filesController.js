import pool from '../config/database.js';
import { UPLOAD_DIR } from '../middleware/upload.js';
import path from 'path';
import fs from 'fs';
import {
  ALLOWED_TYPES,
  MIME_BY_TYPE,
  PATTERN_VALIDATED,
  LABEL_CONTENT_REGEX,
  MATERIAL_ATTACHMENTS,
  isTypeAllowedForMaterial,
  buildPublicConfig,
} from '../shared/attachmentTypes.js';

// GET /api/files/attachment-types  (public — config only, no PII)
export const getAttachmentTypes = (_req, res) => {
  res.json({ success: true, data: buildPublicConfig() });
};

// POST /api/files/upload
export const uploadFile = async (req, res) => {
  try {
    const { type } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ success: false, message: 'Arquivo não enviado.' });
    }

    if (!type || !ALLOWED_TYPES.includes(type)) {
      fs.unlinkSync(file.path);
      return res.status(400).json({ success: false, message: `Tipo inválido: "${type}". Tipos permitidos: ${ALLOWED_TYPES.join(', ')}` });
    }

    const allowedMimes = MIME_BY_TYPE[type];
    if (!allowedMimes.includes(file.mimetype)) {
      fs.unlinkSync(file.path);
      return res.status(400).json({
        success: false,
        message: `Arquivo inválido para tipo "${type}". Esperado: ${allowedMimes.join(', ')}. Recebido: ${file.mimetype}`,
      });
    }

    if (PATTERN_VALIDATED.includes(type)) {
      const content = fs.readFileSync(file.path, 'utf8');
      if (!LABEL_CONTENT_REGEX.test(content)) {
        fs.unlinkSync(file.path);
        return res.status(400).json({
          success: false,
          message: 'Os padrão XXXXX não encontrada',
        });
      }
    }

    // filename already is "uuid.ext" from multer diskStorage
    const storedName = file.filename;
    const fileId     = path.basename(storedName, path.extname(storedName));

    await pool.query(
      `INSERT INTO maestro.file_storage (id, original_name, stored_name, path, mime_type, size)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [fileId, file.originalname, storedName, file.path, file.mimetype, file.size]
    );

    return res.status(201).json({ success: true, fileId });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    console.error('❌ uploadFile:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/files/:id  (no auth — UUID is already unguessable)
export const downloadFile = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM maestro.file_storage WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Arquivo não encontrado.' });
    }
    const f = result.rows[0];
    if (!fs.existsSync(f.path)) {
      return res.status(404).json({ success: false, message: 'Arquivo não encontrado no disco.' });
    }
    const disposition = req.query.dl === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(f.original_name)}"`);
    res.setHeader('Content-Type', f.mime_type);
    fs.createReadStream(f.path).pipe(res);
  } catch (error) {
    console.error('❌ downloadFile:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/cutting-plan/:id/attachments
export const attachFile = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id: planId } = req.params;
    const { type, fileId } = req.body;

    if (!type || !fileId) {
      return res.status(400).json({ success: false, message: '"type" e "fileId" são obrigatórios.' });
    }

    const planRow = await client.query(
      `SELECT cp.id, p.material_type
         FROM maestro.cutting_plan cp
         JOIN maestro.project p ON p.id = cp.project_id
        WHERE cp.id = $1`,
      [planId]
    );
    if (planRow.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Plano de corte não encontrado.' });
    }

    const mt = planRow.rows[0].material_type.toUpperCase();
    if (!isTypeAllowedForMaterial(mt, type)) {
      const allowed = MATERIAL_ATTACHMENTS[mt] || [];
      return res.status(400).json({
        success: false,
        message: `Tipo "${type}" não permitido para material ${mt}. Permitidos: ${allowed.join(', ')}`,
      });
    }

    const fileRow = await client.query('SELECT id FROM maestro.file_storage WHERE id = $1', [fileId]);
    if (fileRow.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Arquivo não encontrado.' });
    }

    await client.query('BEGIN');

    // replace existing attachment of same type
    const existing = await client.query(
      `SELECT file_id FROM maestro.cutting_plan_attachment
        WHERE cutting_plan_id = $1 AND type = $2`,
      [planId, type]
    );
    if (existing.rows.length > 0) {
      const oldFileId = existing.rows[0].file_id;
      await client.query(
        'DELETE FROM maestro.cutting_plan_attachment WHERE cutting_plan_id = $1 AND type = $2',
        [planId, type]
      );
      const oldFile = await client.query('SELECT path FROM maestro.file_storage WHERE id = $1', [oldFileId]);
      if (oldFile.rows.length > 0) {
        if (fs.existsSync(oldFile.rows[0].path)) fs.unlinkSync(oldFile.rows[0].path);
        await client.query('DELETE FROM maestro.file_storage WHERE id = $1', [oldFileId]);
      }
    }

    await client.query(
      `INSERT INTO maestro.cutting_plan_attachment (cutting_plan_id, file_id, type)
       VALUES ($1, $2, $3)`,
      [planId, fileId, type]
    );

    await client.query('COMMIT');
    return res.status(201).json({ success: true, message: 'Anexo vinculado.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ attachFile:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// DELETE /api/cutting-plan/:id/attachments/:type
export const removeAttachment = async (req, res) => {
  const client = await pool.connect();
  try {
    const { id: planId, type } = req.params;

    const existing = await client.query(
      `SELECT file_id FROM maestro.cutting_plan_attachment
        WHERE cutting_plan_id = $1 AND type = $2`,
      [planId, type]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Anexo não encontrado.' });
    }

    const fileId = existing.rows[0].file_id;
    await client.query('BEGIN');

    await client.query(
      'DELETE FROM maestro.cutting_plan_attachment WHERE cutting_plan_id = $1 AND type = $2',
      [planId, type]
    );

    const fileRow = await client.query('SELECT path FROM maestro.file_storage WHERE id = $1', [fileId]);
    if (fileRow.rows.length > 0) {
      if (fs.existsSync(fileRow.rows[0].path)) fs.unlinkSync(fileRow.rows[0].path);
      await client.query('DELETE FROM maestro.file_storage WHERE id = $1', [fileId]);
    }

    await client.query('COMMIT');
    return res.status(200).json({ success: true, message: 'Anexo removido.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ removeAttachment:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};
