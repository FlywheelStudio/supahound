-- Data controls (issue #43, decision 037).
--
-- account_closures: one row per closed workspace. The owner closes the workspace; 30 days later
--   (purge_after) the daily data job deletes the tenant row, and the foreign keys delete every other
--   row of the tenant. This row has no foreign key to tenants on purpose: it outlives the tenant and
--   keeps only the records Supahound must keep for tax and legal reasons (filled in by the purge).
--   The owner may reopen the workspace before the purge (the row is deleted).
-- supahound_notifier: a NOLOGIN role that reads workspace owners' addresses across tenants, and
--   nothing else, for the subprocessor notice (decision 004: cross-tenant admin work gets its own
--   role). Its login user is created outside migrations (supabase/setup/notifier-user.sql).
--
-- RLS adds RESTRICTIVE policies for signed-in users (app.user_id set), as decision 036 does:
--   * only a workspace owner closes or reopens a workspace; nobody signed in edits a closure;
--   * only a workspace owner or admin deletes a Supabase connection (disconnect). Foreign-key
--     cascades bypass RLS, so this policy is the database guard on the projects a disconnect removes;
--   * nobody signed in deletes a tenant: only the purge job (no app.user_id) does.
-- A transaction without app.user_id (poller, data job, Stripe webhook) is not restricted, as before.
--
-- Production safety: additive only. A new table, a new role, new policies on tables the code before
-- this change never deletes from (connections, tenants), new grants. No column changes, no data
-- changes, no index on a large table. Safe to run twice.

BEGIN;

CREATE TABLE IF NOT EXISTS supahound.account_closures (
  tenant_id uuid PRIMARY KEY,
  closed_at timestamptz NOT NULL,
  closed_by uuid NOT NULL,
  purge_after timestamptz NOT NULL,
  purged_at timestamptz,
  -- Kept after the purge (decision 037). Copied from billing_accounts and scan_authorizations.
  stripe_customer_id text CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,64}$'),
  subscription_id text CHECK (subscription_id ~ '^sub_[A-Za-z0-9]{1,64}$'),
  terms_version text CHECK (length(terms_version) BETWEEN 1 AND 50),
  terms_accepted_at timestamptz,
  card_verified_at timestamptz,
  scan_consents jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(scan_consents) = 'array'),
  CHECK (purge_after > closed_at),
  CHECK (purged_at IS NULL OR purged_at >= closed_at)
);

ALTER TABLE supahound.account_closures ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.account_closures FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON supahound.account_closures;
CREATE POLICY tenant_isolation ON supahound.account_closures TO supahound_app
  USING (tenant_id = (SELECT supahound.current_tenant()))
  WITH CHECK (tenant_id = (SELECT supahound.current_tenant()));

DROP POLICY IF EXISTS closure_insert ON supahound.account_closures;
CREATE POLICY closure_insert ON supahound.account_closures AS RESTRICTIVE FOR INSERT TO supahound_app
  WITH CHECK ((SELECT supahound.current_user_id()) IS NULL OR (SELECT supahound.current_workspace_role()) = 'owner');

DROP POLICY IF EXISTS closure_update ON supahound.account_closures;
CREATE POLICY closure_update ON supahound.account_closures AS RESTRICTIVE FOR UPDATE TO supahound_app
  USING ((SELECT supahound.current_user_id()) IS NULL);

-- Reopen (owner, before the purge) or the end of the kept records (data job, after 7 years).
DROP POLICY IF EXISTS closure_delete ON supahound.account_closures;
CREATE POLICY closure_delete ON supahound.account_closures AS RESTRICTIVE FOR DELETE TO supahound_app
  USING (((SELECT supahound.current_user_id()) IS NULL OR (SELECT supahound.current_workspace_role()) = 'owner')
         AND (purged_at IS NULL OR purged_at < now() - interval '7 years'));

GRANT SELECT, INSERT, UPDATE, DELETE ON supahound.account_closures TO supahound_app;

-- The scheduler finds closed workspaces (to skip their projects) and purges that are due.
DROP POLICY IF EXISTS scheduler_read ON supahound.account_closures;
CREATE POLICY scheduler_read ON supahound.account_closures FOR SELECT TO supahound_scheduler USING (true);
GRANT SELECT (tenant_id, purge_after, purged_at) ON supahound.account_closures TO supahound_scheduler;

-- Disconnect: workspace owners and admins only.
DROP POLICY IF EXISTS connection_remove ON supahound.connections;
CREATE POLICY connection_remove ON supahound.connections AS RESTRICTIVE FOR DELETE TO supahound_app
  USING ((SELECT supahound.current_user_id()) IS NULL OR (SELECT supahound.current_workspace_role()) IN ('owner', 'admin'));

-- Purge: never from a signed-in request.
DROP POLICY IF EXISTS tenant_purge ON supahound.tenants;
CREATE POLICY tenant_purge ON supahound.tenants AS RESTRICTIVE FOR DELETE TO supahound_app
  USING ((SELECT supahound.current_user_id()) IS NULL);

-- Subprocessor notice: owners' addresses, across tenants, and no other row or column.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supahound_notifier') THEN
    CREATE ROLE supahound_notifier NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
GRANT USAGE ON SCHEMA supahound TO supahound_notifier;
DROP POLICY IF EXISTS notifier_read ON supahound.memberships;
CREATE POLICY notifier_read ON supahound.memberships FOR SELECT TO supahound_notifier USING (role = 'owner');
GRANT SELECT (tenant_id, role, email) ON supahound.memberships TO supahound_notifier;

COMMIT;
