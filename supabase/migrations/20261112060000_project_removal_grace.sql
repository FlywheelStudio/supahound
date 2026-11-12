-- Project removal with a grace period (decision 042).
--
-- Removing a project no longer deletes it at once. The project stays active (polled, alerts,
-- visible) until active_until: its subscription's period end, or the trial end during the trial,
-- or the removal time when nothing is paid. The daily data job deletes it at delete_after, 7 days
-- after active_until, unless an Owner or Admin keeps it first.
--
--   removal_requested_at  when the removal was scheduled; NULL = not scheduled
--   active_until          polling stops from this time (the scheduler and claimProject read it)
--   delete_after          the data job deletes the project from this time (= active_until + 7 days)
--   removal_source        'user' (removed in Supahound) or 'billing' (a Billing Portal cancel,
--                         seen by the Stripe webhook)
--
-- Who may schedule or undo: the rule for removing a project today (decision 036, policy
-- project_remove): a workspace owner or admin, or the project's Owner. The UPDATE policy
-- project_settings lets Editors update a project, and a policy cannot tell which columns change,
-- so a trigger refuses a change to these columns from anyone else.
--
-- Production safety: additive only. No statement removes or renames anything. Every new column
-- is nullable with no default, so no existing row changes. The constraint is added once, guarded
-- by pg_constraint; the function and trigger use CREATE OR REPLACE (Postgres 14 or later).

BEGIN;

ALTER TABLE supahound.projects
  ADD COLUMN IF NOT EXISTS removal_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS active_until timestamptz,
  ADD COLUMN IF NOT EXISTS delete_after timestamptz,
  ADD COLUMN IF NOT EXISTS removal_source text;

-- All four set, or none. delete_after is exactly 7 days after active_until (Erik, 2026-11-12).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'projects_removal_schedule' AND conrelid = 'supahound.projects'::regclass
  ) THEN
    ALTER TABLE supahound.projects ADD CONSTRAINT projects_removal_schedule CHECK (
      (removal_requested_at IS NULL AND active_until IS NULL AND delete_after IS NULL AND removal_source IS NULL)
      OR (removal_requested_at IS NOT NULL AND active_until IS NOT NULL AND delete_after IS NOT NULL
          AND removal_source IN ('user', 'billing')
          AND active_until >= removal_requested_at
          AND delete_after = active_until + interval '7 days')
    );
  END IF;
END
$$;

-- The data job finds the projects to delete, tenant by tenant.
CREATE INDEX IF NOT EXISTS projects_delete_after_idx
  ON supahound.projects (tenant_id, delete_after) WHERE delete_after IS NOT NULL;

-- Only the removal rule may change the four columns. A signed-in user who is not a workspace owner
-- or admin and not the project's Owner gets an error; a session with no user (the poller, the
-- webhook, the CLI) passes. SECURITY INVOKER: project_role reads through the caller's RLS.
CREATE OR REPLACE FUNCTION supahound.project_removal_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF (NEW.removal_requested_at, NEW.active_until, NEW.delete_after, NEW.removal_source)
       IS DISTINCT FROM (OLD.removal_requested_at, OLD.active_until, OLD.delete_after, OLD.removal_source)
     AND supahound.current_user_id() IS NOT NULL
     AND supahound.current_workspace_role() IS DISTINCT FROM 'owner'
     AND supahound.current_workspace_role() IS DISTINCT FROM 'admin'
     AND supahound.project_role(OLD.id) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'only a workspace owner or admin, or the project''s Owner, may schedule or undo a removal'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE TRIGGER project_removal_guard
  BEFORE UPDATE ON supahound.projects
  FOR EACH ROW EXECUTE FUNCTION supahound.project_removal_guard();

-- The scheduler skips projects whose active period has ended (decision 042).
GRANT SELECT (active_until) ON supahound.projects TO supahound_scheduler;

COMMIT;
