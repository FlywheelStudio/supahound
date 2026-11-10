-- Creates the two database login users the Workers connect as, through Hyperdrive (decision 025,
-- docs/self-hosting.md). Run it once on your own Supahound database, after the migrations:
--
--   psql "$SUPAHOUND_DB_URL" \
--     -v app_password="$(openssl rand -hex 32)" \
--     -v scheduler_password="$(openssl rand -hex 32)" \
--     -f supabase/setup/login-users.sql
--
-- Keep both passwords for the two Hyperdrive configs. Running it again changes the passwords.
--
-- The migrations create supahound_app and supahound_scheduler as NOLOGIN roles that hold the
-- privileges. These users only log in and inherit them: no superuser, no BYPASSRLS, so forced
-- RLS applies to every query. This file is not a migration, because passwords never go in git.

\set ON_ERROR_STOP on

SELECT set_config('supahound.app_password', :'app_password', false),
       set_config('supahound.scheduler_password', :'scheduler_password', false);

DO $$
DECLARE
  users constant text[][] := ARRAY[
    ARRAY['supahound_app_login', 'supahound_app', current_setting('supahound.app_password')],
    ARRAY['supahound_scheduler_login', 'supahound_scheduler', current_setting('supahound.scheduler_password')]
  ];
  u text[];
BEGIN
  FOREACH u SLICE 1 IN ARRAY users LOOP
    IF length(u[3]) < 24 THEN
      RAISE EXCEPTION 'The password for % must be at least 24 characters', u[1];
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = u[2]) THEN
      RAISE EXCEPTION 'Role % does not exist. Apply supabase/migrations first.', u[2];
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = u[1]) THEN
      EXECUTE format('ALTER ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT PASSWORD %L', u[1], u[3]);
    ELSE
      EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE INHERIT PASSWORD %L', u[1], u[3]);
    END IF;
    EXECUTE format('GRANT %I TO %I', u[2], u[1]);
  END LOOP;
END
$$;

SELECT set_config('supahound.app_password', '', false),
       set_config('supahound.scheduler_password', '', false);
