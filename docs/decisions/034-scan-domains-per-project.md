# 034: Scanned domains belong to a project

Date: 2026-11-11 · Issue #100 · Builds on 016 and 026 (scan funnel)

## Context

hack.me (hackme.si) scan findings hang off verified domains, not Supabase projects. Erik asked
for a hack.me findings tab on each project and chose on 2026-11-11 to link domains to projects.

## Decision

1. A migration lets a verified scan domain belong to one watched project, through a tenant-scoped
   foreign key under forced RLS.
2. The project's hack.me findings tab lists the latest findings for that project's domains.
3. Starting a scan from the app stays in #51.

## Status

Accepted; not built. The tab is a Coming soon placeholder until #100 ships.
