-- One Stripe subscription per watched project (issue #99, decisions 032 and 041).
--
-- billing_accounts.billing_model: "workspace" (one subscription with Starter and Pro seats,
--   decision 028) or "project" (one subscription per project). Existing rows and rows that older
--   code inserts get "workspace", so the code before this change keeps working unchanged. New code
--   sets "project" when a card passes the check, and the conversion CLI sets it when it moves a
--   workspace off its seat subscription.
-- project_subscriptions: one row per Stripe subscription of a project. It is payment history
--   (decision 037): the app never deletes a row. When the project is removed or purged, the row
--   loses its project link (ON DELETE SET NULL on project_id only, as audit_log does since
--   20261109000000) and keeps supabase_ref, so re-adding the same project within the paid
--   period resumes that subscription instead of charging twice.
--
-- Production safety: additive only. No statement removes or renames anything, and no existing
-- row changes except the new column's default. Policies are created once, guarded by pg_policies.

BEGIN;

ALTER TABLE supahound.billing_accounts
  ADD COLUMN IF NOT EXISTS billing_model text NOT NULL DEFAULT 'workspace'
    CHECK (billing_model IN ('workspace', 'project'));

CREATE TABLE IF NOT EXISTS supahound.project_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES supahound.tenants (id) ON DELETE CASCADE,
  -- NULL after the project is removed: the row stays as payment history.
  project_id uuid,
  supabase_ref text NOT NULL CHECK (supabase_ref ~ '^[a-z0-9]{20}$'),
  subscription_id text NOT NULL UNIQUE CHECK (subscription_id ~ '^sub_[A-Za-z0-9]{1,64}$'),
  tier text NOT NULL CHECK (tier IN ('starter', 'pro')),
  status text NOT NULL
    CHECK (status IN ('incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due', 'canceled', 'unpaid', 'paused')),
  trial_end timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, project_id) REFERENCES supahound.projects (tenant_id, id) ON DELETE SET NULL (project_id)
);

-- At most one live subscription per project: the database refuses a second one.
CREATE UNIQUE INDEX IF NOT EXISTS project_subscriptions_one_live
  ON supahound.project_subscriptions (tenant_id, project_id)
  WHERE project_id IS NOT NULL AND status NOT IN ('canceled', 'incomplete_expired');
CREATE INDEX IF NOT EXISTS project_subscriptions_ref
  ON supahound.project_subscriptions (tenant_id, supabase_ref);

ALTER TABLE supahound.project_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.project_subscriptions FORCE ROW LEVEL SECURITY;

-- Policies: each created once. CREATE POLICY has no IF NOT EXISTS, so check pg_policies.
--   tenant_isolation: the tenant's rows only.
--   project_access (decision 036): a signed-in user sees a row only with a role on its project;
--     rows without a project (removed projects) are for workspace owners and admins.
--   subscription_insert / subscription_update: no signed-in user (billing sync, webhook, CLI) or
--     a workspace owner or admin. Nobody deletes a row: there is no DELETE grant.
DO $$
DECLARE
  p record;
BEGIN
  FOR p IN SELECT * FROM (VALUES
    ('project_subscriptions', 'tenant_isolation',
     'CREATE POLICY tenant_isolation ON supahound.project_subscriptions TO supahound_app
        USING (tenant_id = (SELECT supahound.current_tenant()))
        WITH CHECK (tenant_id = (SELECT supahound.current_tenant()))'),
    ('project_subscriptions', 'project_access',
     'CREATE POLICY project_access ON supahound.project_subscriptions AS RESTRICTIVE FOR SELECT TO supahound_app
        USING ((SELECT supahound.current_user_id()) IS NULL
               OR (SELECT supahound.current_workspace_role()) IN (''owner'', ''admin'')
               OR project_id IN (SELECT pm.project_id FROM supahound.project_members pm
                                 WHERE pm.tenant_id = (SELECT supahound.current_tenant())
                                   AND pm.user_id = (SELECT supahound.current_user_id())))'),
    ('project_subscriptions', 'subscription_insert',
     'CREATE POLICY subscription_insert ON supahound.project_subscriptions AS RESTRICTIVE FOR INSERT TO supahound_app
        WITH CHECK ((SELECT supahound.current_user_id()) IS NULL OR (SELECT supahound.current_workspace_role()) IN (''owner'', ''admin''))'),
    ('project_subscriptions', 'subscription_update',
     'CREATE POLICY subscription_update ON supahound.project_subscriptions AS RESTRICTIVE FOR UPDATE TO supahound_app
        USING ((SELECT supahound.current_user_id()) IS NULL OR (SELECT supahound.current_workspace_role()) IN (''owner'', ''admin''))')
  ) AS t(tbl, name, ddl)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'supahound' AND tablename = p.tbl AND policyname = p.name) THEN
      EXECUTE p.ddl;
    END IF;
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE ON supahound.project_subscriptions TO supahound_app;

COMMIT;
