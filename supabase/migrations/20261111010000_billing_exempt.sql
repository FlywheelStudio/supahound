-- Staff workspaces without billing (issue #94, decision 029).
--
-- A workspace is exempt from billing while its only owner is exempt_owner. The web app sets
-- exempt_owner when that owner's verified email domain is on the deploy's exempt list
-- (SUPAHOUND_BILLING_EXEMPT_DOMAINS). The gate checks the sole-owner rule on every request
-- (packages/core/src/db/billing.ts). The trigger below also clears the columns when the owners
-- change, so the scheduler, which cannot read memberships, stops polling the workspace too.

BEGIN;

ALTER TABLE supahound.billing_accounts
  ADD COLUMN exempt_owner uuid,
  ADD COLUMN exempt_at timestamptz,
  ADD CONSTRAINT billing_accounts_exempt_pair CHECK ((exempt_owner IS NULL) = (exempt_at IS NULL));

GRANT SELECT (exempt_at) ON supahound.billing_accounts TO supahound_scheduler;

-- Runs as the caller, so RLS applies: membership writes run inside their tenant's transaction.
-- If RLS ever hid the row, the gate's own check still refuses the workspace.
CREATE FUNCTION supahound.end_stale_billing_exemption() RETURNS trigger
  LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  t uuid := COALESCE(NEW.tenant_id, OLD.tenant_id);
BEGIN
  UPDATE supahound.billing_accounts b
     SET exempt_owner = NULL, exempt_at = NULL, updated_at = now()
   WHERE b.tenant_id = t
     AND b.exempt_owner IS NOT NULL
     -- The owners, as a list, must be exactly [exempt_owner].
     AND (SELECT array_agg(m.user_id) FROM supahound.memberships m
           WHERE m.tenant_id = t AND m.role = 'owner') IS DISTINCT FROM ARRAY[b.exempt_owner];
  RETURN NULL;
END;
$$;

CREATE TRIGGER memberships_end_stale_billing_exemption
  AFTER INSERT OR UPDATE OR DELETE ON supahound.memberships
  FOR EACH ROW EXECUTE FUNCTION supahound.end_stale_billing_exemption();

COMMIT;
