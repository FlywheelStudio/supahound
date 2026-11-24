-- Expected networks and network memory by name (issue #185, decision 050 points 4 and 5).
--
-- Edge logs carry the network's org name but, in practice, no ASN (#184). Detector 4 therefore
-- needs the name where it used the ASN.
--
-- expected_networks: networks a project's Owners or Admins marked as expected, by the normalized
--   name (`networkName` in packages/core/src/network/classify.ts: lowercase letters, digits and
--   single spaces, at most 80 characters). A mark silences detector 4's network signals for that
--   name only; a browser, mobile app or manual tool still alerts. Same shape and rules as
--   decision 045's public_tables. Unmark is a delete, so there is no UPDATE grant.
-- service_role_network_names: decision 003's memory of hosting networks for events without an
--   ASN, keyed by provider (`amazon`, `railway`, ...) or, for a generic host, by normalized name
--   (`networkMemoryKey`). The poller treats a project with no name rows as not seeded for names, so the
--   first poll that sees names learns them without a new_network signal.
--
-- RLS on both: tenant_isolation and project_access (RESTRICTIVE SELECT, decision 036). On
-- expected_networks, the project's owners and admins insert and delete (RESTRICTIVE).
-- Transactions without app.user_id (the poller) keep the whole tenant. The audit action
-- detection_setting already exists (decision 045).
--
-- Production safety: additive. Two new tables, their policies and grants. Nothing existing
-- changes. Safe to run twice: IF NOT EXISTS, and each policy is created only when missing.

BEGIN;

CREATE TABLE IF NOT EXISTS supahound.expected_networks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  network text NOT NULL CHECK (length(network) <= 80 AND network ~ '^[a-z0-9]+( [a-z0-9]+)*$'),
  -- The signed-in user who marked it (NULL for a system write). No foreign key: the mark stays
  -- when that person leaves the workspace.
  marked_by uuid,
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, project_id, network),
  FOREIGN KEY (tenant_id, project_id) REFERENCES supahound.projects (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS supahound.service_role_network_names (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  network text NOT NULL CHECK (length(network) <= 80 AND network ~ '^[a-z0-9]+( [a-z0-9]+)*$'),
  first_seen timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, network),
  FOREIGN KEY (tenant_id, project_id) REFERENCES supahound.projects (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE supahound.expected_networks ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.expected_networks FORCE ROW LEVEL SECURITY;
ALTER TABLE supahound.service_role_network_names ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.service_role_network_names FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['expected_networks', 'service_role_network_names'] LOOP
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

  -- Mark and unmark (decision 050): the project's owners and admins.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'expected_networks' AND policyname = 'expected_network_insert') THEN
    CREATE POLICY expected_network_insert ON supahound.expected_networks AS RESTRICTIVE FOR INSERT TO supahound_app
      WITH CHECK ((SELECT supahound.current_user_id()) IS NULL OR supahound.project_role(project_id) IN ('owner', 'admin'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'expected_networks' AND policyname = 'expected_network_delete') THEN
    CREATE POLICY expected_network_delete ON supahound.expected_networks AS RESTRICTIVE FOR DELETE TO supahound_app
      USING ((SELECT supahound.current_user_id()) IS NULL OR supahound.project_role(project_id) IN ('owner', 'admin'));
  END IF;
  -- Only the poller (no app.user_id) writes the network memory.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policies WHERE schemaname = 'supahound' AND tablename = 'service_role_network_names' AND policyname = 'poller_write') THEN
    CREATE POLICY poller_write ON supahound.service_role_network_names AS RESTRICTIVE FOR INSERT TO supahound_app
      WITH CHECK ((SELECT supahound.current_user_id()) IS NULL);
  END IF;
END
$$;

GRANT SELECT, INSERT, DELETE ON supahound.expected_networks TO supahound_app;
GRANT SELECT, INSERT ON supahound.service_role_network_names TO supahound_app;

COMMIT;
