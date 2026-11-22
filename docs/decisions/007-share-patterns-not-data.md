# 007: Share patterns across tenants, never data

Date: 2026-10-27 · Supersedes [006](006-no-cross-tenant-learning.md)

## Context

Erik: "we can share patterns, but no data." Behavioral detectors (V2) need cold-start priors.

## Decision

A **pattern** may cross tenants only if all of these hold:

- It is an aggregate count or distribution over Supahound's own enum classes (signal, caller class,
  network type, HTTP method, outcome, hour of week, severity).
- It holds no table, column, schema, project, actor, IP, ASN-to-tenant link, query value or text.
- It carries no per-tenant attribution, and is published only when at least 10 tenants contribute.
- It is computed by a job that reads through `withTenant` one tenant at a time and writes only
  the aggregate to a separate table with no `tenant_id`.

Everything else stays inside its tenant.

## Consequences

- Nothing is built yet. The aggregation job needs its own decision record with the exact fields.
- The PRD's "fleet priors" line is allowed under these limits. Erik decides whether to edit it.

## Addendum: poller heartbeat reads poll runs across tenants (issue #133, 2026-11-22)

The staff heartbeat (#133) emails staff when polling stops or mostly fails. To see that, the
scheduler role (`supahound_scheduler`) reads `poll_runs` across every tenant
(`supabase/migrations/20261122133000_poller_heartbeat.sql`). This is allowed under this decision
because what it can read and what it produces are aggregates only:

- **Two columns.** A column grant gives it `poll_runs (status, finished_at)` and nothing else: no
  `tenant_id`, project, window, error code or count. The `scheduler_read` policy opens the rows;
  the grant limits what a row shows. A wider read fails with a permission error
  (`packages/core/test/db/isolation.test.ts`).
- **Aggregate output.** `pollHealth` (`packages/core/src/db/heartbeat.ts`) returns finished runs
  and `unable_to_assess` runs per minute, and the newest finish time. Status is Supahound's own
  enum; nothing in the output names or can be linked to a tenant.
- **Staff only.** The result goes to the staff alert email and is never shown to a tenant or
  stored. It is an operational health signal, not a pattern a detector learns from, so the
  10-tenant floor and the separate aggregate table (both for published patterns) do not apply.
  The per-tenant `withTenant` read is replaced by the column grant, which gives the same guarantee
  in the database: the role cannot see any tenant's data.

Any wider cross-tenant read by the scheduler role (another column, another table) needs its own
addendum or decision record.
