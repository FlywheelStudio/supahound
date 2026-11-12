-- Creates the login user for the subprocessor notice (decision 037, `pnpm subprocessor-notice`).
-- Run it once, after the migrations, only on a database whose owners you email:
--
--   psql "$SUPAHOUND_DB_URL" -v notifier_password="$(openssl rand -hex 32)" -f supabase/setup/notifier-user.sql
--
-- Then set SUPAHOUND_NOTIFIER_DATABASE_URL to a connection string for supahound_notifier_login.
-- The user inherits supahound_notifier: it reads tenant_id, role and email of owner memberships,
-- and nothing else. No superuser, no BYPASSRLS. Running it again changes the password. This file
-- is not a migration, because passwords never go in git.

\set ON_ERROR_STOP on

SELECT set_config('supahound.notifier_password', :'notifier_password', false);

DO $$
DECLARE
  pw text := current_setting('supahound.notifier_password');
BEGIN
  IF length(pw) < 24 THEN
    RAISE EXCEPTION 'The password for supahound_notifier_login must be at least 24 characters';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supahound_notifier') THEN
    RAISE EXCEPTION 'Role supahound_notifier does not exist. Apply supabase/migrations first.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supahound_notifier_login') THEN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supahound_notifier_login' AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb)) THEN
      RAISE EXCEPTION 'Role supahound_notifier_login exists with SUPERUSER, BYPASSRLS, CREATEROLE or CREATEDB. Drop it, then run this file again.';
    END IF;
    EXECUTE format('ALTER ROLE supahound_notifier_login LOGIN INHERIT PASSWORD %L', pw);
  ELSE
    EXECUTE format('CREATE ROLE supahound_notifier_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT PASSWORD %L', pw);
  END IF;
  GRANT supahound_notifier TO supahound_notifier_login;
END
$$;

SELECT set_config('supahound.notifier_password', '', false);
