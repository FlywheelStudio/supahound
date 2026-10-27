# 007: Share patterns across tenants, never data

Date: 2026-10-27 · Supersedes [006](006-no-cross-tenant-learning.md)

## Context

Erik: "we can share patterns, but no data." Behavioral detectors (V2) need cold-start priors.

## Decision

A **pattern** may cross tenants only if all of these hold:

- It is an aggregate count or distribution over Guardbase's own enum classes (signal, caller class,
  network type, HTTP method, outcome, hour of week, severity).
- It holds no table, column, schema, project, actor, IP, ASN-to-tenant link, query value or text.
- It carries no per-tenant attribution, and is published only when at least 10 tenants contribute.
- It is computed by a job that reads through `withTenant` one tenant at a time and writes only
  the aggregate to a separate table with no `tenant_id`.

Everything else stays inside its tenant.

## Consequences

- Nothing is built yet. The aggregation job needs its own decision record with the exact fields.
- The PRD's "fleet priors" line is allowed under these limits. Erik decides whether to edit it.
