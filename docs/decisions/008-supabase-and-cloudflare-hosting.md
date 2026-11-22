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

## Addendum: the web Worker has a cron (issue #159, 2026-11-22)

The web Worker now has a Cron Trigger (every minute) beside its fetch handler, and binds the
scheduler role's Hyperdrive config (`HYPERDRIVE_SCHEDULER`, the same config as the poller's). The
cron runs one check of the staff heartbeat (issue #133): no poll run has finished for 15 minutes.
The poller's cron cannot report its own death, so this check must run in a different Worker.

- **Entry.** `apps/web/worker/index.ts` passes requests to vinext's fetch handler unchanged and adds
  `scheduled`. vinext supports a custom `worker/index.ts` that imports `vinext/server/fetch-handler`.
- **One owner per check.** The web cron owns "stale"; the poller's cron owns "failing" (half the
  last hour's runs could not assess). Both use the stateless 6-hour slot throttle, and neither can
  see whether the other emailed, so if both ran both checks a stopped queue consumer would get two
  emails per slot. Splitting the checks keeps the heartbeat stateless. Rejected: a stored "last
  sent" row (a new table and a write path for the scheduler role, which only reads), and offset
  minutes or slots (they space the two emails out but still send both).
- **Scope.** The web Worker reads through the scheduler role only in the cron, and only aggregates
  (`poll_runs` status and finish time, due-project IDs). Requests still use only `HYPERDRIVE_APP`.
- **Limit.** If the web cron and polling stop together, nothing emails; an external check on the
  poller's `polls_enqueued` log line covers that (docs/self-hosting.md).
