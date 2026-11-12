-- Incident alert email (issue #16, decision 030).
--
-- memberships.email: where a member's alerts go. The web app copies it from the verified JWT
--   (getClaims) inside the tenant transaction; nothing else writes it. No new policy: the existing
--   tenant_isolation policy covers the write, so a member can never reach another tenant's row.
-- projects.email_alerts: the lowest severity that emails, or 'off'. Default 'low': every incident.
-- incidents.alerted_severity: the severity the last alert email went out at. The incident row is
--   the outbox: an open incident at or above the project's threshold whose alerted_severity is
--   null or lower is pending. A failed send stays pending; an escalation becomes pending again.

BEGIN;

ALTER TABLE supahound.memberships
  ADD COLUMN email text CHECK (length(email) BETWEEN 3 AND 320 AND email ~ '^[^\s@<>,;"]+@[^\s@<>,;"]+$');

ALTER TABLE supahound.projects
  ADD COLUMN email_alerts text NOT NULL DEFAULT 'low'
    CHECK (email_alerts IN ('low', 'medium', 'high', 'critical', 'off'));

ALTER TABLE supahound.incidents
  ADD COLUMN alerted_severity text CHECK (alerted_severity IN ('critical', 'high', 'medium', 'low'));

-- Incidents already open when this ships do not email: only new incidents and escalations do.
UPDATE supahound.incidents SET alerted_severity = severity WHERE status = 'open';

ALTER TABLE supahound.audit_log DROP CONSTRAINT audit_log_action_check;
ALTER TABLE supahound.audit_log ADD CONSTRAINT audit_log_action_check
  CHECK (action IN ('logs_query', 'policies_query', 'model_call', 'alert_email'));

-- On Supabase, copy existing members' addresses from Auth. The test Postgres has no auth schema.
DO $$
BEGIN
  IF to_regclass('auth.users') IS NOT NULL THEN
    UPDATE supahound.memberships m SET email = u.email
    FROM auth.users u
    WHERE u.id = m.user_id AND m.email IS NULL
      AND length(u.email) BETWEEN 3 AND 320 AND u.email ~ '^[^\s@<>,;"]+@[^\s@<>,;"]+$';
  END IF;
END
$$;

COMMIT;
