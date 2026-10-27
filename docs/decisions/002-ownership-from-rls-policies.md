# 002: Ownership columns come from RLS policies, not column names

Date: 2026-10-27

## Context

Detector 2 alerts when a user filters an ownership column by another user's ID. A name rule
(`*_id`, `user_id`) turns `receiver_id=eq.B` on a messages table into a critical alert.

## Decision

Read `pg_policies` (read-only SQL, `database:read`) and take the columns each policy compares
directly to `auth.uid()` or `auth.jwt() ->> 'sub'`. Skip comparisons inside subqueries. A table
with several owner columns is "multi-party": filtering by the other party is normal once one owner
column is pinned to the caller.

## Alternatives considered

- Column-name heuristic: simple, high false-positive rate.
- Ask the customer to declare ownership: accurate, but adds onboarding friction.

## Consequences

Tables protected only by membership subqueries get no ownership columns, so detector 2 does not
cover them. A static `{table: [columns]}` file overrides policy parsing for the prototype.
