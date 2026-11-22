-- Per-project detection settings (issue #160, decision 045).
--
-- projects.rpc_burst_hits: detector 12's paging threshold, anon calls to one exposed SECURITY
--   DEFINER function from one network in one poll. Default 100 (the value the detector shipped
--   with), range 10 to 10,000. The existing project_settings policy covers the write: the
--   project's owners, admins and editors change it, as they change the email alert threshold.
-- public_tables: tables in `public` that the project's Owners or Admins marked intentionally
--   public. Detector 11 (exposed_read) stops watching them; the Posture page shows their read
--   findings as accepted. The name is a lower-case identifier, the only form the detector matches.
--   The (tenant_id, project_id) foreign key keeps a mark inside its tenant; removing the project
--   removes its marks. Unmark is a delete, so there is no UPDATE grant.
-- audit_log: a new action, detection_setting, for every mark, unmark and threshold change.
--
-- RLS on public_tables: tenant_isolation; project_access (RESTRICTIVE SELECT, decision 036); the
-- project's owners and admins insert and delete (RESTRICTIVE). Transactions without app.user_id
-- (the poller) keep the whole tenant.
--
-- Production safety: additive. One column with a default (no table rewrite on Postgres 11 and
-- later), one new table, new policies and grants, and the audit action list only grows, swapped
-- in one ALTER TABLE statement. Safe to run twice: IF NOT EXISTS, and each policy is created only
-- when missing.

BEGIN;

ALTER TABLE supahound.projects
  ADD COLUMN IF NOT EXISTS rpc_burst_hits integer NOT NULL DEFAULT 100
    CONSTRAINT projects_rpc_burst_hits_range CHECK (rpc_burst_hits BETWEEN 10 AND 10000);

CREATE TABLE IF NOT EXISTS supahound.public_tables (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  table_name text NOT NULL CHECK (table_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
  -- The signed-in user who marked it (NULL for a system write). No foreign key: the mark stays
  -- when that person leaves the workspace.
  marked_by uuid,
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, project_id, table_name),
  FOREIGN KEY (tenant_id, project_id) REFERENCES supahound.projects (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE supahound.public_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.public_tables FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'public_tables' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON supahound.public_tables TO supahound_app
      USING (tenant_id = (SELECT supahound.current_tenant()))
      WITH CHECK (tenant_id = (SELECT supahound.current_tenant()));
  END IF;
  -- The same project_access rule as decision 036's tables.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'public_tables' AND policyname = 'project_access') THEN
    CREATE POLICY project_access ON supahound.public_tables AS RESTRICTIVE FOR SELECT TO supahound_app
      USING ((SELECT supahound.current_user_id()) IS NULL
             OR (SELECT supahound.current_workspace_role()) IN ('owner', 'admin')
             OR project_id IN (SELECT pm.project_id FROM supahound.project_members pm
                               WHERE pm.tenant_id = (SELECT supahound.current_tenant())
                                 AND pm.user_id = (SELECT supahound.current_user_id())));
  END IF;
  -- Mark and unmark (decision 045): the project's owners and admins.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'public_tables' AND policyname = 'public_table_insert') THEN
    CREATE POLICY public_table_insert ON supahound.public_tables AS RESTRICTIVE FOR INSERT TO supahound_app
      WITH CHECK ((SELECT supahound.current_user_id()) IS NULL OR supahound.project_role(project_id) IN ('owner', 'admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'public_tables' AND policyname = 'public_table_delete') THEN
    CREATE POLICY public_table_delete ON supahound.public_tables AS RESTRICTIVE FOR DELETE TO supahound_app
      USING ((SELECT supahound.current_user_id()) IS NULL OR supahound.project_role(project_id) IN ('owner', 'admin'));
  END IF;
END
$$;

GRANT SELECT, INSERT, DELETE ON supahound.public_tables TO supahound_app;

ALTER TABLE supahound.audit_log
  DROP CONSTRAINT IF EXISTS audit_log_action_check,
  ADD CONSTRAINT audit_log_action_check
    CHECK (action IN ('logs_query', 'policies_query', 'model_call', 'alert_email', 'detection_setting'));

COMMIT;
