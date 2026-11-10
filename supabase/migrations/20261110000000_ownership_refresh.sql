-- Ownership refresh (issue #10, decision 024).
--
-- projects.ownership defaults to '{}', so "never loaded" looked the same as "loaded, no owner
-- tables", and detector 2 then read as clean. These columns tell the two apart:
--   * ownership_refreshed_at: the last successful read of the project's RLS policies. NULL means
--     never loaded, and detector 2 cannot assess the project.
--   * ownership_attempted_at: the last attempt, success or failure. The poller uses it to retry a
--     failure after an hour instead of on every poll.
--   * ownership_error: the error code of the last attempt, NULL after a success.
-- poll_runs.unassessed_detectors lists the detectors a successful run could not check.
--
-- Additive only: nullable columns and a column with a constant default. No table rewrite.

ALTER TABLE supahound.projects
  ADD COLUMN ownership_refreshed_at timestamptz,
  ADD COLUMN ownership_attempted_at timestamptz,
  ADD COLUMN ownership_error text CHECK (ownership_error ~ '^[a-z_]{1,64}$');

ALTER TABLE supahound.poll_runs
  ADD COLUMN unassessed_detectors text[] NOT NULL DEFAULT '{}'
    CHECK (unassessed_detectors <@ ARRAY['cross_tenant', 'service_role_misuse']::text[]);
