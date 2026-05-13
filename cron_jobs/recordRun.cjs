require("dotenv").config();

const { Pool } = require("pg");

const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "maestro",
  password: process.env.DB_PASSWORD || "postgres",
  port: process.env.DB_PORT || 5432,
});

// Wraps a cron handler with persistence to maestro.cron_runs.
//
// Usage:
//   await recordRun('sync_cards_jira', async (ctx) => {
//     // ... do work
//     ctx.setRecordsProcessed(total);
//     ctx.setDetails({ anything: 'useful' });
//   });
//
// Behavior:
//   - Inserts row with status 'running' at start.
//   - On resolve  -> status 'success'.
//   - On throw    -> status 'error' + error_message.
//   - On skipped  -> caller can `await recordSkipped(jobName, reason)` instead.
async function recordRun(jobName, fn) {
  const insert = await pool.query(
    `INSERT INTO maestro.cron_runs (job_name, status)
     VALUES ($1, 'running')
     RETURNING id`,
    [jobName]
  );
  const runId = insert.rows[0].id;

  const ctx = {
    runId,
    _records: null,
    _details: null,
    setRecordsProcessed(n) { this._records = Number.isFinite(Number(n)) ? Number(n) : null; },
    setDetails(obj) { this._details = obj == null ? null : obj; },
  };

  try {
    await fn(ctx);
    await pool.query(
      `UPDATE maestro.cron_runs
         SET finished_at = now(),
             status = 'success',
             records_processed = $2,
             details = $3
       WHERE id = $1`,
      [runId, ctx._records, ctx._details ? JSON.stringify(ctx._details) : null]
    );
  } catch (err) {
    const message = err?.message || String(err);
    await pool.query(
      `UPDATE maestro.cron_runs
         SET finished_at = now(),
             status = 'error',
             records_processed = $2,
             error_message = $3,
             details = $4
       WHERE id = $1`,
      [runId, ctx._records, message, ctx._details ? JSON.stringify(ctx._details) : null]
    ).catch(() => { /* swallow — original error matters more */ });
    throw err;
  }
}

async function recordSkipped(jobName, reason) {
  try {
    await pool.query(
      `INSERT INTO maestro.cron_runs (job_name, status, finished_at, error_message)
       VALUES ($1, 'skipped', now(), $2)`,
      [jobName, reason || null]
    );
  } catch {
    /* não derruba o cron se logging falhar */
  }
}

module.exports = { recordRun, recordSkipped };
