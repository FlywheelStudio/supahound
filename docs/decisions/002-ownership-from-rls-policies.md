# 002: Ownership comes from RLS policies, per command

Date: 2026-10-27

## Context

Detector 2 alerts when a user filters an ownership column by another user's ID. A name rule
(`*_id`, `user_id`) turns `receiver_id=eq.B` on a messages table into a critical alert. A
table-wide rule fails too. The Supabase quickstart `profiles` table has SELECT `USING (true)` and
UPDATE `auth.uid() = id`. Merging those marks `id` as owned for reads, so viewing anyone's public
profile becomes a critical alert.

## Decision

Read `pg_policies` (read-only SQL, `database:read`) and build ownership per table **and per
command** (SELECT, UPDATE, DELETE). Map the request method to the command: GET/HEAD → SELECT,
PATCH/PUT → UPDATE, DELETE → DELETE. POST inserts rows, so it is skipped. Embedded resources are
reads.

A command is owner-scoped only when RLS lets no row through without an owner match:

- Every permissive policy for `authenticated`/`public` on it requires an owner match, or
- a restrictive policy requires one.

An expression requires an owner match when every top-level OR branch compares a column directly to
`auth.uid()` or `auth.jwt() ->> 'sub'`. Comparisons inside subqueries do not count. A command with
several owner columns (`sender_id OR receiver_id`) is multi-party: filtering by the other party is
normal once one owner column is pinned to the caller.

A hand-written `{table: [columns]}` file means owner-scoped for every command.

## Alternatives considered

- Column-name rule: simple, high false-positive rate.
- Table-wide union of policy columns: flags public-read tables (the quickstart case above).
- Ask the customer to declare ownership: accurate, but adds onboarding friction.

## Consequences

- Public-read tables raise no read alerts. Writes to them still do.
- Tables protected only by membership subqueries get no ownership, so detector 2 does not cover them.
