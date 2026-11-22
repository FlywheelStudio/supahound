# 047: Supahound's own Workers logs go to R2 for 90 days, through a tail Worker that keeps only Supahound's events

Builds on [008](008-supabase-and-cloudflare-hosting.md) (everything on Cloudflare).

Date: 2026-11-22 · Issue #144

## Context

ASVS 16.4.3 asks for logs to be shipped to a logically separate system. Workers Logs keeps the web
and poller Workers' logs for 7 days (Workers Paid), so a poller crash or a webhook signature
failure from two weeks ago cannot be investigated. ASVS 16.1.1 asks for an inventory of what is
logged, where, and for how long.

Erik decided on 2026-11-22 to keep these logs in Cloudflare R2 for 90 days, for every customer, as
an internal cost. The logs must stay free of personal data. Longer customer-facing history for
Enterprise is a separate issue.

Cloudflare offers two ways to ship Workers logs to R2, both on Workers Paid:

- **Workers Logpush** (`"logpush": true` in each `wrangler.jsonc`, plus a Logpush job for the
  `workers_trace_events` dataset). No code. But the job ships every console line and exception
  message of the invocation as Cloudflare captured it, including anything a framework or library
  prints, such as a render error with its message. Field selection works on whole fields
  (`Logs`, `Exceptions`, `Event`), not on what is inside them. The job is created through the API
  or the dashboard, not Wrangler, and its R2 destination embeds an R2 access key pair.
- **A tail Worker.** About 150 lines. It receives each invocation's trace item, can drop or scrub
  anything before writing, and writes through an R2 binding, so no access key exists.

## Decision

1. **A tail Worker, `apps/log-sink` (`supahound-log-sink`).** `apps/web/wrangler.jsonc` and
   `apps/poller/wrangler.jsonc` name it in `tail_consumers`. It has no fetch handler, no route and
   `workers_dev: false`; only the tail calls it. Chosen over Logpush because it can guarantee the
   no-personal-data rule at the sink, and needs no R2 access key.
2. **Bucket `supahound-logs`, private, 90-day expiry.** A lifecycle rule
   (`wrangler r2 bucket lifecycle add supahound-logs expire-90-days --expire-days 90`) deletes
   objects 90 days after upload. No `r2.dev` URL and no custom domain. Only Flywheel staff with R2
   access in the Cloudflare account can read it. No account ID, bucket credential or key is in
   this repo.
3. **What is written.** One NDJSON object per tail call, keyed
   `logs/YYYY/MM/DD/HH/<ms>-<uuid>.ndjson` (UTC), one line per invocation worth keeping: one that
   logged a Supahound event, threw, ended other than `ok`, or answered 5xx. Quiet, healthy
   invocations are not written, which keeps R2 writes near the number of events. A line holds the
   time, Worker, trigger, outcome, CPU and wall time; for a request the method, a scrubbed path
   (no query string; a segment that is not a plain word or a UUID becomes `:x`) and the status;
   for a cron its schedule; for a queue its name and batch size; the Supahound events; exception
   names with only the plain words of their messages (anything with a digit, `@`, `/`, `=` or
   similar becomes `_`); and a count of other console lines, which are dropped. Never request
   headers, bodies, query strings or the `cf` object (client IP and location).
4. **One logger, `opsLog`** (`packages/core/src/logging/opsLog.ts`). Every log line in `apps/` and
   `packages/core/src` goes through it. `OPS_EVENTS` lists each event, its Workers and its
   fields; each field has a kind (UUID, lowercase word, Stripe event ID, number, boolean). The
   types reject an unknown event or field at compile time; at run time a field the event does
   not list, or a value that fails its kind, is left out and counted in `dropped`. The sink
   re-checks every event line with the same function, so a line that skipped `opsLog` still
   cannot carry an email, IP, user agent, token or query string.
5. **Guards.** `packages/core/test/opsLog.test.ts` fails if any other source file in `apps/` or
   `packages/core/src` calls `console`, if a value of the forbidden kinds survives `opsLog`, or if
   an event is missing from the log inventory in `docs/ARCHITECTURE.md`.
   `apps/log-sink/test/sink.test.ts` checks the stored text for headers, query values, IPs,
   emails, user agents and tokens.
6. **Two new events** for what the issue names: `stripe_webhook_rejected` (missing or invalid
   signature) and `email_hook_rejected` (malformed payload, unsupported type, send failure), with
   a reason enum only. A bad Send Email Hook signature stays the `security_event` of decision 044.
   `logSecurityEvent` (decision 044) now writes through `opsLog` as the `security_event` event,
   so its lines reach R2 under the same checks.
7. **The inventory** (ASVS 16.1.1) is the "Log inventory" section of `docs/ARCHITECTURE.md`:
   every event, its Worker, fields, destination and retention.
8. **Self-hosters may skip it.** `docs/self-hosting.md` has the optional steps, or says to delete
   `tail_consumers` from both configs.

## Setup in Flywheel's Cloudflare account (Erik)

Logged in with `wrangler login` to the production account, from a clone of this repo:

```bash
cd apps/log-sink
pnpm exec wrangler r2 bucket create supahound-logs
pnpm exec wrangler r2 bucket lifecycle add supahound-logs expire-90-days --expire-days 90 --force
pnpm exec wrangler r2 bucket lifecycle list supahound-logs      # expect: expire-90-days, 90 days
pnpm exec wrangler deploy                                       # supahound-log-sink, before web and poller
```

Then add the `tail_consumers` entry to the private production configs of the web and poller
Workers (decision 027) and deploy both as usual. Check in the dashboard (R2 → `supahound-logs` →
Settings) that public access and custom domains are off. Within a minute of the poller's next
cron, `logs/<today>/<hour>/` holds an object with a `polls_enqueued` line.

## Alternatives considered

- **Workers Logpush to R2.** Less code, but it ships framework console output and raw exception
  text unfiltered, and its job carries an R2 access key. Rejected for the personal-data rule.
- **OpenTelemetry export** (Cloudflare's current recommendation for new log pipelines). Needs an
  OTLP collector, which would be a new service (CLAUDE.md: never add one without asking).
- **Workers Analytics Engine.** Built for metrics, not for reading event lines back.
- **Writing logs to Supahound's Postgres.** Not a logically separate system, and every log line
  would cost a database round trip.

## Consequences

- Workers Logs keeps its own 7-day copy, with Cloudflare's invocation record (method and full
  URL, including any query string). Only staff with Cloudflare access see it. Turning that record
  off (`observability.logs.invocation_logs: false`) is a separate decision.
- A deploy of web or poller fails while `supahound-log-sink` does not exist. Deploy the sink first.
- A new event needs an entry in `OPS_EVENTS` and a row in the inventory; the test enforces both.
- Exception messages lose values (numbers, names with digits, quoted data). Enough to see what
  failed and where; the matching `*_crashed` event names the tenant or project.
- Cost: tail Workers bill by CPU time; R2 by stored bytes and one write per kept invocation,
  deleted after 90 days.
