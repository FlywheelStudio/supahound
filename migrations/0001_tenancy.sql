-- Guardbase multi-tenant schema.
--
-- Isolation rules:
--   * Every table carries tenant_id. Child rows reference parents by (tenant_id, id), so a row
--     can never point at another tenant's parent.
--   * RLS is enabled and FORCED on every table. Policies compare tenant_id to the transaction's
--     app.tenant_id setting. An unset setting matches nothing: unscoped queries return zero rows.
--   * guardbase_app (the worker and API) is NOSUPERUSER NOBYPASSRLS and owns nothing.
--   * guardbase_scheduler can read project IDs and poll times only (column grants), nothing else.
--   * audit_log is append-only for the app: no UPDATE or DELETE grant.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guardbase_app') THEN
    CREATE ROLE guardbase_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'guardbase_scheduler') THEN
    CREATE ROLE guardbase_scheduler NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

CREATE SCHEMA guardbase;
REVOKE ALL ON SCHEMA guardbase FROM PUBLIC;
GRANT USAGE ON SCHEMA guardbase TO guardbase_app, guardbase_scheduler;

-- The tenant of the current transaction, or NULL. current_setting returns '' (not NULL) once a
-- session has used set_config, so nullif keeps the cast from throwing.
CREATE FUNCTION guardbase.current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION guardbase.current_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guardbase.current_tenant() TO guardbase_app;

CREATE TABLE guardbase.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One Supabase OAuth grant. The token is sealed by the app (AES-256-GCM, per-tenant key,
-- AAD bound to tenant + connection) and never stored in clear.
CREATE TABLE guardbase.connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guardbase.tenants (id) ON DELETE CASCADE,
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  sealed_token bytea NOT NULL,
  key_version smallint NOT NULL CHECK (key_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE TABLE guardbase.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  supabase_ref text NOT NULL CHECK (supabase_ref ~ '^[a-z0-9]{20}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  -- Owner columns per table and command, from the project's RLS policies (decision 002).
  ownership jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(ownership) = 'object'),
  expected_asns integer[] NOT NULL DEFAULT '{}',
  paused boolean NOT NULL DEFAULT false,
  last_polled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- The same Supabase project may belong to two tenants, but only once per tenant.
  UNIQUE (tenant_id, supabase_ref),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES guardbase.connections (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX projects_connection_idx ON guardbase.projects (tenant_id, connection_id);
CREATE INDEX projects_due_idx ON guardbase.projects (last_polled_at NULLS FIRST) WHERE NOT paused;

-- Hosting ASNs the project's service key has used (detector 4, decision 003).
CREATE TABLE guardbase.service_role_networks (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  asn integer NOT NULL CHECK (asn > 0),
  first_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, asn),
  FOREIGN KEY (tenant_id, project_id) REFERENCES guardbase.projects (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE guardbase.poll_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL CHECK (window_end > window_start),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'unable_to_assess')),
  error_code text CHECK (error_code ~ '^[a-z_]{1,64}$'),
  templates integer CHECK (templates >= 0),
  findings integer CHECK (findings >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES guardbase.projects (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX poll_runs_project_idx ON guardbase.poll_runs (tenant_id, project_id, started_at DESC);

CREATE TABLE guardbase.incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  detectors text[] NOT NULL,
  signals text[] NOT NULL,
  finding_count integer NOT NULL CHECK (finding_count > 0),
  hits integer NOT NULL CHECK (hits > 0),
  opened_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  summary jsonb,
  summary_source text CHECK (summary_source IN ('model', 'template')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES guardbase.projects (tenant_id, id) ON DELETE CASCADE
);
-- Repeats update the open incident instead of paging again.
CREATE UNIQUE INDEX incidents_one_open_idx ON guardbase.incidents (tenant_id, project_id, actor) WHERE status = 'open';
CREATE INDEX incidents_project_idx ON guardbase.incidents (tenant_id, project_id, last_seen_at DESC);

CREATE TABLE guardbase.findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  poll_run_id uuid NOT NULL,
  incident_id uuid,
  detector text NOT NULL CHECK (detector IN ('cross_tenant', 'service_role_misuse')),
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  actor text NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  signals text[] NOT NULL,
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  hits integer NOT NULL CHECK (hits > 0),
  first_seen timestamptz NOT NULL,
  last_seen timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id) REFERENCES guardbase.projects (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, poll_run_id) REFERENCES guardbase.poll_runs (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, incident_id) REFERENCES guardbase.incidents (tenant_id, id) ON DELETE SET NULL (incident_id)
);
CREATE INDEX findings_project_idx ON guardbase.findings (tenant_id, project_id, created_at DESC);
CREATE INDEX findings_poll_run_idx ON guardbase.findings (tenant_id, poll_run_id);
CREATE INDEX findings_incident_idx ON guardbase.findings (tenant_id, incident_id) WHERE incident_id IS NOT NULL;

-- Every query Guardbase runs against a customer project, and every model call, visible to the
-- customer (PRD, Credential hygiene). Holds hashes and counts, never query results.
CREATE TABLE guardbase.audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES guardbase.tenants (id) ON DELETE CASCADE,
  project_id uuid,
  action text NOT NULL CHECK (action IN ('logs_query', 'policies_query', 'model_call')),
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, project_id) REFERENCES guardbase.projects (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX audit_log_tenant_idx ON guardbase.audit_log (tenant_id, created_at DESC);
CREATE INDEX audit_log_project_idx ON guardbase.audit_log (tenant_id, project_id) WHERE project_id IS NOT NULL;

-- RLS: one policy per table, forced, scoped to the transaction's tenant.
ALTER TABLE guardbase.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardbase.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON guardbase.tenants TO guardbase_app
  USING (id = (SELECT guardbase.current_tenant()))
  WITH CHECK (id = (SELECT guardbase.current_tenant()));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connections', 'projects', 'service_role_networks', 'poll_runs',
                           'incidents', 'findings', 'audit_log'] LOOP
    EXECUTE format('ALTER TABLE guardbase.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE guardbase.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON guardbase.%I TO guardbase_app
         USING (tenant_id = (SELECT guardbase.current_tenant()))
         WITH CHECK (tenant_id = (SELECT guardbase.current_tenant()))', t);
  END LOOP;
END
$$;

-- The scheduler sees every project's IDs and poll time, and no other column of any table.
CREATE POLICY scheduler_read ON guardbase.projects FOR SELECT TO guardbase_scheduler USING (true);
GRANT SELECT (tenant_id, id, paused, last_polled_at) ON guardbase.projects TO guardbase_scheduler;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  guardbase.tenants, guardbase.connections, guardbase.projects, guardbase.service_role_networks,
  guardbase.poll_runs, guardbase.incidents, guardbase.findings
  TO guardbase_app;
GRANT SELECT, INSERT ON guardbase.audit_log TO guardbase_app;

COMMIT;
