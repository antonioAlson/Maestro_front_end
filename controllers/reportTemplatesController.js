import axios from 'axios';
import pool from '../config/database.js';
import { parseJrxml } from '../services/jrxmlParser.js';
import { runReportCode } from '../services/reportJsRunner.js';

const VALID_STATUS = new Set(['DVP', 'SAT', 'REL', 'OPE']);
const PRINT_SERVICE_URL = (process.env.PRINT_SERVICE_URL || 'http://localhost:8080').replace(/\/+$/, '');

// ---------- helpers ----------

// O .jrxml chega por upload (multer single 'jrxml') ou como texto cru em body.jrxml.
function readJrxml(req) {
  if (req.file?.buffer) return req.file.buffer.toString('utf8');
  if (typeof req.body?.jrxml === 'string' && req.body.jrxml.trim()) return req.body.jrxml;
  return null;
}

async function nextVersionNumber(templateId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(version_number), 0)::numeric AS max
       FROM maestro.report_template_versions WHERE template_id = $1`,
    [templateId]
  );
  const max = Number(rows[0]?.max || 0);
  return Number((max + 0.01).toFixed(2));
}

// ---------- templates ----------

// GET /api/report-templates
export const listTemplates = async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        t.id, t.key, t.name, t.description, t.created_at, t.updated_at,
        u.name AS created_by_name,
        ope.id             AS ope_version_id,
        ope.version_number AS ope_version_number,
        (SELECT MAX(v.created_at) FROM maestro.report_template_versions v WHERE v.template_id = t.id) AS last_change_at,
        (SELECT COUNT(*) FROM maestro.report_template_versions v WHERE v.template_id = t.id)::int     AS version_count
      FROM maestro.report_templates t
      LEFT JOIN maestro.users u ON u.id = t.created_by
      LEFT JOIN maestro.report_template_versions ope
             ON ope.template_id = t.id AND ope.status = 'OPE'
      ORDER BY t.name
    `);
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[ReportTemplates] list error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/report-templates/:id  → template + versões (sem o jrxml cru pra aliviar payload)
export const getTemplate = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'id inválido' });

    const tplRes = await pool.query(
      `SELECT t.*, u.name AS created_by_name
         FROM maestro.report_templates t
         LEFT JOIN maestro.users u ON u.id = t.created_by
        WHERE t.id = $1`,
      [id]
    );
    if (tplRes.rowCount === 0) return res.status(404).json({ success: false, message: 'Relatório não encontrado' });

    const versionsRes = await pool.query(
      `SELECT v.id, v.template_id, v.version_number, v.status, v.variables, v.code, v.notes,
              v.created_at, v.status_changed_at,
              octet_length(v.jrxml) AS jrxml_bytes,
              cb.name AS created_by_name,
              sb.name AS status_changed_by_name
         FROM maestro.report_template_versions v
         LEFT JOIN maestro.users cb ON cb.id = v.created_by
         LEFT JOIN maestro.users sb ON sb.id = v.status_changed_by
        WHERE v.template_id = $1
        ORDER BY v.version_number DESC`,
      [id]
    );

    return res.json({ success: true, data: { ...tplRes.rows[0], versions: versionsRes.rows } });
  } catch (error) {
    console.error('[ReportTemplates] get error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/report-templates/:id/versions/:vid/jrxml  → conteúdo cru do .jrxml
export const getVersionJrxml = async (req, res) => {
  try {
    const vid = Number(req.params.vid);
    if (!Number.isFinite(vid)) return res.status(400).json({ success: false, message: 'vid inválido' });
    const { rows } = await pool.query(
      `SELECT jrxml FROM maestro.report_template_versions WHERE id = $1 AND template_id = $2`,
      [vid, Number(req.params.id)]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Versão não encontrada' });
    return res.json({ success: true, data: { jrxml: rows[0].jrxml } });
  } catch (error) {
    console.error('[ReportTemplates] getVersionJrxml error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/report-templates  (multipart: campos + arquivo 'jrxml')
// Cria template + primeira versão (DVP, 1.00).
export const createTemplate = async (req, res) => {
  const client = await pool.connect();
  try {
    const { key, name, description, code, notes } = req.body || {};
    const userId = req.user?.id || null;

    if (!key?.trim())  return res.status(400).json({ success: false, message: 'key é obrigatório' });
    if (!name?.trim()) return res.status(400).json({ success: false, message: 'name é obrigatório' });

    const jrxml = readJrxml(req);
    if (!jrxml) return res.status(400).json({ success: false, message: 'Arquivo .jrxml é obrigatório' });

    let variables;
    try {
      variables = parseJrxml(jrxml);
    } catch (e) {
      return res.status(400).json({ success: false, message: `Falha ao ler .jrxml: ${e.message}` });
    }

    await client.query('BEGIN');

    const tplRes = await client.query(
      `INSERT INTO maestro.report_templates (key, name, description, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [key.trim(), name.trim(), description ?? null, userId]
    );
    const tpl = tplRes.rows[0];

    const verRes = await client.query(
      `INSERT INTO maestro.report_template_versions
         (template_id, version_number, status, jrxml, variables, code, notes, created_by, status_changed_by)
       VALUES ($1, 1.00, 'DVP', $2, $3, $4, $5, $6, $6)
       RETURNING id, version_number, status, variables, code, notes, created_at`,
      [tpl.id, jrxml, variables, code ?? null, notes ?? null, userId]
    );

    await client.query('COMMIT');
    return res.status(201).json({ success: true, data: { ...tpl, versions: [verRes.rows[0]] } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ReportTemplates] create error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Já existe um relatório com essa key' });
    }
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// DELETE /api/report-templates/:id
export const deleteTemplate = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'id inválido' });

    const { rowCount } = await pool.query('DELETE FROM maestro.report_templates WHERE id = $1', [id]);
    if (rowCount === 0) return res.status(404).json({ success: false, message: 'Relatório não encontrado' });
    return res.json({ success: true });
  } catch (error) {
    console.error('[ReportTemplates] delete error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ---------- versions ----------

// POST /api/report-templates/:id/versions  (multipart: arquivo 'jrxml' + code/notes)
// Nova versão sempre nasce em DVP.
export const createVersion = async (req, res) => {
  try {
    const templateId = Number(req.params.id);
    if (!Number.isFinite(templateId)) return res.status(400).json({ success: false, message: 'id inválido' });

    const { code, notes, version_number } = req.body || {};
    const userId = req.user?.id || null;

    const jrxml = readJrxml(req);
    if (!jrxml) return res.status(400).json({ success: false, message: 'Arquivo .jrxml é obrigatório' });

    let variables;
    try {
      variables = parseJrxml(jrxml);
    } catch (e) {
      return res.status(400).json({ success: false, message: `Falha ao ler .jrxml: ${e.message}` });
    }

    const ver = Number.isFinite(Number(version_number))
      ? Number(version_number)
      : await nextVersionNumber(templateId);

    const { rows } = await pool.query(
      `INSERT INTO maestro.report_template_versions
         (template_id, version_number, status, jrxml, variables, code, notes, created_by, status_changed_by)
       VALUES ($1, $2, 'DVP', $3, $4, $5, $6, $7, $7)
       RETURNING id, version_number, status, variables, code, notes, created_at`,
      [templateId, ver, jrxml, variables, code ?? null, notes ?? null, userId]
    );

    await pool.query('UPDATE maestro.report_templates SET updated_at = now() WHERE id = $1', [templateId]);
    return res.status(201).json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('[ReportTemplates] createVersion error:', error);
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'version_number já existe' });
    if (error.code === '23503') return res.status(404).json({ success: false, message: 'Relatório não encontrado' });
    return res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/report-templates/:id/versions/:vid
// Atualiza code/notes/status e, opcionalmente, troca o .jrxml (re-parseia).
// Promover para OPE rebaixa a OPE atual para REL.
export const updateVersion = async (req, res) => {
  const client = await pool.connect();
  try {
    const templateId = Number(req.params.id);
    const vid        = Number(req.params.vid);
    if (!Number.isFinite(templateId) || !Number.isFinite(vid)) {
      return res.status(400).json({ success: false, message: 'id/vid inválido' });
    }

    const { code, notes, status } = req.body || {};
    const userId = req.user?.id || null;
    const newJrxml = readJrxml(req); // null se não veio arquivo novo

    if (status != null && !VALID_STATUS.has(status)) {
      return res.status(400).json({ success: false, message: 'status inválido (DVP, SAT, REL, OPE)' });
    }

    let variables = null;
    if (newJrxml) {
      try { variables = parseJrxml(newJrxml); }
      catch (e) { return res.status(400).json({ success: false, message: `Falha ao ler .jrxml: ${e.message}` }); }
    }

    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT status FROM maestro.report_template_versions WHERE id = $1 AND template_id = $2`,
      [vid, templateId]
    );
    if (cur.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Versão não encontrada' });
    }

    if (status === 'OPE' && cur.rows[0].status !== 'OPE') {
      await client.query(
        `UPDATE maestro.report_template_versions
            SET status = 'REL', status_changed_at = now(), status_changed_by = $2
          WHERE template_id = $1 AND status = 'OPE' AND id <> $3`,
        [templateId, userId, vid]
      );
    }

    const sets = [];
    const params = [];
    const push = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if (code !== undefined)  push('code', code);
    if (notes !== undefined) push('notes', notes);
    if (newJrxml) { push('jrxml', newJrxml); push('variables', variables); }
    if (status != null && status !== cur.rows[0].status) {
      push('status', status);
      sets.push('status_changed_at = now()');
      params.push(userId);
      sets.push(`status_changed_by = $${params.length}`);
    }

    if (sets.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ success: true, data: { id: vid } });
    }

    params.push(vid);
    const upd = await client.query(
      `UPDATE maestro.report_template_versions SET ${sets.join(', ')}
        WHERE id = $${params.length}
        RETURNING id, version_number, status, variables, code, notes, created_at, status_changed_at`,
      params
    );

    await client.query('UPDATE maestro.report_templates SET updated_at = now() WHERE id = $1', [templateId]);
    await client.query('COMMIT');
    return res.json({ success: true, data: upd.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[ReportTemplates] updateVersion error:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// DELETE /api/report-templates/:id/versions/:vid
export const deleteVersion = async (req, res) => {
  try {
    const templateId = Number(req.params.id);
    const vid        = Number(req.params.vid);
    if (!Number.isFinite(templateId) || !Number.isFinite(vid)) {
      return res.status(400).json({ success: false, message: 'id/vid inválido' });
    }

    const { rows } = await pool.query(
      `SELECT status FROM maestro.report_template_versions WHERE id = $1 AND template_id = $2`,
      [vid, templateId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Versão não encontrada' });
    if (rows[0].status === 'OPE') {
      return res.status(409).json({ success: false, message: 'Não é possível excluir a versão em OPE. Promova outra antes.' });
    }

    await pool.query('DELETE FROM maestro.report_template_versions WHERE id = $1', [vid]);
    return res.json({ success: true });
  } catch (error) {
    console.error('[ReportTemplates] deleteVersion error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ---------- render ----------

// Núcleo: roda o JS da versão → monta { params, data } → POST Spring /render → PDF.
async function renderVersionRow(version, input, res) {
  const { params, data } = await runReportCode(version.code, input);

  let springRes;
  try {
    springRes = await axios.post(
      `${PRINT_SERVICE_URL}/render`,
      { jrxml: version.jrxml, params, data },
      { responseType: 'arraybuffer', timeout: 30_000, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const detail = err.response?.data
      ? Buffer.from(err.response.data).toString('utf8').slice(0, 500)
      : err.message;
    return res.status(502).json({ success: false, message: `Falha no render (Spring): ${detail}` });
  }

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename=report.pdf');
  return res.send(Buffer.from(springRes.data));
}

// POST /api/report-templates/render/:key   (input no body) → PDF da versão OPE
export const renderByKey = async (req, res) => {
  try {
    const key = req.params.key;
    const { rows } = await pool.query(
      `SELECT v.code, v.jrxml
         FROM maestro.report_template_versions v
         JOIN maestro.report_templates t ON t.id = v.template_id
        WHERE t.key = $1 AND v.status = 'OPE'`,
      [key]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: `Sem versão OPE para o relatório "${key}"` });
    }
    return await renderVersionRow(rows[0], req.body || {}, res);
  } catch (error) {
    console.error('[ReportTemplates] renderByKey error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/report-templates/:id/versions/:vid/render  → PDF de uma versão específica (teste)
export const renderVersion = async (req, res) => {
  try {
    const vid = Number(req.params.vid);
    if (!Number.isFinite(vid)) return res.status(400).json({ success: false, message: 'vid inválido' });

    const { rows } = await pool.query(
      `SELECT code, jrxml FROM maestro.report_template_versions WHERE id = $1 AND template_id = $2`,
      [vid, Number(req.params.id)]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Versão não encontrada' });
    return await renderVersionRow(rows[0], req.body || {}, res);
  } catch (error) {
    console.error('[ReportTemplates] renderVersion error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
