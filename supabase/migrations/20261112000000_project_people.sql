-- People and roles per project (issue #24, decisions 033 and 036).
--
-- project_members: one role per person per project: owner, admin, editor or viewer. A person must
--   be a workspace member first (FK to memberships), so leaving the workspace removes every
--   project role (cascade).
-- project_invites: an email invite to one project. Only the SHA-256 of the token is stored. An
--   invite is single use (accepted_at), expires (expires_at, 7 days, set by the app) and can be
--   canceled (canceled_at).
--
-- Effective project role (supahound.project_role):
--   workspace owner -> owner on every project, workspace admin -> at least admin on every project,
--   anyone else -> their project_members row, or no access. Owners and admins need no rows, so a
--   project added later is theirs at once, and a change of workspace role applies at once.
--
-- RLS: the new tables get the usual tenant_isolation policy. Every table that holds project data
-- also gets a RESTRICTIVE policy: a signed-in user (app.user_id set) sees a project's rows only
-- with a role on that project. A transaction without app.user_id (poller, billing sync, Stripe
-- webhook, invite acceptance after its checks) keeps the whole tenant, as before.
--
-- Production safety: additive only. The code before this change sets app.user_id only in
-- withTenantForUser, and today only owners exist (createWorkspace is the only writer of
-- memberships). Owners see and change everything they did before. The backfill gives every
-- existing workspace member the viewer role on every project, so nobody loses access.
-- Safe to run twice: IF NOT EXISTS, CREATE OR REPLACE, DROP POLICY IF EXISTS, ON CONFLICT.

BEGIN;

-- The backfill must see every row. If the migrating role cannot bypass RLS, fail loudly instead
-- of inserting nothing.
SET LOCAL row_security = off;

CREATE TABLE IF NOT EXISTS supahound.project_members (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, user_id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES supahound.projects (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, user_id) REFERENCES supahound.memberships (tenant_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS project_members_user_idx ON supahound.project_members (tenant_id, user_id);

CREATE TABLE IF NOT EXISTS supahound.project_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 320 AND email ~ '^[^\s@<>,;"]+@[^\s@<>,;"]+$' AND email = lower(email)),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'editor', 'viewer')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by uuid,
  canceled_at timestamptz,
  UNIQUE (tenant_id, id),
  CHECK ((accepted_at IS NULL) = (accepted_by IS NULL)),
  CHECK (accepted_at IS NULL OR canceled_at IS NULL),
  FOREIGN KEY (tenant_id, project_id) REFERENCES supahound.projects (tenant_id, id) ON DELETE CASCADE
);
-- One open invite per address per project; a second invite to the same address resends it.
CREATE UNIQUE INDEX IF NOT EXISTS project_invites_open_idx
  ON supahound.project_invites (tenant_id, project_id, email) WHERE accepted_at IS NULL AND canceled_at IS NULL;

-- The signed-in user's workspace role in the transaction's tenant, or NULL.
CREATE OR REPLACE FUNCTION supahound.current_workspace_role() RETURNS text
  LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT m.role FROM supahound.memberships m
  WHERE m.tenant_id = supahound.current_tenant() AND m.user_id = supahound.current_user_id()
$$;

