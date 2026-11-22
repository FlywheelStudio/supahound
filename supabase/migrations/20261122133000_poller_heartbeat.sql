-- Poller heartbeat and customer log gap (issue #133).
--
-- Staff heartbeat: the cron reads, through the scheduler role, when poll runs finished and
-- whether each could assess, across all tenants, to email staff when polling stops or mostly
-- fails. It gets two columns and nothing else: no tenant, project, window or error code, so the
-- only thing it can compute is an aggregate (decision 007: only aggregate patterns cross tenants).
--
-- Log gap: poll_runs.edge_requests holds the number of edge-log requests in the run's window
-- (the billing count query, decision 028, run over the poll window). NULL: not counted (an older
-- run, a failed count, or a deployment that does not count). The project page shows a log gap
-- when the newest counted windows are all zero after earlier traffic.
--
-- Additive only: a nullable column, a partial index, a policy and a column grant.

BEGIN;

ALTER TABLE supahound.poll_runs
  ADD COLUMN IF NOT EXISTS edge_requests bigint CHECK (edge_requests >= 0);

-- The heartbeat reads finished runs by time across every tenant, once a minute.
CREATE INDEX IF NOT EXISTS poll_runs_finished_idx ON supahound.poll_runs (finished_at) WHERE finished_at IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'supahound' AND tablename = 'poll_runs' AND policyname = 'scheduler_read') THEN
    CREATE POLICY scheduler_read ON supahound.poll_runs FOR SELECT TO supahound_scheduler USING (true);
  END IF;
END
$$;

GRANT SELECT (status, finished_at) ON supahound.poll_runs TO supahound_scheduler;

COMMIT;
