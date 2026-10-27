# WIP: Baseline-free detectors prototype

PRD "This week" task 4: prototype detector 2 (cross-tenant access) and detector 4 (service-role
misuse) against one project.

## Status — 2026-10-27

- Done: both detectors, PostgREST parser, per-command ownership from policies, log client, CLI.
  127 tests pass. Typecheck and lint clean.
- **Next step:** run against one live Flywheel client project. Needs a token with `analytics:read` and a
  project ref from Erik. Order:
  1. `pnpm discover-keys --project <ref>`. Confirms the three unverified paths and the source column.
     Also check which key or role field fills for traffic that uses the new `sb_secret_` /
     `sb_publishable_` keys. On those projects `request.sb.jwt.apikey.payload.role` may be empty.
     The rollup SQL would then drop all service traffic, and detector 4 would report zero findings,
     which reads as an all-clear.
  2. Fix `src/config/fields.ts` if a path differs. Set `GUARDBASE_SOURCE_COLUMN` if `source` fails.
  3. Export the project's `pg_policies` rows (SQL from `print-sql`) to `ownership.local.json`.
  4. `pnpm scan --project <ref> --ownership ownership.local.json --minutes 60`. Review every finding.
- After the live run: write `docs/features/baseline-free-detectors.md`, delete this file, and move
  the item to Completed in STATE.md.

## Approach

- Edge logs come from `GET /v1/projects/{ref}/analytics/endpoints/logs`. One ClickHouse query rolls
  requests up by template (`count() AS hits`), so a poll returns templates, not raw rows.
- `src/config/fields.ts` is the only module that knows field paths. Detectors read `EdgeEvent`.
- Detector 2 parses the query string, maps each filter to its table (embedded resources included),
  and compares ownership-column values to the JWT subject. Ownership is per command: GET checks
  SELECT policies, PATCH checks UPDATE, DELETE checks DELETE.
- Detector 4 classifies the caller (X-Client-Info first, then user agent) and the network (bundled
  hosting-ASN list plus org-name match).

## Field paths

| Field | Path | Source |
| --- | --- | --- |
| method, path, search, status, content range, ASN, AS org, x_client_info | `request.*` / `response.*` | Log field reference (verified) |
| user agent | `request.headers.user_agent` | Troubleshooting guide (verified) |
| JWT subject | `request.sb.jwt.authorization.payload.subject` | Search summary of troubleshooting docs (**unverified**) |
| JWT role | `request.sb.jwt.authorization.payload.role` | Inferred (**unverified**) |
| API key role | `request.sb.jwt.apikey.payload.role` | Inferred from the older BigQuery schema (**unverified**) |

The API reference filters on `source`; the 23 Sept 2026 changelog filters on `source_name`.

## Decisions made

- [001](../decisions/001-typescript-node-worker.md) TypeScript on Node.js 22+, no framework.
- [002](../decisions/002-ownership-from-rls-policies.md) Ownership comes from RLS policies, per command.
- [003](../decisions/003-service-role-network-memory.md) Service-role networks: learn on first poll.

## Known gaps

- **Request bodies are invisible.** A PATCH or POST body and RPC parameters are not in edge logs.
  Detector 2 sees only the query string. `user_id=eq.B` in a PATCH URL is caught; a body that sets
  `user_id` is not.
- **Public-read tables raise no read alerts.** `SELECT USING (true)` or `is_public OR owner` means
  any user may read any row, so a read by another user's ID is not cross-tenant. Writes still alert.
- **Membership tables are out of scope.** `team_id IN (SELECT … auth.uid())` yields no ownership
  column. Cross-team access needs the membership table, which the logs do not carry.
- **Multi-party tables are rated medium.** `receiver_id=eq.B` by A on `messages` can be legitimate
  ("messages I sent to B"). The finding fires at medium unless an owner column is pinned to the
  caller. Scoring in the incident engine decides.
- **Hosting-ASN list is approximate.** 23 bundled ASNs plus an org-name regex. Cloudflare WARP
  traffic classifies as hosting.
- **Network memory in the CLI is in-process.** It resets per CLI run, so `new_network` never fires
  from the CLI. The poller persists it per tenant + project.
- **Severity is per finding.** The 15-minute per-actor score, dedup and suppression belong to the
  incident engine, which is not built.

## Build log

- **No lockfile in this repo yet.** `~/pnpm-workspace.yaml` (Feb 2026) makes pnpm treat the home
  folder as the workspace root. `pnpm add` therefore wrote supadog's dependencies into
  `~/pnpm-lock.yaml`, and the packages were linked from `~/node_modules`. This repo now has its
  own `pnpm-workspace.yaml`, `pnpm-lock.yaml` and store (fixed 2026-10-27).
- **Ownership fix.** The first version merged every policy on a table. The quickstart `profiles`
  table (SELECT `true`, UPDATE owner-only) then raised critical alerts on public profile reads.
  Ownership is now per command (decision 002).

- Tests first failed to catch a case-sensitive ID compare: the test IDs were all digits. Fixed the
  test to use a hex ID. Mutation checks now fail the suite for: or-group pin, case compare, subquery
  guard, command ignored, any permissive policy scoping, one OR branch scoping.
