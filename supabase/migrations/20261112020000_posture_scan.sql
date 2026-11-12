-- Posture scan V1 (issue #11, decision 038).
--
-- posture_scans: one row per project. When "Scan now" was asked for, when the poller last tried,
--   and the outcome of each source: the catalog SQL and the Security Advisor.
-- posture_findings: the latest result of each source. A scan replaces the rows of a source only
--   when that source succeeded, so a failed read keeps the last good result (as decision 024).
--
-- RLS: tenant_isolation as on every table; project_access (RESTRICTIVE SELECT, decision 036) so a
-- signed-in user sees a project's posture only with a role on it. Signed-in users may ask for a
-- scan (INSERT/UPDATE of posture_scans) as the project's owner, admin or editor. Only the poller
-- (no app.user_id) writes findings.
--
-- Production safety: additive only. New tables, policies and grants; no existing table, column,
-- constraint or policy changes, and no DROP. The code before this change never reads these
-- tables. Safe to run twice: IF NOT EXISTS, and each policy is created only when missing.

BEGIN;

CREATE TABLE IF NOT EXISTS supahound.posture_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  -- "Scan now": pending while requested_at is later than attempted_at (or nothing was attempted).
  requested_at timestamptz,
  requested_by uuid,
  -- The poller's last claim, success or failure. Drives the daily refresh and the 1-hour retry.
  attempted_at timestamptz,
  -- The last attempt at which every source that ran is saved. NULL = never finished.
  finished_at timestamptz,
  catalog_status text CHECK (catalog_status IN ('ok', 'unauthorized', 'rate_limited', 'query_failed', 'invalid_response', 'network_error', 'unavailable')),
  catalog_scanned_at timestamptz,
  advisor_status text CHECK (advisor_status IN ('ok', 'unauthorized', 'rate_limited', 'query_failed', 'invalid_response', 'network_error', 'unavailable')),
  advisor_scanned_at timestamptz,
  -- Counts from the last catalog read, for the page ("12 tables, 3 views, 20 policies checked").
  tables_checked integer CHECK (tables_checked >= 0),
  views_checked integer CHECK (views_checked >= 0),
  policies_checked integer CHECK (policies_checked >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, project_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES supahound.projects (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS supahound.posture_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  scan_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('catalog', 'advisor')),
  -- A catalog check or an Advisor lint name: snake_case only.
  check_id text NOT NULL CHECK (check_id ~ '^[a-z0-9_]{1,64}$'),
  severity text NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  -- Catalog identifiers: 1 to 63 characters, no control characters.
  schema_name text CHECK (length(schema_name) BETWEEN 1 AND 63 AND schema_name !~ '[[:cntrl:]]'),
  object_name text CHECK (length(object_name) BETWEEN 1 AND 63 AND object_name !~ '[[:cntrl:]]'),
  object_type text CHECK (object_type IN ('table', 'view', 'materialized view', 'foreign table', 'auth', 'function', 'extension', 'compliance', 'health')),
  -- Structured evidence only: enums, booleans, counts, identifiers. Never free text.
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(evidence) = 'object'),
  found_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES supahound.projects (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, scan_id) REFERENCES supahound.posture_scans (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS posture_findings_project_idx ON supahound.posture_findings (tenant_id, project_id, source);
CREATE INDEX IF NOT EXISTS posture_findings_scan_idx ON supahound.posture_findings (tenant_id, scan_id);

ALTER TABLE supahound.posture_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.posture_scans FORCE ROW LEVEL SECURITY;
ALTER TABLE supahound.posture_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.posture_findings FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['posture_scans', 'posture_findings'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON supahound.%I TO supahound_app
           USING (tenant_id = (SELECT supahound.current_tenant()))
           WITH CHECK (tenant_id = (SELECT supahound.current_tenant()))', t);
    END IF;
    -- The same project_access rule as decision 036's tables.
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = t AND policyname = 'project_access') THEN
      EXECUTE format(
        'CREATE POLICY project_access ON supahound.%I AS RESTRICTIVE FOR SELECT TO supahound_app
           USING ((SELECT supahound.current_user_id()) IS NULL
                  OR (SELECT supahound.current_workspace_role()) IN (''owner'', ''admin'')
                  OR project_id IN (SELECT pm.project_id FROM supahound.project_members pm
                                    WHERE pm.tenant_id = (SELECT supahound.current_tenant())
                                      AND pm.user_id = (SELECT supahound.current_user_id())))', t);
    END IF;
  END LOOP;

  -- "Scan now" (decision 038): the project's owners, admins and editors, as for project settings.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'posture_scans' AND policyname = 'posture_request_insert') THEN
    CREATE POLICY posture_request_insert ON supahound.posture_scans AS RESTRICTIVE FOR INSERT TO supahound_app
      WITH CHECK ((SELECT supahound.current_user_id()) IS NULL OR supahound.project_role(project_id) IN ('owner', 'admin', 'editor'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'posture_scans' AND policyname = 'posture_request_update') THEN
    CREATE POLICY posture_request_update ON supahound.posture_scans AS RESTRICTIVE FOR UPDATE TO supahound_app
      USING ((SELECT supahound.current_user_id()) IS NULL OR supahound.project_role(project_id) IN ('owner', 'admin', 'editor'))
      WITH CHECK ((SELECT supahound.current_user_id()) IS NULL OR supahound.project_role(project_id) IN ('owner', 'admin', 'editor'));
  END IF;
  -- Scans are never deleted by a signed-in user (removing the project cascades).
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'posture_scans' AND policyname = 'posture_poller_delete') THEN
    CREATE POLICY posture_poller_delete ON supahound.posture_scans AS RESTRICTIVE FOR DELETE TO supahound_app
      USING ((SELECT supahound.current_user_id()) IS NULL);
  END IF;

  -- Findings: written by the poller only.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'posture_findings' AND policyname = 'posture_poller_insert') THEN
    CREATE POLICY posture_poller_insert ON supahound.posture_findings AS RESTRICTIVE FOR INSERT TO supahound_app
      WITH CHECK ((SELECT supahound.current_user_id()) IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'posture_findings' AND policyname = 'posture_poller_update') THEN
    CREATE POLICY posture_poller_update ON supahound.posture_findings AS RESTRICTIVE FOR UPDATE TO supahound_app
      USING ((SELECT supahound.current_user_id()) IS NULL)
      WITH CHECK ((SELECT supahound.current_user_id()) IS NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'posture_findings' AND policyname = 'posture_poller_delete') THEN
    CREATE POLICY posture_poller_delete ON supahound.posture_findings AS RESTRICTIVE FOR DELETE TO supahound_app
      USING ((SELECT supahound.current_user_id()) IS NULL);
  END IF;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON supahound.posture_scans, supahound.posture_findings TO supahound_app;

COMMIT;