-- The signed-in user's effective role on one project of the transaction's tenant, or NULL.
-- SECURITY INVOKER on purpose: it reads through the caller's RLS, so it never sees another tenant.
CREATE OR REPLACE FUNCTION supahound.project_role(p_project uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT CASE
           WHEN w.role = 'owner' THEN 'owner'
           WHEN w.role = 'admin' THEN CASE WHEN pm.role = 'owner' THEN 'owner' ELSE 'admin' END
           WHEN w.role IS NOT NULL THEN pm.role
         END
  FROM (SELECT supahound.current_tenant() AS t, supahound.current_user_id() AS u) me
  LEFT JOIN supahound.memberships w ON w.tenant_id = me.t AND w.user_id = me.u
  LEFT JOIN supahound.project_members pm ON pm.tenant_id = me.t AND pm.project_id = p_project AND pm.user_id = me.u
$$;

REVOKE ALL ON FUNCTION supahound.current_workspace_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION supahound.project_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION supahound.current_workspace_role(), supahound.project_role(uuid) TO supahound_app;

ALTER TABLE supahound.project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.project_members FORCE ROW LEVEL SECURITY;
ALTER TABLE supahound.project_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.project_invites FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_members', 'project_invites'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON supahound.%I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON supahound.%I TO supahound_app
         USING (tenant_id = (SELECT supahound.current_tenant()))
         WITH CHECK (tenant_id = (SELECT supahound.current_tenant()))', t);
  END LOOP;

  -- Project visibility for signed-in users. The subquery on project_members is uncorrelated, so
  -- Postgres runs it once per statement. project_members itself gets no such policy: a policy on
  -- it that reads it would recurse. audit_log rows without a project (project_id NULL) are
  -- workspace-wide: only owners and admins see them.
  FOREACH t IN ARRAY ARRAY['projects', 'service_role_networks', 'poll_runs', 'incidents', 'findings', 'project_usage', 'audit_log'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS project_access ON supahound.%I', t);
    EXECUTE format(
      'CREATE POLICY project_access ON supahound.%I AS RESTRICTIVE FOR SELECT TO supahound_app
         USING ((SELECT supahound.current_user_id()) IS NULL
                OR (SELECT supahound.current_workspace_role()) IN (''owner'', ''admin'')
                OR %s IN (SELECT pm.project_id FROM supahound.project_members pm
                          WHERE pm.tenant_id = (SELECT supahound.current_tenant())
                            AND pm.user_id = (SELECT supahound.current_user_id())))',
      t, CASE WHEN t = 'projects' THEN 'id' ELSE 'project_id' END);
  END LOOP;
END
$$;

-- Writes by signed-in users, enforced here as well as in the server actions (decision 036):
--   change a project's settings: editor and up; remove a project: project owner or workspace admin.
DROP POLICY IF EXISTS project_settings ON supahound.projects;
CREATE POLICY project_settings ON supahound.projects AS RESTRICTIVE FOR UPDATE TO supahound_app
  USING ((SELECT supahound.current_user_id()) IS NULL OR supahound.project_role(id) IN ('owner', 'admin', 'editor'));
DROP POLICY IF EXISTS project_remove ON supahound.projects;
CREATE POLICY project_remove ON supahound.projects AS RESTRICTIVE FOR DELETE TO supahound_app
  USING ((SELECT supahound.current_user_id()) IS NULL
         OR (SELECT supahound.current_workspace_role()) IN ('owner', 'admin')
         OR supahound.project_role(id) = 'owner');

--   manage people and invites: owner and admin; only an owner grants, changes or removes the owner role.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_members', 'project_invites'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS people_insert ON supahound.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS people_update ON supahound.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS people_delete ON supahound.%I', t);
    EXECUTE format(
      'CREATE POLICY people_insert ON supahound.%I AS RESTRICTIVE FOR INSERT TO supahound_app
         WITH CHECK ((SELECT supahound.current_user_id()) IS NULL
                     OR supahound.project_role(project_id) = ''owner''
                     OR (supahound.project_role(project_id) = ''admin'' AND role <> ''owner''))', t);
    EXECUTE format(
      'CREATE POLICY people_update ON supahound.%I AS RESTRICTIVE FOR UPDATE TO supahound_app
         USING ((SELECT supahound.current_user_id()) IS NULL
                OR supahound.project_role(project_id) = ''owner''
                OR (supahound.project_role(project_id) = ''admin'' AND role <> ''owner''))
         WITH CHECK ((SELECT supahound.current_user_id()) IS NULL
                     OR supahound.project_role(project_id) = ''owner''
                     OR (supahound.project_role(project_id) = ''admin'' AND role <> ''owner''))', t);
    EXECUTE format(
      'CREATE POLICY people_delete ON supahound.%I AS RESTRICTIVE FOR DELETE TO supahound_app
         USING ((SELECT supahound.current_user_id()) IS NULL
                OR supahound.project_role(project_id) = ''owner''
                OR (supahound.project_role(project_id) = ''admin'' AND role <> ''owner''))', t);
  END LOOP;
END
$$;

-- Pending invites are visible to the project's owners and admins only.
DROP POLICY IF EXISTS invites_read ON supahound.project_invites;
CREATE POLICY invites_read ON supahound.project_invites AS RESTRICTIVE FOR SELECT TO supahound_app
  USING ((SELECT supahound.current_user_id()) IS NULL OR supahound.project_role(project_id) IN ('owner', 'admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON supahound.project_members, supahound.project_invites TO supahound_app;

-- Backfill (decision 033): workspace members become viewers on every project. Owners and admins
-- need no rows (see project_role). Safe to run again: it adds only missing rows.
INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role)
SELECT p.tenant_id, p.id, m.user_id, 'viewer'
FROM supahound.projects p
JOIN supahound.memberships m ON m.tenant_id = p.tenant_id
WHERE m.role = 'member'
ON CONFLICT (tenant_id, project_id, user_id) DO NOTHING;

COMMIT;
