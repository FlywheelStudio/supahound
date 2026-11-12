-- Scan domains per project (issue #100, decisions 034 and 040).
--
-- scan_domain_links: a verified scan domain belongs to at most one watched project. The primary
--   key (tenant_id, domain_id) allows one link per domain. Both foreign keys carry tenant_id, so a
--   link never joins two tenants. Removing the project or the domain removes the link.
--
-- Rules:
--   * Only a verified domain can be linked, by any writer: a BEFORE INSERT trigger refuses a domain
--     the writer cannot see or that has no verified_at.
--   * RLS: tenant_isolation; project_access (RESTRICTIVE SELECT, decision 036); the project's owners
--     and admins insert and delete links (RESTRICTIVE). No UPDATE grant: a move is detach, then attach.
--   * scan_link_access (RESTRICTIVE SELECT) on the five scan funnel tables: a signed-in user sees a
--     domain and its scan rows as a workspace owner or admin, or when the domain is linked to a
--     project they have a role on. Unlinked domains are workspace data, like audit rows with no
--     project. Transactions without app.user_id (poller, scan jobs) keep the whole tenant.
--
-- Production safety: additive only. One new table, a trigger, new policies and grants. No existing
-- table, column, constraint or policy changes, and nothing is removed. The code before this change
-- never reads the scan funnel tables, so the new SELECT policies on them change nothing it does.
-- Safe to run twice: IF NOT EXISTS, CREATE OR REPLACE, and each policy and the trigger are created
-- only when missing.

BEGIN;

CREATE TABLE IF NOT EXISTS supahound.scan_domain_links (
  tenant_id uuid NOT NULL,
  domain_id uuid NOT NULL,
  project_id uuid NOT NULL,
  -- The signed-in user who attached the domain (NULL for a system write). No foreign key: the
  -- link stays when that person leaves the workspace.
  linked_by uuid,
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, domain_id),
  FOREIGN KEY (tenant_id, domain_id) REFERENCES supahound.scan_domains (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, project_id) REFERENCES supahound.projects (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS scan_domain_links_project_idx ON supahound.scan_domain_links (tenant_id, project_id);

-- Only a verified domain can be linked. SECURITY INVOKER: the lookup reads through the writer's
-- RLS, so a domain the writer cannot see counts as not verified.
CREATE OR REPLACE FUNCTION supahound.scan_link_requires_verified() RETURNS trigger
  LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM supahound.scan_domains d
    WHERE d.tenant_id = NEW.tenant_id AND d.id = NEW.domain_id AND d.verified_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'scan domain is not verified' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION supahound.scan_link_requires_verified() FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
                 WHERE tgrelid = 'supahound.scan_domain_links'::regclass AND tgname = 'scan_link_requires_verified') THEN
    CREATE TRIGGER scan_link_requires_verified BEFORE INSERT ON supahound.scan_domain_links
      FOR EACH ROW EXECUTE FUNCTION supahound.scan_link_requires_verified();
  END IF;
END
$$;

ALTER TABLE supahound.scan_domain_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.scan_domain_links FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'scan_domain_links' AND policyname = 'tenant_isolation') THEN
    CREATE POLICY tenant_isolation ON supahound.scan_domain_links TO supahound_app
      USING (tenant_id = (SELECT supahound.current_tenant()))
      WITH CHECK (tenant_id = (SELECT supahound.current_tenant()));
  END IF;
  -- The same project_access rule as decision 036's tables.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'scan_domain_links' AND policyname = 'project_access') THEN
    CREATE POLICY project_access ON supahound.scan_domain_links AS RESTRICTIVE FOR SELECT TO supahound_app
      USING ((SELECT supahound.current_user_id()) IS NULL
             OR (SELECT supahound.current_workspace_role()) IN ('owner', 'admin')
             OR project_id IN (SELECT pm.project_id FROM supahound.project_members pm
                               WHERE pm.tenant_id = (SELECT supahound.current_tenant())
                                 AND pm.user_id = (SELECT supahound.current_user_id())));
  END IF;
  -- Attach and detach (decision 040): the project's owners and admins.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'scan_domain_links' AND policyname = 'scan_link_insert') THEN
    CREATE POLICY scan_link_insert ON supahound.scan_domain_links AS RESTRICTIVE FOR INSERT TO supahound_app
      WITH CHECK ((SELECT supahound.current_user_id()) IS NULL OR supahound.project_role(project_id) IN ('owner', 'admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'scan_domain_links' AND policyname = 'scan_link_delete') THEN
    CREATE POLICY scan_link_delete ON supahound.scan_domain_links AS RESTRICTIVE FOR DELETE TO supahound_app
      USING ((SELECT supahound.current_user_id()) IS NULL OR supahound.project_role(project_id) IN ('owner', 'admin'));
  END IF;

  -- Scan data follows the link. The subqueries are uncorrelated, so Postgres runs each once per
  -- statement; each reads through the RLS of the table it names (links: project_access; scans:
  -- this policy), so a member sees only the domains linked to their projects.
  FOREACH t IN ARRAY ARRAY['scan_domains', 'scan_authorizations', 'scans', 'scan_findings', 'scan_jobs'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = t AND policyname = 'scan_link_access') THEN
      EXECUTE format(
        'CREATE POLICY scan_link_access ON supahound.%I AS RESTRICTIVE FOR SELECT TO supahound_app
           USING ((SELECT supahound.current_user_id()) IS NULL
                  OR (SELECT supahound.current_workspace_role()) IN (''owner'', ''admin'')
                  OR %s)',
        t,
        CASE
          WHEN t = 'scan_domains' THEN
            'id IN (SELECT l.domain_id FROM supahound.scan_domain_links l WHERE l.tenant_id = (SELECT supahound.current_tenant()))'
          WHEN t IN ('scan_authorizations', 'scans') THEN
            'domain_id IN (SELECT l.domain_id FROM supahound.scan_domain_links l WHERE l.tenant_id = (SELECT supahound.current_tenant()))'
          ELSE
            'scan_id IN (SELECT s.id FROM supahound.scans s WHERE s.tenant_id = (SELECT supahound.current_tenant()))'
        END);
    END IF;
  END LOOP;
END
$$;

GRANT SELECT, INSERT, DELETE ON supahound.scan_domain_links TO supahound_app;

COMMIT;
