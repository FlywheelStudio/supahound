# 001: TypeScript on Node.js 22+, no framework

> Runtime superseded by [008](008-supabase-and-cloudflare-hosting.md): Cloudflare Workers, not Hetzner/Coolify. TypeScript and pnpm stand.

Date: 2026-10-27

## Context

The PRD names AI SDK 7 (Node.js 22, ESM only) and the existing Hetzner + Coolify stack. Detection is
a polling worker, not a web app.

## Decision

Plain TypeScript, ESM, `engines: node >=22`, pnpm. Vitest for tests, ESLint for lint, tsx to run.
No web framework until the dashboard work starts.

## Alternatives considered

- Next.js (Flywheel's SaaS default): adds a server the worker does not need.
- Cloudflare Workers: 1-minute polling of 1,000 projects fits, but AI SDK 7 and Coolify point to Node.

## Consequences

The dashboard, when built, either joins this repo as a separate app or lives elsewhere. Decide then.
