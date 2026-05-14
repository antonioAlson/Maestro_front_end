import cron from 'node-cron';
import { query } from '../config/database.js';

export function startRoleExpirationJob() {
  // Runs daily at 02:00 — removes user_roles whose expires_at has passed
  cron.schedule('0 2 * * *', async () => {
    try {
      const result = await query(
        `DELETE FROM maestro.user_roles
         WHERE expires_at IS NOT NULL AND expires_at < now()
         RETURNING user_id, role_id`,
      );

      if (result.rowCount > 0) {
        for (const row of result.rows) {
          await query(
            `INSERT INTO maestro.access_audit
               (user_id, user_email, event_type, target_user_id, details)
             VALUES (NULL, 'system', 'role_revoked', $1, $2::jsonb)`,
            [row.user_id, JSON.stringify({ roleId: row.role_id, trigger: 'expiration_cron' })],
          );
        }
        console.log(`[RoleExpiration] Removed ${result.rowCount} expired role assignment(s).`);
      }
    } catch (err) {
      console.error('[RoleExpiration] Cron error:', err);
    }
  });

  console.log('[RoleExpiration] Job scheduled — runs daily at 02:00.');
}
