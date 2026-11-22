-- Supahound's own security events (issue #138, decision 044; ASVS 16.3).
--
-- security_events: who did what to the workspace's access and data, and whether it worked.
--   One row per sign-in, invite, role change, member removal, Supabase connection, project
--   change, workspace closure and data deletion. Rows hold IDs, enums and small counts only: no
--   email, IP, user agent or free text (the detail CHECK and core/db/securityEvents.ts both refuse
--   them). Events without a tenant (CSRF, bad hook signatures, rejected OAuth state, non-member
--   404s) go to Workers logs instead.
--
--   actor_user_id: the signed-in user (from a verified JWT), or NULL for Supahound itself (the
--     poller, the data job). No foreign key: a person who leaves stays in the record.
--   project_id: the project the event concerns. Its row may go later; the link is then cleared
--     (ON DELETE SET NULL on project_id only), as audit_log does (decision 022).
--   target_id: the person, invite, connection or project acted on. No foreign key, so the record
--     outlives its target.
--
-- RLS (decision 044):
--   * tenant_isolation, as everywhere.
--   * own_sign_in: a signed-in user with no tenant set may add a sign_in row, as themselves, to a
--     workspace they belong to (one INSERT for all their workspaces at sign-in).
--   * owner_read (RESTRICTIVE SELECT): a signed-in user reads rows only as a workspace OWNER.
--     Admins and members write events but cannot read them. Without app.user_id (the data job)
--     the tenant stays visible, as on every table.
--   * project_access (RESTRICTIVE SELECT): the policy every table with project_id carries
--     (decision 036). Owners pass it anyway.
--   * actor_is_me (RESTRICTIVE INSERT): with app.user_id set, the actor must be that user.
--   * system_delete (RESTRICTIVE DELETE): only a transaction without app.user_id (the daily data
--     job, the purge) deletes, so for every signed-in request the table is append-only. The app
--     role has no UPDATE grant at all.
--
-- Additive only: a new table, its indexes, policies and grants. Safe to run twice.

BEGIN;

CREATE TABLE IF NOT EXISTS supahound.security_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES supahound.tenants (id) ON DELETE CASCADE,
  project_id uuid,
  actor_user_id uuid,
  action text NOT NULL CHECK (action IN (
    'sign_in',
    'invite_sent', 'invite_accepted', 'invite_revoked',
    'role_changed', 'member_removed',
    'connection_added', 'connection_removed',
    'project_added', 'project_removed', 'project_kept',
    'workspace_closed', 'workspace_reopened',
    'data_deleted'
  )),
  target_id uuid,
  result text NOT NULL CHECK (result IN ('success', 'denied', 'failed')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 512),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES supahound.projects (tenant_id, id) ON DELETE SET NULL (project_id)
);
-- The Security log page reads newest first, by keyset (created_at, id).
CREATE INDEX IF NOT EXISTS security_events_tenant_idx ON supahound.security_events (tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS security_events_project_idx ON supahound.security_events (tenant_id, project_id) WHERE project_id IS NOT NULL;

ALTER TABLE supahound.security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.security_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON supahound.security_events;
CREATE POLICY tenant_isolation ON supahound.security_events TO supahound_app
  USING (tenant_id = (SELECT supahound.current_tenant()))
  WITH CHECK (tenant_id = (SELECT supahound.current_tenant()));

DROP POLICY IF EXISTS own_sign_in ON supahound.security_events;
CREATE POLICY own_sign_in ON supahound.security_events FOR INSERT TO supahound_app
  WITH CHECK (action = 'sign_in' AND result = 'success' AND project_id IS NULL AND target_id IS NULL
              AND (SELECT supahound.current_user_id()) IS NOT NULL
              AND actor_user_id = (SELECT supahound.current_user_id())
              AND tenant_id IN (SELECT m.tenant_id FROM supahound.memberships m WHERE m.user_id = (SELECT supahound.current_user_id())));

DROP POLICY IF EXISTS owner_read ON supahound.security_events;
CREATE POLICY owner_read ON supahound.security_events AS RESTRICTIVE FOR SELECT TO supahound_app
  USING ((SELECT supahound.current_user_id()) IS NULL OR (SELECT supahound.current_workspace_role()) = 'owner');

DROP POLICY IF EXISTS project_access ON supahound.security_events;
CREATE POLICY project_access ON supahound.security_events AS RESTRICTIVE FOR SELECT TO supahound_app
  USING ((SELECT supahound.current_user_id()) IS NULL
         OR (SELECT supahound.current_workspace_role()) IN ('owner', 'admin')
         OR project_id IN (SELECT pm.project_id FROM supahound.project_members pm
                           WHERE pm.tenant_id = (SELECT supahound.current_tenant())
                             AND pm.user_id = (SELECT supahound.current_user_id())));

DROP POLICY IF EXISTS actor_is_me ON supahound.security_events;
CREATE POLICY actor_is_me ON supahound.security_events AS RESTRICTIVE FOR INSERT TO supahound_app
  WITH CHECK ((SELECT supahound.current_user_id()) IS NULL OR actor_user_id = (SELECT supahound.current_user_id()));

DROP POLICY IF EXISTS system_delete ON supahound.security_events;
CREATE POLICY system_delete ON supahound.security_events AS RESTRICTIVE FOR DELETE TO supahound_app
  USING ((SELECT supahound.current_user_id()) IS NULL);

GRANT SELECT, INSERT, DELETE ON supahound.security_events TO supahound_app;

COMMIT;
