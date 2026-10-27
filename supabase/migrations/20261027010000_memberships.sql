-- Users and tenants (decision 009).
--
-- A user (Supabase Auth, auth.users.id) belongs to tenants through memberships. The web app sets
-- app.user_id only from a verified JWT, and app.tenant_id only after confirming membership in
-- the same transaction (withTenantForUser). No foreign key to auth.users, so the schema also runs
-- on a plain Postgres for tests; account deletion removes memberships in app code.

BEGIN;

CREATE FUNCTION guardbase.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION guardbase.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION guardbase.current_user_id() TO guardbase_app;

CREATE TABLE guardbase.memberships (
  tenant_id uuid NOT NULL REFERENCES guardbase.tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON guardbase.memberships (user_id);

ALTER TABLE guardbase.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardbase.memberships FORCE ROW LEVEL SECURITY;

-- Inside a tenant: that tenant's members.
CREATE POLICY tenant_isolation ON guardbase.memberships TO guardbase_app
  USING (tenant_id = (SELECT guardbase.current_tenant()))
  WITH CHECK (tenant_id = (SELECT guardbase.current_tenant()));

-- Outside a tenant: a signed-in user sees their own memberships, to pick a workspace.
CREATE POLICY own_memberships ON guardbase.memberships FOR SELECT TO guardbase_app
  USING (user_id = (SELECT guardbase.current_user_id()));

-- A signed-in user sees the names of tenants they belong to (workspace switcher). Nothing else
-- about those tenants is readable without entering one.
CREATE POLICY member_tenants ON guardbase.tenants FOR SELECT TO guardbase_app
  USING (id IN (SELECT m.tenant_id FROM guardbase.memberships m WHERE m.user_id = (SELECT guardbase.current_user_id())));

GRANT SELECT, INSERT, UPDATE, DELETE ON guardbase.memberships TO guardbase_app;

COMMIT;
