# WIP: Security scan domains per project

Issue #100 · Decision 034 (spec) · Decision 040 (how it is built) · Branch `feature/scan-domains`

## Goal

A verified scan domain belongs to at most one watched project. The project's **Security scan**
tab lists the latest finished scan's findings for the project's domains, with severity and the fix.
Owners and admins attach or detach a verified domain on Settings → General. Starting a scan from
the app stays in #51.

## Approach

- **Bridge table, not a column.** `supahound.scan_domain_links (tenant_id, domain_id, project_id,
  linked_by, linked_at)`, primary key `(tenant_id, domain_id)`: one project per domain. Both foreign
  keys are tenant-scoped and cascade. A new table is purely additive; a new column on
  `scan_domains` would need `ON DELETE SET NULL (project_id)` (Postgres 15+) and would put the
  project rules on an existing funnel table.
- **Verified only, for every writer.** A `BEFORE INSERT` trigger refuses a link to a domain the
  writer cannot see or that has no `verified_at`. It has no carve-out for the poller.
- **RLS.** `tenant_isolation`, the decision-036 `project_access` RESTRICTIVE SELECT, and RESTRICTIVE
  INSERT and DELETE for the project's owners and admins. No UPDATE grant: a move is detach, then
  attach.
- **Scan data follows the link.** A RESTRICTIVE SELECT `scan_link_access` on `scan_domains`,
  `scan_authorizations`, `scans`, `scan_findings` and `scan_jobs`: a signed-in user sees a domain
  and its scan rows when they are a workspace owner or admin, or when the domain is linked to a
  project they have a role on. Unlinked domains are workspace data, as audit rows without a project.
  Transactions without a user (poller, funnel jobs) keep the whole tenant.
- **Conflict without a leak.** `INSERT ... ON CONFLICT DO NOTHING`. The page says "linked to another
  project" and never names it.
- **Evidence.** The page shows a fixed allowlist of evidence keys, type-checked. The endpoint is
  text, never a link.

## Files expected to change

- `supabase/migrations/20261112030000_scan_domains_per_project.sql` (new)
- `packages/core/src/db/scanDomains.ts` (new), `packages/core/test/db/scanDomains.test.ts` (new),
  `packages/core/test/db/isolation.test.ts`
- `apps/web/lib/scanDomains.ts` (new), `apps/web/lib/people.ts`, `apps/web/lib/nav.ts`
- `apps/web/app/w/[tenantId]/p/[projectId]/findings/page.tsx`, `settings/page.tsx`, `settings/actions.ts`
- `apps/web/test/scanDomains.test.ts` (new), `apps/web/test/nav.test.ts`
- `apps/web/e2e/specs/scanDomains.uat.spec.ts` (new), `apps/web/e2e/specs/nav.uat.spec.ts`
- Docs: decision 040, decision 034 status, TESTING.md, STATE.md, INDEX.md, feature doc

## Build log

- 2026-11-12: Decision number 039 is held by `feature/ui-speed` (039-web-latency.md), so this
  feature uses 040. Migration timestamp 20261112030000 is free on every open branch.
- No code reads or writes the scan funnel tables yet (only `isolation.test.ts` seeds them), so the
  new SELECT policies on them change nothing for production code.
- `audit_log.action` has a CHECK list. A new action would need the constraint replaced, which is a
  DROP. The link row records `linked_by` and `linked_at` instead; a detach leaves no trace.

## Open questions

None. Calls made without Erik are listed in decision 040.
