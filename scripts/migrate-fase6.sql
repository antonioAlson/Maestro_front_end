-- Fase 6 migration: add last_login_at tracking column
-- Run once on the server before restarting the API:
--   psql -U caio -d opera -f scripts/migrate-fase6.sql

ALTER TABLE maestro.users
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_users_last_login_at ON maestro.users (last_login_at DESC)
  WHERE last_login_at IS NOT NULL;



ALTER TABLE maestro.users DROP COLUMN IF EXISTS menu_access;
ADD COLUMN IF NOT EXISTS menu_access JSONB;