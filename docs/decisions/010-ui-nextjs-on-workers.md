# 010: Web app is Next.js on Cloudflare Workers (vinext)

Date: 2026-10-27

## Decision

Next.js App Router, React, Tailwind, shadcn/ui (Flywheel SaaS convention), built with vinext and
deployed to Cloudflare Workers. UI and its server routes live in one app under `apps/web`.

## Alternatives considered

- React SPA plus a Hono API Worker: lighter, but breaks the Flywheel convention.
- OpenNext: Cloudflare's guide now defaults new projects to vinext.
