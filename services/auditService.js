import { randomUUID } from 'crypto';
import pool from '../config/database.js';

// Atribui um UUID por requisição na primeira chamada e reaproveita em chamadas
// subsequentes — permite correlacionar todos os eventos de uma mesma chamada
// HTTP (útil principalmente para POST /api/mirrors/generate-os).
function getRequestId(req) {
  if (!req) return randomUUID();
  if (!req._auditRequestId) req._auditRequestId = randomUUID();
  return req._auditRequestId;
}

function getActor(req) {
  const u = req?.user || {};
  return {
    user_id:    Number.isFinite(Number(u.id)) ? Number(u.id) : null,
    email:      u.email ?? null,
    ip:         req?.ip ?? null,
    user_agent: req?.headers?.['user-agent'] ?? null,
  };
}

/**
 * Registra criação, alteração ou clonagem de projeto.
 * Falhas de auditoria nunca quebram o fluxo principal — só logam no stderr.
 *
 * @param {Object} opts
 * @param {Object} opts.req           - Express request (para extrair actor + request_id)
 * @param {'CREATE'|'UPDATE'|'CLONE'} opts.action
 * @param {number} opts.projectId
 * @param {string} [opts.projectCode] - código humanamente legível (denormalizado)
 * @param {Object} [opts.before]      - estado anterior (null em CREATE)
 * @param {Object} [opts.after]       - estado posterior (null em DELETE)
 * @param {Object} [opts.metadata]    - extras (ex.: { source_project_id } em CLONE)
 */
export async function logProjectAudit({ req, action, projectId, projectCode, before, after, metadata }) {
  try {
    const actor     = getActor(req);
    const requestId = getRequestId(req);
    await pool.query(
      `INSERT INTO maestro.project_audit
         (actor_user_id, actor_email, action, project_id, project_code, "before", "after", metadata, request_id, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        actor.user_id,
        actor.email,
        action,
        projectId,
        projectCode || null,
        before   ? JSON.stringify(before)   : null,
        after    ? JSON.stringify(after)    : null,
        metadata ? JSON.stringify(metadata) : null,
        requestId,
        actor.ip,
      ]
    );
  } catch (err) {
    console.error('[Audit] Falha ao registrar auditoria de projeto:', err.message);
  }
}

/**
 * Registra uma execução de geração de OS (uma linha por chamada HTTP, mesmo
 * que ela tenha gerado várias OS — o detalhamento por OS vai em `entries`).
 *
 * @param {Object} opts
 * @param {Object} opts.req
 * @param {{ requested: number, success: number, failed: number, fieldWarnings: number }} opts.totals
 * @param {Array<Object>} opts.entries - [{ status, jiraKey, os_number, project_id, project_code, phase?, message? }]
 */
export async function logOsGenerationAudit({ req, totals, entries }) {
  try {
    const actor     = getActor(req);
    const requestId = getRequestId(req);
    await pool.query(
      `INSERT INTO maestro.os_generation_audit
         (actor_user_id, actor_email, request_id, total_requested, total_success, total_failed, total_field_warnings, entries, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        actor.user_id,
        actor.email,
        requestId,
        totals.requested ?? 0,
        totals.success   ?? 0,
        totals.failed    ?? 0,
        totals.fieldWarnings ?? 0,
        JSON.stringify(entries || []),
        actor.ip,
        actor.user_agent,
      ]
    );
  } catch (err) {
    console.error('[Audit] Falha ao registrar geração de OS:', err.message);
  }
}
