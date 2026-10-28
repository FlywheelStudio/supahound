-- Users and tenants (decision 009).
--
-- A user (Supabase Auth, auth.users.id) belongs to tenants through memberships. The web app sets
-- app.user_id only from a verified JWT, and app.tenant_id only after confirming membership in
-- the same transaction (withTenantForUser). No foreign key to auth.users, so the schema also runs
-- on a plain Postgres for tests; account deletion removes memberships in app code.

BEGIN;

CREATE FUNCTION supahound.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
REVOKE ALL ON FUNCTION supahound.current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION supahound.current_user_id() TO supahound_app;

CREATE TABLE supahound.memberships (
  tenant_id uuid NOT NULL REFERENCES supahound.tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON supahound.memberships (user_id);

ALTER TABLE supahound.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.memberships FORCE ROW LEVEL SECURITY;

-- Inside a tenant: that tenant's members.
CREATE POLICY tenant_isolation ON supahound.memberships TO supahound_app
  USING (tenant_id = (SELECT supahound.current_tenant()))
  WITH CHECK (tenant_id = (SELECT supahound.current_tenant()));

-- Outside a tenant: a signed-in user sees their own memberships, to pick a workspace.
CREATE POLICY own_memberships ON supahound.memberships FOR SELECT TO supahound_app
  USING (user_id = (SELECT supahound.current_user_id()));

-- A signed-in user sees the names of tenants they belong to (workspace switcher). Nothing else
-- about those tenants is readable without entering one.
CREATE POLICY member_tenants ON supahound.tenants FOR SELECT TO supahound_app
  USING (id IN (SELECT m.tenant_id FROM supahound.memberships m WHERE m.user_id = (SELECT supahound.current_user_id())));

GRANT SELECT, INSERT, UPDATE, DELETE ON supahound.memberships TO supahound_app;

COMMIT;
