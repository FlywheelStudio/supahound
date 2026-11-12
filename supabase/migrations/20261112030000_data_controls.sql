-- Data controls (issue #43, decision 037).
--
-- account_closures: one row per closed workspace. The owner closes it; the Stripe subscription
--   cancels at the end of its period (access_ends_at). Once the workspace no longer pays, and at
--   least 30 days after the close (purge_after), the daily data job deletes its logs and history.
--   The workspace record is never deleted: the tenants row, members, billing and payment history,
--   the audit log and this row stay. The owner may reopen before the purge (the row is deleted).
-- connections: a disconnect (in Supahound, or the grant revoked at Supabase) empties the sealed
--   token at once (zero bytes) and stops polling; the history stays until delete_after, and is
--   kept while the workspace pays.
-- supahound_notifier: a NOLOGIN role that reads workspace owners' addresses across tenants, and
--   nothing else, for the subprocessor notice (decision 004). Its login user is created outside
--   migrations (supabase/setup/notifier-user.sql).
--
-- RLS adds RESTRICTIVE policies for signed-in users (app.user_id set), as decision 036 does:
--   * only a workspace owner closes or reopens; nobody signed in edits a closure;
--   * only a workspace owner or admin changes or deletes a Supabase connection (disconnect);
--   * no one deletes a tenant row: the workspace record is kept.
-- billing_accounts gets one PERMISSIVE read policy: a signed-in owner sees the billing rows of the
-- other workspaces they own, so a second free trial can be refused per owner.
--
-- Production safety: additive only. A new table, new nullable columns, a new constraint that every
-- existing row meets, a new role, new policies and grants. Nothing is removed, no data change, no index on a
-- large table. Safe to run twice: IF NOT EXISTS, and DO blocks that check the catalog first.

BEGIN;

CREATE TABLE IF NOT EXISTS supahound.account_closures (
  tenant_id uuid PRIMARY KEY REFERENCES supahound.tenants (id) ON DELETE CASCADE,
  closed_at timestamptz NOT NULL,
  closed_by uuid NOT NULL,
  -- The end of the paid (or trial) period when the owner closed; the close time when nothing was paid.
  access_ends_at timestamptz NOT NULL,
  -- The earliest purge. The data job moves it later while the workspace still pays.
  purge_after timestamptz NOT NULL,
  purged_at timestamptz,
  CHECK (access_ends_at >= closed_at),
  CHECK (purge_after >= access_ends_at),
  CHECK (purged_at IS NULL OR purged_at >= closed_at)
);

ALTER TABLE supahound.account_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.account_closures FORCE ROW LEVEL SECURITY;

ALTER TABLE supahound.connections
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz,
  ADD COLUMN IF NOT EXISTS disconnected_by uuid,
  ADD COLUMN IF NOT EXISTS disconnect_reason text CHECK (disconnect_reason IN ('user', 'revoked')),
  ADD COLUMN IF NOT EXISTS delete_after timestamptz;

DO $$
BEGIN
  -- Every existing row has no disconnect, so the check holds for all of them.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'connections_disconnect_shape' AND conrelid = 'supahound.connections'::regclass) THEN
    ALTER TABLE supahound.connections ADD CONSTRAINT connections_disconnect_shape CHECK (
      (disconnected_at IS NULL) = (disconnect_reason IS NULL)
      AND (disconnected_at IS NULL) = (delete_after IS NULL)
      AND (disconnected_at IS NULL OR length(sealed_token) = 0));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supahound_notifier') THEN
    CREATE ROLE supahound_notifier NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Policies: each created once. CREATE POLICY has no IF NOT EXISTS, so check pg_policies.
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN SELECT * FROM (VALUES
    ('account_closures', 'tenant_isolation',
     'CREATE POLICY tenant_isolation ON supahound.account_closures TO supahound_app
        USING (tenant_id = (SELECT supahound.current_tenant()))
        WITH CHECK (tenant_id = (SELECT supahound.current_tenant()))'),
    ('account_closures', 'closure_insert',
     'CREATE POLICY closure_insert ON supahound.account_closures AS RESTRICTIVE FOR INSERT TO supahound_app
        WITH CHECK ((SELECT supahound.current_user_id()) IS NULL OR (SELECT supahound.current_workspace_role()) = ''owner'')'),
    ('account_closures', 'closure_update',
     'CREATE POLICY closure_update ON supahound.account_closures AS RESTRICTIVE FOR UPDATE TO supahound_app
        USING ((SELECT supahound.current_user_id()) IS NULL)'),
    -- Reopen only: the owner, before the purge. A purged closure is never deleted.
    ('account_closures', 'closure_delete',
     'CREATE POLICY closure_delete ON supahound.account_closures AS RESTRICTIVE FOR DELETE TO supahound_app
        USING ((SELECT supahound.current_workspace_role()) = ''owner'' AND purged_at IS NULL)'),
    ('account_closures', 'scheduler_read',
     'CREATE POLICY scheduler_read ON supahound.account_closures FOR SELECT TO supahound_scheduler USING (true)'),
    ('connections', 'connection_write',
     'CREATE POLICY connection_write ON supahound.connections AS RESTRICTIVE FOR UPDATE TO supahound_app
        USING ((SELECT supahound.current_user_id()) IS NULL OR (SELECT supahound.current_workspace_role()) IN (''owner'', ''admin''))'),
    ('connections', 'connection_remove',
     'CREATE POLICY connection_remove ON supahound.connections AS RESTRICTIVE FOR DELETE TO supahound_app
        USING ((SELECT supahound.current_user_id()) IS NULL OR (SELECT supahound.current_workspace_role()) IN (''owner'', ''admin''))'),
    ('tenants', 'tenant_keep',
     'CREATE POLICY tenant_keep ON supahound.tenants AS RESTRICTIVE FOR DELETE TO supahound_app USING (false)'),
    ('billing_accounts', 'owner_trial_history',
     'CREATE POLICY owner_trial_history ON supahound.billing_accounts FOR SELECT TO supahound_app
        USING ((SELECT supahound.current_user_id()) IS NOT NULL
               AND tenant_id IN (SELECT m.tenant_id FROM supahound.memberships m
                                 WHERE m.user_id = (SELECT supahound.current_user_id()) AND m.role = ''owner''))'),
    ('memberships', 'notifier_read',
     'CREATE POLICY notifier_read ON supahound.memberships FOR SELECT TO supahound_notifier USING (role = ''owner'')')
  ) AS t(tbl, name, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'supahound' AND tablename = p.tbl AND policyname = p.name) THEN
      EXECUTE p.ddl;
    END IF;
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON supahound.account_closures TO supahound_app;
GRANT SELECT (tenant_id, access_ends_at, purge_after, purged_at) ON supahound.account_closures TO supahound_scheduler;
GRANT USAGE ON SCHEMA supahound TO supahound_notifier;
GRANT SELECT (tenant_id, role, email) ON supahound.memberships TO supahound_notifier;

COMMIT;
