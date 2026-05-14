-- Fase 5: Security — rate-limit / lockout columns
-- idle_timeout_enabled, idle_timeout_minutes, must_change_password, deleted_at
-- were already added in earlier fases.
-- This migration adds the login-lockout tracking columns.

ALTER TABLE maestro.users
  ADD COLUMN IF NOT EXISTS failed_attempts INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_failed_at  TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMP WITH TIME ZONE;

-- Index to speed up lockout checks on login
CREATE INDEX IF NOT EXISTS idx_users_locked_until ON maestro.users (locked_until)
  WHERE locked_until IS NOT NULL;
