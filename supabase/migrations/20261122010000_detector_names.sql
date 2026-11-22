-- New detector names (issues #131 and #132).
--
-- findings.detector was limited to the first two detectors. This widens the list to the
-- baseline-free detectors added since:
--   exposed_read   anon-key reads of a table the posture scan shows readable by anon (#132)
--   rpc_exposure   anon calls to a SECURITY DEFINER function anon can execute (#131)
--
-- Both PRs carry this file with identical content, so whichever merges first adds it and the
-- other merges cleanly. Re-running it is harmless (DROP ... IF EXISTS, then the same list).
--
-- Production safety: the list only grows, so every existing row still passes. One ALTER TABLE
-- statement swaps the constraint, so there is no moment without it. Nothing else changes.

BEGIN;

ALTER TABLE supahound.findings
  DROP CONSTRAINT IF EXISTS findings_detector_check,
  ADD CONSTRAINT findings_detector_check
    CHECK (detector IN ('cross_tenant', 'service_role_misuse', 'exposed_read', 'rpc_exposure'));

COMMIT;
