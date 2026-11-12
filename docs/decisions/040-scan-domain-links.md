# 040: Scan domains link to projects through a bridge table; scan data follows the link

Date: 2026-11-12 · Issue #100 · Builds 034; builds on 016 (scan funnel) and 036 (project roles)

## Context

Decision 034 lets a verified scan domain belong to one watched project, and gives the project a
**Security scan** tab. The scan funnel tables (`scan_domains`, `scan_authorizations`, `scans`,
`scan_findings`, `scan_jobs`, decision 016) are tenant-scoped, under forced RLS, with
`UNIQUE (tenant_id, id)` on every table, so a tenant-scoped foreign key can reach them. They had
only the `tenant_isolation` policy: any member of the workspace could read every domain and scan.
No code reads or writes them yet; the funnel (#51) will. The migration reaches production before
the new code, so the old code must keep working on the new schema. Erik approved the scope and
asked for the calls below to be made and recorded without a round trip.

## Decision

1. **A bridge table, not a column.** `scan_domain_links (tenant_id, domain_id, project_id,
   linked_by, linked_at)` with primary key `(tenant_id, domain_id)`: one project per domain.
   Foreign keys `(tenant_id, domain_id)` to `scan_domains` and `(tenant_id, project_id)` to
   `projects`, both `ON DELETE CASCADE`: removing the project or the domain removes the link, never
   the domain.
2. **Verified only, for every writer.** A `BEFORE INSERT` trigger refuses a domain the writer
   cannot see or that has no `verified_at`. It runs as the writer (SECURITY INVOKER), with no
   carve-out for the poller.
3. **Who links.** The project's Owners and Admins attach and detach (new `link_domains` row in the
   role matrix of decision 036). RLS refuses any other role: RESTRICTIVE INSERT and DELETE policies
   on `project_role(project_id)`. No UPDATE grant: a move is detach, then attach.
4. **Who sees the link.** The decision-036 `project_access` SELECT policy, as on every table with
   project data.
5. **Scan data follows the link.** A RESTRICTIVE SELECT policy `scan_link_access` on the five scan
   funnel tables: a signed-in user sees a domain and its scan rows as a workspace Owner or Admin,
   or when the domain is linked to a project they have a role on. **An unlinked domain is workspace
   data**, like an audit row with no project: workspace Owners and Admins only. So a project Admin
   who is a plain workspace member can detach a domain from their project, but cannot attach one:
   they never see the workspace's unlinked domains. Transactions without `app.user_id` (the poller,
   scan jobs) keep the whole tenant.
6. **Conflicts never leak.** The attach uses `ON CONFLICT DO NOTHING`. A domain linked elsewhere
   reads "attached to another project", and the page never names that project.
7. **The tab.** For each linked domain: the newest scan with status `done` and its findings, most
   severe first (at most 200), with severity, title, endpoint, allowlisted evidence and the fix. A
   newer scan that is queued, running or failed is named. The endpoint is text, never a link.
8. **Evidence on the page is an allowlist.** `evidenceItems` (`apps/web/lib/scanDomains.ts`) shows
   only known keys (rule, source, path, fingerprint, last 4 characters, counts, key names, project
   ref), each with a shape check. Any other key, or a value of the wrong shape, is dropped. The
   whole JSON is never shown, so a secret stored by a future writer cannot reach the page.
9. **No audit row.** `audit_log.action` has a CHECK list, and a new action would replace that
   constraint. The link row records `linked_by` and `linked_at` instead.

## Alternatives considered

- **A `project_id` column on `scan_domains`.** Rejected. With a composite foreign key,
  `ON DELETE SET NULL` also nulls `tenant_id`; the column-list form needs Postgres 15. It would also
  put the project rules on an existing funnel table.
- **Scan tables stay tenant-wide; the app filters through the link.** Rejected: any later query
  that skips the link would show one project's findings to people of another. RLS covers every
  query (decision 036's reasoning).
- **Unlinked domains visible to every workspace member, so a project Admin can attach.** Rejected:
  it shows every verified domain of the workspace to a person invited to one project. Linking a
  workspace asset into a project stays with the workspace's Owners and Admins in practice.
- **Unique constraint on the domain plus a plain INSERT.** Rejected: the unique violation tells a
  project Admin that a domain is linked somewhere they cannot see.

## Consequences

- Old code on the new schema: it never reads the scan tables, so the new SELECT policies change
  nothing it does. Develop's unchanged suites pass on the new schema, except the hard-coded table
  list in `isolation.test.ts`, which now also sees `scan_domain_links`, and the purge test's
  precondition in `dataControls.test.ts`, which expects every table to hold seeded rows (develop's
  seed has no link). The purge itself deletes projects, so links go by cascade.
- #51 (the funnel) must write domains and scans with a workspace Owner's or Admin's transaction,
  or without `app.user_id`. A plain member would not see an unlinked domain it just created.
- A detach leaves no record. If the audit log ever needs it, a later migration adds the action.
- Every later table that holds scan data per domain needs the `scan_link_access` policy.
