import pool from '../config/database.js';

const MAX_LIMIT = 200;

function parseLimitOffset(query) {
  const limit  = Math.min(Math.max(Number(query.limit)  || 50, 1), MAX_LIMIT);
  const offset = Math.max(Number(query.offset) || 0, 0);
  return { limit, offset };
}

// ─── GET /api/audit/projects ────────────────────────────────────────────────
//
// Query params (todos opcionais):
//   action      'CREATE' | 'UPDATE' | 'CLONE'
//   user_id     integer
//   project_id  integer
//   search      texto (busca em project_code e actor_email, ILIKE)
//   from        ISO date — created_at >=
//   to          ISO date — created_at <=
//   limit       1..200 (default 50)
//   offset      0+ (default 0)
//
// Response: { success, data: [...], total, limit, offset }
//
export const listProjectAudit = async (req, res) => {
  try {
    const { limit, offset } = parseLimitOffset(req.query);
    const conds  = [];
    const params = [];

    if (req.query.action) {
      params.push(String(req.query.action).toUpperCase());
      conds.push(`action = $${params.length}`);
    }
    if (req.query.user_id) {
      const n = Number(req.query.user_id);
      if (Number.isFinite(n)) {
        params.push(n);
        conds.push(`actor_user_id = $${params.length}`);
      }
    }
    if (req.query.project_id) {
      const n = Number(req.query.project_id);
      if (Number.isFinite(n)) {
        params.push(n);
        conds.push(`project_id = $${params.length}`);
      }
    }
    if (req.query.search?.trim()) {
      params.push(`%${req.query.search.trim()}%`);
      conds.push(`(project_code ILIKE $${params.length} OR actor_email ILIKE $${params.length})`);
    }
    if (req.query.from) {
      params.push(req.query.from);
      conds.push(`created_at >= $${params.length}`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      conds.push(`created_at <= $${params.length}`);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const totalResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM maestro.project_audit ${where}`,
      params
    );

    const dataParams = [...params, limit, offset];
    const dataResult = await pool.query(
      `SELECT id, created_at, actor_user_id, actor_email, action,
              project_id, project_code, "before", "after", metadata,
              request_id, ip
         FROM maestro.project_audit
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    return res.json({
      success: true,
      data:  dataResult.rows,
      total: totalResult.rows[0].total,
      limit, offset,
    });
  } catch (error) {
    console.error('[Audit] listProjectAudit error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// ─── GET /api/audit/os-generation ───────────────────────────────────────────
//
// Query params (todos opcionais):
//   user_id     integer
//   request_id  uuid
//   search      texto (em actor_email)
//   from / to   ISO date
//   limit       1..200 (default 50)
//   offset      0+
//
export const listOsGenerationAudit = async (req, res) => {
  try {
    const { limit, offset } = parseLimitOffset(req.query);
    const conds  = [];
    const params = [];

    if (req.query.user_id) {
      const n = Number(req.query.user_id);
      if (Number.isFinite(n)) {
        params.push(n);
        conds.push(`actor_user_id = $${params.length}`);
      }
    }
    if (req.query.request_id) {
      params.push(req.query.request_id);
      conds.push(`request_id = $${params.length}`);
    }
    if (req.query.search?.trim()) {
      params.push(`%${req.query.search.trim()}%`);
      conds.push(`actor_email ILIKE $${params.length}`);
    }
    if (req.query.from) {
      params.push(req.query.from);
      conds.push(`created_at >= $${params.length}`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      conds.push(`created_at <= $${params.length}`);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const totalResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM maestro.os_generation_audit ${where}`,
      params
    );

    const dataParams = [...params, limit, offset];
    const dataResult = await pool.query(
      `SELECT id, created_at, actor_user_id, actor_email, request_id,
              total_requested, total_success, total_failed, total_field_warnings,
              entries, ip, user_agent
         FROM maestro.os_generation_audit
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    return res.json({
      success: true,
      data:  dataResult.rows,
      total: totalResult.rows[0].total,
      limit, offset,
    });
  } catch (error) {
    console.error('[Audit] listOsGenerationAudit error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
