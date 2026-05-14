import { query } from '../config/database.js';

// Permissive mode: a user with no roles assigned passes through.
// Set RBAC_MODE=strict in .env to enforce roles even when empty.
const RBAC_MODE = process.env.RBAC_MODE || 'permissive';

async function auditAccess(userId, userEmail, eventType, resource, action, ip, userAgent) {
  try {
    await query(
      `INSERT INTO maestro.access_audit
         (user_id, user_email, event_type, resource, action, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, userEmail, eventType, resource, action, ip || null, userAgent || null],
    );
  } catch {
    // fire-and-forget: never block a request
  }
}

async function resolvePermission(userId, resource, action) {
  const res = await query(
    `SELECT
       u.is_master,
       (SELECT upo.effect
        FROM maestro.user_permission_overrides upo
        JOIN maestro.permissions po ON po.id = upo.permission_id
        WHERE upo.user_id = u.id
          AND po.resource = $2
          AND po.action   = $3
          AND (upo.expires_at IS NULL OR upo.expires_at > now())
        LIMIT 1) AS override_effect,
       (SELECT EXISTS (
          SELECT 1 FROM maestro.user_roles ur2
          WHERE ur2.user_id = u.id
            AND (ur2.expires_at IS NULL OR ur2.expires_at > now())
       )) AS has_any_role,
       (SELECT EXISTS (
          SELECT 1
          FROM maestro.user_roles ur
          JOIN maestro.role_permissions rp ON rp.role_id = ur.role_id
          JOIN maestro.permissions     p  ON p.id = rp.permission_id
          WHERE ur.user_id = u.id
            AND (ur.expires_at IS NULL OR ur.expires_at > now())
            AND p.resource = $2
            AND p.action   = $3
       )) AS has_via_role
     FROM maestro.users u
     WHERE u.id = $1`,
    [userId, resource, action],
  );

  if (!res.rows.length) return { allowed: false, reason: 'user_not_found' };

  const { is_master, override_effect, has_any_role, has_via_role } = res.rows[0];

  if (is_master)                   return { allowed: true,  reason: 'is_master' };
  if (override_effect === 'deny')  return { allowed: false, reason: 'override_deny' };
  if (override_effect === 'grant') return { allowed: true,  reason: 'override_grant' };
  if (RBAC_MODE === 'permissive' && !has_any_role) return { allowed: true, reason: 'permissive_no_roles' };
  if (has_via_role)                return { allowed: true,  reason: 'role' };
  return { allowed: false, reason: 'no_permission' };
}

export function requirePermission(resource, action) {
  return async (req, res, next) => {
    const userId    = req.user?.id;
    const userEmail = req.user?.email;
    const ip        = req.headers['x-forwarded-for'] || req.ip;
    const ua        = req.headers['user-agent'];

    try {
      const { allowed, reason } = await resolvePermission(userId, resource, action);

      if (!allowed) {
        auditAccess(userId, userEmail, 'access_denied', resource, action, ip, ua);
        return res.status(403).json({
          success: false,
          code: 'FORBIDDEN',
          message: 'Acesso negado',
          required: `${resource}:${action}`,
        });
      }

      if (reason === 'is_master') {
        auditAccess(userId, userEmail, 'master_action', resource, action, ip, ua);
      }

      next();
    } catch (err) {
      console.error('rbac error:', err.message);
      if (RBAC_MODE === 'strict') {
        return res.status(500).json({ success: false, message: 'Erro de autorização' });
      }
      // In permissive mode, DB errors don't block requests
      next();
    }
  };
}
