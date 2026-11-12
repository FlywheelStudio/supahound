# WIP: Posture scan V1 (#11)

Branch `feature/posture-scan`. Decision 038.

## Goal

Answer "am I exposed?" within 2 minutes of a project pick. Checks: Security Advisor findings,
tables without RLS, `USING (true)` / `WITH CHECK (true)` policies, views without
`security_invoker`. Runs on the first poll, daily, and on demand ("Scan now"). Posture findings
raise the severity of detections on the same table. Fix prompts come from templates and
structured evidence only.

## Approach

- One catalog SQL (`POSTURE_SQL`) on the read-only SQL endpoint that ownership already uses, and
  `GET /v1/projects/{ref}/advisors/security`. All endpoint and field knowledge in
  `packages/core/src/config/posture.ts`.
- The poll runs the scan after the token opens and before the logs query, when due: never
  attempted, 24 hours after a success, 1 hour after a failure, or a pending "Scan now".
- Two new tables: `posture_scans` (one row per project: request, attempt, per-source status) and
  `posture_findings` (the latest result per source). Forced RLS, `project_access`.
- Web: a Posture tab, a summary on the project dashboard and the workspace overview, Scan now
  for owners, admins and editors.

## Files expected to change

`packages/core/src/config/posture.ts`, `packages/core/src/posture/*`, `packages/core/src/db/posture.ts`,
`packages/core/src/poller/pollProject.ts`, `packages/core/src/explainer/features.ts`,
`packages/core/src/alerts/email.ts`, `apps/poller/src/index.ts`, `supabase/migrations/20261112020000_posture_scan.sql`,
`apps/web/lib/nav.ts`, `apps/web/lib/posture.ts`, the Posture page and action, the dashboard and overview,
the fake Management API, tests, docs.

## Build log

- 2026-11-12: Oriented. Advisor endpoint verified in the Management API reference: experimental,
  OAuth scope `database:read` (already granted), fine-grained permission `advisors_read`.
