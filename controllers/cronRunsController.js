import pool from '../config/database.js';

const VALID_STATUS = new Set(['running', 'success', 'error', 'skipped']);

// GET /api/cron-runs?job=X&status=Y&limit=50
export const listCronRuns = async (req, res) => {
  try {
    const limit  = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const job    = String(req.query.job    || '').trim();
    const status = String(req.query.status || '').trim();

    const where  = [];
    const params = [];

    if (job)    { params.push(job);    where.push(`job_name = $${params.length}`); }
    if (status && VALID_STATUS.has(status)) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }

    params.push(limit);
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT id, job_name, started_at, finished_at, status,
              records_processed, error_message, details,
              EXTRACT(EPOCH FROM (COALESCE(finished_at, now()) - started_at))::int AS duration_seconds
         FROM maestro.cron_runs
         ${whereSql}
         ORDER BY started_at DESC
         LIMIT $${params.length}`,
      params
    );

    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[CronRuns] list error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};

// GET /api/cron-runs/summary
// One row per distinct job: last run, last success, success count (last 24h), error count (last 24h)
export const cronRunsSummary = async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        job_name,
        MAX(started_at)                                           AS last_started_at,
        MAX(started_at) FILTER (WHERE status = 'success')         AS last_success_at,
        MAX(started_at) FILTER (WHERE status = 'error')           AS last_error_at,
        COUNT(*) FILTER (WHERE started_at > now() - interval '24 hours')                       AS runs_24h,
        COUNT(*) FILTER (WHERE started_at > now() - interval '24 hours' AND status = 'success') AS success_24h,
        COUNT(*) FILTER (WHERE started_at > now() - interval '24 hours' AND status = 'error')   AS error_24h,
        COUNT(*) FILTER (WHERE started_at > now() - interval '24 hours' AND status = 'skipped') AS skipped_24h
      FROM maestro.cron_runs
      GROUP BY job_name
      ORDER BY job_name
    `);
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('[CronRuns] summary error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
};
