# 033: People and roles per project

Date: 2026-11-11 · Issue #24 · Builds on 009 (auth) and 004 (tenant isolation)

## Context

Membership is per workspace today (owner, admin, member), and RLS isolates by tenant. Erik chose
on 2026-11-11 to give each project its own people and permissions, as PushFire and ULink do.

## Decision

1. Each project has members with one role: **Owner, Admin, Editor or Viewer** (PushFire's set).
2. People join a project by email invite with an accept link and an expiry.
3. RLS enforces project access, inside the tenant boundary: new tables carry `tenant_id`, forced
   RLS and a `(tenant_id, id)` foreign key, as every tenant table does.
4. The project's Settings → People page manages members and pending invites.

## Status

Accepted; not built. The People page is a Coming soon placeholder until #24 ships. Role rights,
invite expiry and how workspace roles map onto project roles are settled in #24 before the build.
