# Security scan domains per project

Issue #100. Decisions 034 (what) and 040 (how). Builds on 016 and 026 (scan funnel) and 036
(project roles).

## What it does

A verified scan domain belongs to at most one watched project. A project's Owners and Admins attach
or detach a domain on **Settings → General → Security scan domains**. The project's **Security
scan** tab lists, for each attached domain, the newest finished scan's findings, most severe first,
each with its severity, endpoint, structured evidence and the fix. With no domain attached, the tab
says how to attach one. Starting a scan from the app is #51; until then, scans come from the funnel.

## How it works

1. **Attach.** `linkDomainAction` (`apps/web/app/w/[tenantId]/p/[projectId]/settings/actions.ts`)
   parses the domain ID, then in one paid, project-scoped transaction (`paidProject`) checks
   `canLinkDomains(role)` (Owner, Admin) and calls `linkDomain` (`packages/core/src/db/scanDomains.ts`).
   `linkDomain` reads the domain through RLS (`unverified` when missing or not verified), inserts
   with `ON CONFLICT DO NOTHING`, and reports `linked`, `already` or `taken`. The action redirects
   to `settings?domain=<outcome>#scan-domains`.
2. **Detach.** `unlinkDomainAction` → `unlinkDomain`: deletes the link for this project only.
   `unlinked`, or `missing` when it was not attached here.
3. **The settings section** (`settings/page.tsx`) lists the project's domains (`listProjectDomains`)
   and, for Owners and Admins, the verified domains with no project (`listLinkableDomains`).
4. **The tab** (`findings/page.tsx`) calls `projectScanResults`: per linked domain, the newest scan
   with status `done` (lateral join on `scans_domain_idx`), the status of a newer unfinished scan,
   and up to 200 findings per scan ranked by severity. Text comes from `lib/scanDomains.ts`:
   `scanStateText`, `findingCountsText`, `findingTitle` (the rule name when it is plain text, else
   the type) and `evidenceItems` (the evidence allowlist).

## Data model and RLS

Migration `supabase/migrations/20261112030000_scan_domains_per_project.sql` (additive, no DROP):

| Object | What |
| --- | --- |
| `scan_domain_links` | `tenant_id`, `domain_id`, `project_id`, `linked_by`, `linked_at`. Primary key `(tenant_id, domain_id)`. FKs to `scan_domains (tenant_id, id)` and `projects (tenant_id, id)`, both cascade. Index `(tenant_id, project_id)` |
| Trigger `scan_link_requires_verified` | `BEFORE INSERT`: refuses a domain the writer cannot see or that has no `verified_at`, for every writer |
| Policies on `scan_domain_links` | `tenant_isolation`; `project_access` (RESTRICTIVE SELECT, decision 036); `scan_link_insert` and `scan_link_delete` (RESTRICTIVE: no user, or Owner/Admin on the project). Grants: SELECT, INSERT, DELETE (no UPDATE) |
| `scan_link_access` on `scan_domains`, `scan_authorizations`, `scans`, `scan_findings`, `scan_jobs` | RESTRICTIVE SELECT: no user, or workspace Owner/Admin, or the domain is linked to a project the user has a role on |

Who sees what (signed in):

| Person | Unlinked domains | A domain linked to project P, and its scans |
| --- | --- | --- |
| Workspace Owner or Admin | Yes | Yes |
| Owner, Admin, Editor or Viewer on P (workspace member) | No | Yes |
| Workspace member with no role on P | No | No |
| Another workspace | No | No |

## External services

None. The scan funnel writes the domains and scans; this feature only reads them and writes links.

## Testing

- Postgres: `packages/core/test/db/scanDomains.test.ts` (15). Link, `already`, `taken`, the primary
  key, unverified refused for users and the poller, cross-tenant domain and project refused, RLS
  refuses editors and viewers (and passes a project Admin), unlinked domains hidden from members,
  reads for the project's people, a member with no role and another tenant, the latest finished
  scan, detach rules, project removal, no UPDATE grant. `isolation.test.ts` covers the new table.
- Web unit: `apps/web/test/scanDomains.test.ts` (12). Role rule, outcomes, malformed IDs, notices,
  tab text, the evidence allowlist with a planted secret.
- UAT: UAT-W34 to UAT-W36 (`apps/web/e2e/specs/scanDomains.uat.spec.ts`), see `docs/TESTING.md`.
- Mutation checks: `docs/TESTING.md`, rows marked #100.

## Gotchas

- **Unlinked domains are workspace data.** A project Admin who is a plain workspace member can
  detach but cannot attach: RLS hides the workspace's unlinked domains from them, and the trigger
  then refuses the insert. Tested ("shows unlinked domains to workspace owners and admins only").
- **A BEFORE trigger runs before RLS's WITH CHECK.** A viewer inserting an unlinked domain hits the
  trigger first. The RLS insert test uses a domain the viewer can see (already linked), so RLS
  decides. Tested ("refuses editors and viewers in RLS").
- **`ON CONFLICT DO NOTHING`, not a plain insert.** A unique violation would tell a project Admin
  that a domain is linked to a project they cannot see. Tested ("links a domain to one project at most").
- **Evidence is shown through an allowlist only.** A future writer could store anything in the
  JSON. Tested with a planted secret in unit tests and in UAT-W34.
- **The funnel (#51) must write as a workspace Owner or Admin, or with no user.** A member's
  `INSERT ... RETURNING` on `scan_domains` would fail the SELECT policy.
- **No audit row on attach or detach** (decision 040, item 9).
