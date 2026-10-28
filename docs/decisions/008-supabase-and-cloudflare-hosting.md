# 008: Supahound runs on Cloudflare, with its database on Supabase

Date: 2026-10-27 · Supersedes the runtime part of [001](001-typescript-node-worker.md)

## Context

Erik: Supabase hosts and runs the project's data; everything else runs on Cloudflare.

## Decision

- Postgres: a Supabase project, schema `supahound`, kept OFF the Data API exposed-schemas list.
  All reads and writes go through Workers with the `supahound_app` and `supahound_scheduler` roles.
- Workers reach Postgres through Hyperdrive, one config per role, pointed at Supabase's direct or
  session connection (not the transaction pooler). **Hyperdrive query caching is disabled on every
  config**: RLS results depend on a session setting, so a cache keyed on SQL text could serve one
  tenant's rows to another.
- Poller: a Worker. A Cron Trigger runs the scheduler and the stuck-run sweep and sends one Queue
  message per project scope; the queue consumer runs one poll. Failed messages go to a dead-letter
  queue.
- Web app, email and every other service: Cloudflare.
- Model calls stay on Vercel AI Gateway (decision 005, 011); that is where ZDR is enforced.
- Core code runs on Node (tests, CLI) and workerd: WebCrypto, no `process.env` defaults, no
  `node:fs` outside the CLI.

## Consequences

- Deploys need Erik's Cloudflare account and Supabase project. Production deploys need approval.
