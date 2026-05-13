import cron from 'node-cron';
import pool from '../config/database.js';
import { rescheduleJob, runVersionById } from '../cron_jobs/scheduler.js';

const VALID_STATUS = new Set(['DVP', 'SAT', 'REL', 'OPE']);

// ---------- helpers ----------
function validateCronExpression(expr) {
  if (typeof expr !== 'string' || !expr.trim()) return 'cron_expression é obrigatório';
  if (!cron.validate(expr)) return `cron_expression inválida: "${expr}"`;
  return null;
}

async function nextVersionNumber(jobId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(version_number), 0)::numeric AS max FROM maestro.cron_job_versions WHERE job_id = $1`,
    [jobId]
  );
  const max = Number(rows[0]?.max || 0);
  return Number((max + 0.01).toFixed(2));
}

// ---------- jobs ----------

// GET /api/cron-jobs
// Lista todos os jobs com a versão OPE inline (versão atualmente agendada).
export const listJobs = async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        j.id, j.name, j.description, j.created_at, j.updated_at,
        u.name AS created_by_name,
        ope.id              AS ope_version_id,
        ope.version_number  AS ope_version_number,
        ope.cron_expression AS ope_cron_expression,
        ope.status_changed_at AS ope_promoted_at,
        (SELECT MAX(v.created_at) FROM maestro.cron_job_versions v WHERE v.job_id = j.id) AS last_change_at,
        (SELECT COUNT(*) FROM maestro.cron_job_versions v WHERE v.job_id = j.id)::int       AS version_count
      FROM maestro.cron_jobs j
      LEFT JOIN maestro.users u ON u.id = j.created_by
      LEFT JOIN maestro.cron_job_versions ope
             ON ope.job_id = j.id AND ope.status = 'OPE'
      ORDER BY j.name
    `);
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[CronJobs] list error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/cron-jobs/:id
// Job + todas as versões em ordem decrescente.
export const getJob = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'id inválido' });

    const jobRes = await pool.query(
      `SELECT j.*, u.name AS created_by_name
         FROM maestro.cron_jobs j
         LEFT JOIN maestro.users u ON u.id = j.created_by
        WHERE j.id = $1`,
      [id]
    );
    if (jobRes.rowCount === 0) return res.status(404).json({ success: false, message: 'Job não encontrado' });

    const versionsRes = await pool.query(
      `SELECT v.id, v.job_id, v.version_number, v.status, v.cron_expression, v.code, v.notes,
              v.created_at, v.status_changed_at,
              cb.name AS created_by_name,
              sb.name AS status_changed_by_name
         FROM maestro.cron_job_versions v
         LEFT JOIN maestro.users cb ON cb.id = v.created_by
         LEFT JOIN maestro.users sb ON sb.id = v.status_changed_by
        WHERE v.job_id = $1
        ORDER BY v.version_number DESC`,
      [id]
    );

    return res.json({
      success: true,
      data: { ...jobRes.rows[0], versions: versionsRes.rows },
    });
  } catch (error) {
    console.error('[CronJobs] get error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/cron-jobs
// Cria job + primeira versão (status DVP, version_number 1.00).
export const createJob = async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, description, cron_expression, code, notes } = req.body || {};
    const userId = req.user?.id || null;

    if (!name?.trim()) return res.status(400).json({ success: false, message: 'name é obrigatório' });
    if (typeof code !== 'string' || !code.trim()) return res.status(400).json({ success: false, message: 'code é obrigatório' });

    const cronErr = validateCronExpression(cron_expression);
    if (cronErr) return res.status(400).json({ success: false, message: cronErr });

    await client.query('BEGIN');

    const jobRes = await client.query(
      `INSERT INTO maestro.cron_jobs (name, description, created_by)
       VALUES ($1, $2, $3) RETURNING *`,
      [name.trim(), description ?? null, userId]
    );
    const job = jobRes.rows[0];

    const verRes = await client.query(
      `INSERT INTO maestro.cron_job_versions
         (job_id, version_number, status, cron_expression, code, notes, created_by, status_changed_by)
       VALUES ($1, 1.00, 'DVP', $2, $3, $4, $5, $5)
       RETURNING *`,
      [job.id, cron_expression, code, notes ?? null, userId]
    );

    await client.query('COMMIT');
    return res.status(201).json({ success: true, data: { ...job, versions: [verRes.rows[0]] } });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[CronJobs] create error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Já existe um job com esse nome' });
    }
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// DELETE /api/cron-jobs/:id
export const deleteJob = async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'id inválido' });

    const { rows } = await pool.query('SELECT name FROM maestro.cron_jobs WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Job não encontrado' });

    await pool.query('DELETE FROM maestro.cron_jobs WHERE id = $1', [id]);
    await rescheduleJob(id); // remove do scheduler caso houvesse OPE
    return res.json({ success: true });
  } catch (error) {
    console.error('[CronJobs] delete error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ---------- versions ----------

// POST /api/cron-jobs/:id/versions
// Nova versão sempre nasce em DVP. version_number auto = max + 0.01 (ou pelo body).
export const createVersion = async (req, res) => {
  try {
    const jobId = Number(req.params.id);
    if (!Number.isFinite(jobId)) return res.status(400).json({ success: false, message: 'id inválido' });

    const { cron_expression, code, notes, version_number } = req.body || {};
    const userId = req.user?.id || null;

    const cronErr = validateCronExpression(cron_expression);
    if (cronErr) return res.status(400).json({ success: false, message: cronErr });
    if (typeof code !== 'string' || !code.trim()) return res.status(400).json({ success: false, message: 'code é obrigatório' });

    const ver = Number.isFinite(Number(version_number))
      ? Number(version_number)
      : await nextVersionNumber(jobId);

    const { rows } = await pool.query(
      `INSERT INTO maestro.cron_job_versions
         (job_id, version_number, status, cron_expression, code, notes, created_by, status_changed_by)
       VALUES ($1, $2, 'DVP', $3, $4, $5, $6, $6)
       RETURNING *`,
      [jobId, ver, cron_expression, code, notes ?? null, userId]
    );

    await pool.query('UPDATE maestro.cron_jobs SET updated_at = now() WHERE id = $1', [jobId]);

    return res.status(201).json({ success: true, data: rows[0] });
  } catch (error) {
    console.error('[CronJobs] createVersion error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'version_number já existe para esse job' });
    }
    if (error.code === '23503') {
      return res.status(404).json({ success: false, message: 'Job não encontrado' });
    }
    return res.status(500).json({ success: false, message: error.message });
  }
};

// PATCH /api/cron-jobs/:id/versions/:vid
// Atualiza código/agendamento/status/notes da versão.
// Promover para OPE: rebaixa a OPE atual (se houver) para REL automaticamente.
export const updateVersion = async (req, res) => {
  const client = await pool.connect();
  try {
    const jobId = Number(req.params.id);
    const vid   = Number(req.params.vid);
    if (!Number.isFinite(jobId) || !Number.isFinite(vid)) {
      return res.status(400).json({ success: false, message: 'id/vid inválido' });
    }

    const { cron_expression, code, notes, status } = req.body || {};
    const userId = req.user?.id || null;

    if (status != null && !VALID_STATUS.has(status)) {
      return res.status(400).json({ success: false, message: 'status inválido (DVP, SAT, REL, OPE)' });
    }
    if (cron_expression != null) {
      const e = validateCronExpression(cron_expression);
      if (e) return res.status(400).json({ success: false, message: e });
    }
    if (code != null && (typeof code !== 'string' || !code.trim())) {
      return res.status(400).json({ success: false, message: 'code não pode ser vazio' });
    }

    await client.query('BEGIN');

    const cur = await client.query(
      `SELECT * FROM maestro.cron_job_versions WHERE id = $1 AND job_id = $2`,
      [vid, jobId]
    );
    if (cur.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Versão não encontrada' });
    }

    const promotingToOpe = status === 'OPE' && cur.rows[0].status !== 'OPE';
    if (promotingToOpe) {
      // Rebaixa a OPE atual para REL (mantém histórico do que estava rodando).
      await client.query(
        `UPDATE maestro.cron_job_versions
            SET status = 'REL', status_changed_at = now(), status_changed_by = $2
          WHERE job_id = $1 AND status = 'OPE' AND id <> $3`,
        [jobId, userId, vid]
      );
    }

    const sets = [];
    const params = [];
    function push(col, val) { params.push(val); sets.push(`${col} = $${params.length}`); }

    if (cron_expression != null) push('cron_expression', cron_expression);
    if (code != null)            push('code', code);
    if (notes !== undefined)     push('notes', notes);
    if (status != null && status !== cur.rows[0].status) {
      push('status', status);
      sets.push(`status_changed_at = now()`);
      params.push(userId);
      sets.push(`status_changed_by = $${params.length}`);
    }

    if (sets.length === 0) {
      await client.query('ROLLBACK');
      return res.json({ success: true, data: cur.rows[0] });
    }

    params.push(vid);
    const upd = await client.query(
      `UPDATE maestro.cron_job_versions SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );

    await client.query('UPDATE maestro.cron_jobs SET updated_at = now() WHERE id = $1', [jobId]);
    await client.query('COMMIT');

    // Reagenda se houve mudança que afeta a OPE atual.
    const wasOpe = cur.rows[0].status === 'OPE';
    const isOpe  = upd.rows[0].status === 'OPE';
    if (wasOpe || isOpe) {
      await rescheduleJob(jobId);
    }

    return res.json({ success: true, data: upd.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[CronJobs] updateVersion error:', error);
    return res.status(500).json({ success: false, message: error.message });
  } finally {
    client.release();
  }
};

// DELETE /api/cron-jobs/:id/versions/:vid
export const deleteVersion = async (req, res) => {
  try {
    const jobId = Number(req.params.id);
    const vid   = Number(req.params.vid);
    if (!Number.isFinite(jobId) || !Number.isFinite(vid)) {
      return res.status(400).json({ success: false, message: 'id/vid inválido' });
    }

    const { rows } = await pool.query(
      `SELECT status FROM maestro.cron_job_versions WHERE id = $1 AND job_id = $2`,
      [vid, jobId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Versão não encontrada' });
    if (rows[0].status === 'OPE') {
      return res.status(409).json({ success: false, message: 'Não é possível excluir a versão em OPE. Promova outra antes.' });
    }

    await pool.query('DELETE FROM maestro.cron_job_versions WHERE id = $1', [vid]);
    return res.json({ success: true });
  } catch (error) {
    console.error('[CronJobs] deleteVersion error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// POST /api/cron-jobs/:id/versions/:vid/run
// Executa a versão manualmente (qualquer status). Retorna runId.
export const runVersion = async (req, res) => {
  try {
    const vid = Number(req.params.vid);
    if (!Number.isFinite(vid)) return res.status(400).json({ success: false, message: 'vid inválido' });

    const result = await runVersionById(vid);
    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('[CronJobs] runVersion error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
