-- Fase 7: Drop legacy menu_access column
-- Run AFTER ensuring all active sessions are using RBAC (roles/permissions).
-- Safe to run multiple times (IF EXISTS guard).

ALTER TABLE maestro.users DROP COLUMN IF EXISTS menu_access;
