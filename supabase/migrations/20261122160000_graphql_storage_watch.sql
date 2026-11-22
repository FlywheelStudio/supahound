-- GraphQL call counts and the Storage listing detector (issue #157).
--
-- GraphQL: each poll counts the window's /graphql/v1 calls made with the anon role and with the
-- authenticated role (pollCountSql: counts only, never a log row) and stores them on its run.
-- NULL: not counted (an older run, a failed count, or a deployment that does not count). The
-- Posture page shows the GraphQL posture findings for a role only when the last 7 days of runs
-- counted calls from it (decision 038, addendum of #157).
--
-- findings.detector gains storage_listing (detector 13): anon calls to Storage's list endpoint.
--
-- Production safety: two nullable columns on an existing table that already has tenant_id,
-- forced RLS and its (tenant_id, id) keys, so no policy or grant changes. The detector list only
-- grows, so every existing row still passes; one ALTER TABLE swaps the constraint.

BEGIN;

ALTER TABLE supahound.poll_runs
  ADD COLUMN IF NOT EXISTS graphql_anon_calls bigint CHECK (graphql_anon_calls >= 0),
  ADD COLUMN IF NOT EXISTS graphql_authenticated_calls bigint CHECK (graphql_authenticated_calls >= 0);

ALTER TABLE supahound.findings
  DROP CONSTRAINT IF EXISTS findings_detector_check,
  ADD CONSTRAINT findings_detector_check
    CHECK (detector IN ('cross_tenant', 'service_role_misuse', 'exposed_read', 'rpc_exposure', 'storage_listing'));

COMMIT;
