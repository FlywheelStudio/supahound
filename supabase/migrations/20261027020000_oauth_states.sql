-- Supabase OAuth connect (decision 012).
--
-- One row per "Connect Supabase" click. Only a hash of the state is stored. The row binds the
-- flow to the user and tenant that started it; the callback consumes it once, inside
-- withTenantForUser, so a state started by someone else (or for another tenant) is useless.

BEGIN;

CREATE TABLE supahound.oauth_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES supahound.tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  state_hash text NOT NULL UNIQUE CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  -- PKCE verifier: single-use, useless without the authorization code, gone after 10 minutes.
  code_verifier text NOT NULL CHECK (length(code_verifier) BETWEEN 43 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX oauth_states_tenant_idx ON supahound.oauth_states (tenant_id, created_at DESC);

ALTER TABLE supahound.oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE supahound.oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON supahound.oauth_states TO supahound_app
  USING (tenant_id = (SELECT supahound.current_tenant()))
  WITH CHECK (tenant_id = (SELECT supahound.current_tenant()));

GRANT SELECT, INSERT, UPDATE, DELETE ON supahound.oauth_states TO supahound_app;

COMMIT;
