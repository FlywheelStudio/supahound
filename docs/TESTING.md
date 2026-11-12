# Testing

Updated 2026-11-12. CI runs every tier below on each pull request
([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)). A PR merges only when CI is green.

## Tiers

| Tier | What it proves | Where | Command | Count |
| --- | --- | --- | --- | --- |
| Unit | Pure logic: detectors, parser, ownership, engine, explainer, vault, OAuth, web helpers | `packages/core/test/*.test.ts`, `apps/web/test/` | `pnpm -r test` | 678 core (unit + Postgres + detection UAT), 149 web |
| Postgres | RLS, isolation, repositories, the poller end to end | `packages/core/test/db/` | `pnpm -r test` | 197, within the 678 |
| workerd | Core runs inside the Workers runtime (vault, detectors, AI SDK with ZDR) | `apps/poller/test/` | `pnpm -r test` | 12 |
| UAT, detection | PRD outcomes over the full poll pipeline | `packages/core/test/uat/` | `pnpm -r test` | 9, within the 678 |
| E2E, signed out | The built web Worker: redirects, CSRF, cache headers, hook signature | `apps/web/e2e/specs/public.spec.ts` | `pnpm e2e` | 11 |
| UAT, web journey | Sign-in → workspace → connect → incident → history → invites → posture → security scan, in a real browser | `apps/web/e2e/specs/*.uat.spec.ts` | `pnpm e2e` | 47 |

Totals on `feature/scan-domains` (2026-11-12): core 678, web 149, poller 12, E2E 58.

`pnpm -r test` and `pnpm e2e` stay separate. E2E needs a build and a browser.

### Postgres

The database suites start a throwaway Postgres 17 cluster and apply every migration in
`supabase/migrations/` in order. They log in as roles that are not superusers and own nothing, so
forced RLS applies as in production. `initdb` comes from `SUPAHOUND_PG_BIN`, then
`/opt/homebrew/opt/postgresql@17/bin`, then `/usr/lib/postgresql/17/bin`.

`SUPAHOUND_SKIP_DB_TESTS=1` skips them on a machine with no Postgres. CI never sets it, and the CI job
fails if any suite reports skipped tests.

### E2E stack

`pnpm e2e` runs `vite build`, then Playwright. The global setup (`apps/web/e2e/support/globalSetup.ts`) starts:

1. **Postgres 17 on TCP.** The Worker reaches it through the local Hyperdrive binding
   (`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP`).
2. **A fake Supabase Auth** (`support/fakeAuth.ts`). It issues ES256 tokens, and `getClaims()` verifies
   them against its JWKS endpoint, as with Supabase's asymmetric keys. On `/otp` it calls our Send
   Email Hook with a real Standard Webhooks signature and records the HTTP status.
3. **A fake Supabase Management API** (`support/fakeManagement.ts`). It serves `GET /v1/projects`
   per bearer token; an unknown token gets 401. For the posture scan (#11) it also serves the
   read-only SQL endpoint and `GET .../advisors/security` per project ref, set through `/__test/posture`;
   the E2E poll reaches them through core's real clients. The Worker reaches it through `SUPABASE_API_URL`,
   because `page.route` cannot see server-side calls.
4. **The built Worker** under `wrangler dev`, with test-only secrets in a temp env file.

Nothing calls a real Supabase, Stripe or model API. UAT-W5 stops the browser at
`api.supabase.com` with a route stub. UAT-W8 runs core's real `pollProject` against synthetic
rollup rows, with the template explainer in place of the model.

Before a test clicks a link right after `page.goto` or `page.reload`, call `settled(page)`
(`e2e/support/session.ts`). Those calls return at the load event, but vinext's `<Link>` imports its
navigation module on the first click, and a click in that window was lost once (UAT-W14, #70).

First run on a new machine: `pnpm --filter @supahound/web exec playwright install chromium-headless-shell`.
Set `E2E_DEBUG=1` to print the wrangler output.

### Secret scan

The CI job `secrets` runs gitleaks 8.30.1 (pinned by SHA-256) over the full history with
`.gitleaks.toml`: the default rules plus Postgres URLs with a password, Supabase secret keys, personal
access and OAuth tokens, OAuth client secrets, Stripe webhook secrets, Vercel AI Gateway keys and
`SUPAHOUND_MASTER_KEYS` values. Run it locally with
`gitleaks git --config .gitleaks.toml --redact .` (`brew install gitleaks`).

Prove a new rule can fail: commit a planted secret in a scratch clone and see the rule fire. On
2026-11-10 every custom rule fired on its planted secret, a placeholder URL
(`postgres://postgres:postgres@…`) did not, and the real history had no findings (decision 025).

### Self-hosting checks

- `packages/core/test/db/loginUsers.test.ts` (7, Postgres) runs `supabase/setup/login-users.sql`
  with the real `psql`: short passwords refused, no superuser or BYPASSRLS, one role each, RLS
  still applies, the scheduler keeps only its column grants, it works twice as a non-superuser
  with CREATEROLE (as Supabase's `postgres` is), an existing BYPASSRLS user is refused, a second
  run is safe.
- `packages/core/test/vault.test.ts`, `newMasterKeys` (4): the vault accepts a new key, rotation
  keeps old tokens readable.
- `packages/core/test/explainer.test.ts`, `explainerFor` (4): no key (or a blank one) means
  template text and no HTTP request.
- Mutations on record (2026-11-10): BYPASSRLS granted → 1 fails; the wrong role granted → 2 fail;
  rotation drops the old keys → 1 fails; a blank key treated as a key → 2 fail; `ALTER ROLE` names
  NOBYPASSRLS → the non-superuser run fails; the BYPASSRLS check removed → 1 fails.

## Rules

- Every feature ships with tests. Each acceptance criterion in its issue maps to a test or to a
  manual UAT row below.
- **Prove a new check can fail.** Break the code it guards, see the test fail, then restore the
  code. Record the mutation in the PR or the WIP doc. A check that passes on the first run proves
  nothing until it has failed once.
- Synthetic data only. Never commit real log rows, user IDs, IPs or emails.
- Mock external services in unit tests. Use test-mode keys only, never live mode.

## UAT catalogue

Scenario IDs are stable. Add new ones at the end. Use the "UAT scenario" issue template.

### Detection (automated, `packages/core/test/uat/detection.uat.test.ts`)

| ID | Scenario |
| --- | --- |
| UAT-D1 | A user who reads another user's rows raises one critical incident and one page |
| UAT-D2 | The service key used from a browser on a home network raises a critical incident |
| UAT-D3 | Normal app and server traffic raises nothing, and the project reads as assessed |
| UAT-D4 | The same attack minutes later updates the open incident and does not page again |
| UAT-D5 | A Supabase logs outage reads as "unable to assess", never as an all-clear |
| UAT-D6 | An agency and its client watching one Supabase project each see only their own incidents |
| UAT-D7 | A scrape is caught with ownership read from the project's own RLS policies; public profiles stay quiet |
| UAT-D8 | A project whose RLS policies cannot be read shows detector 2 as "unable to assess", and detector 4 still alerts |
| UAT-D9 | A project whose policies scope no table to an owner reads "no owner-scoped tables", not clean |

### Web journey (automated, `apps/web/e2e/specs/journey.uat.spec.ts`)

| ID | Scenario |
| --- | --- |
| UAT-W1 | A new user signs in with a magic link and lands on onboarding; the signed hook returns 200 |
| UAT-W2 | A sign-in link works once |
| UAT-W3 | A signed-in user who opens /login goes straight to the app |
| UAT-W4 | A new user creates a workspace and sees the setup checklist; a second visit creates no second workspace |
| UAT-W5 | Connect Supabase goes to Supabase consent with PKCE S256 and a hashed, bound, short-lived state |
| UAT-W6 | A callback with a forged state connects nothing |
| UAT-W7 | Another user gets the same 404 for my workspace as for a missing one |
| UAT-W8 | The owner sees a critical incident after the poller catches a scrape; no raw IDs or user agents on the page |
| UAT-W9 | Signing out ends the session |
| UAT-W10 | The magic-link form gives the same answer for a known and an unknown address |
| UAT-W11 | The owner picks a project; it shows "waiting for first poll"; inactive projects cannot be picked |
| UAT-W12 | A forged pick adds only running projects Supabase lists, with Supabase's name, each once |
| UAT-W13 | A viewer sees watched projects, gets no picker or Remove, triggers no Supabase call; a replayed owner form is refused |
| UAT-W14 | Remove needs the exact name; it deletes the project and its incidents and keeps its audit rows |
| UAT-W15 | A revoked Supabase grant shows "Reconnect Supabase", not a 500 |
| UAT-W16 | The overview says when cross-tenant reads cannot be assessed or have nothing to cover (`ownership.uat.spec.ts`) |
| UAT-W17 | The owner's address is on file; every incident emails by default; the owner raises the threshold (`alerts.uat.spec.ts`) |
| UAT-W18 | A viewer sees the threshold but cannot change it, even by replaying the owner's form; visiting records the member's address |
| UAT-W19 | The owner opens a project from the overview and switches projects from the dropdown (`nav.uat.spec.ts`) |
| UAT-W20 | Project settings: General with Remove, Notifications with SMS Coming soon, Plan, People (live since #24); Soon badge on Security scan |
| UAT-W21 | A project ID from another workspace, a made-up ID and a malformed ID are each a 404 |
| UAT-W22 | A viewer opens every project page but gets no Add project, no Remove and no alert form |
| UAT-W23 | The incident list shows 30 days of open and resolved incidents, newest first, in keyset pages; a 31-day-old resolved one is gone (`incidents.uat.spec.ts`) |
| UAT-W24 | The incident detail shows the actor alias, signals, counts, time range, summary and suggested fix; no raw IDs; a summary from counts when none is stored |
| UAT-W25 | Another workspace's, another project's, an old resolved, a made-up or a malformed incident, and a malformed cursor, are each a 404; so is my incident for another workspace's user |
| UAT-W26 | An owner invites a colleague by email; signed out, they open the link, sign in, accept, and see only that project; the other project is a 404; the link works once (`people.uat.spec.ts`) |
| UAT-W27 | A viewer gets no invite form and a replayed owner form is refused; an admin cannot invite an Owner, even by a forged form |
| UAT-W28 | An invite is bound to its address; a resend kills the old link; an expired or canceled invite is refused; a non-member gets a 404 |
| UAT-W29 | The first poll after a pick shows posture findings on the overview, the dashboard and the Posture tab, with fix SQL; Advisor duplicates show once; no Advisor free text; a refused project reads "unable to assess" (`posture.uat.spec.ts`) |
| UAT-W30 | Scan now queues a scan the next poll runs within the 24 hours; a viewer gets no button and a replayed owner form is refused |
| UAT-W38 | An owner attaches a verified domain (an unverified one is not offered) and sees the newest finished scan's findings, most severe first, with the fix and allowlisted evidence; a planted secret never reaches the page; the domain belongs to one project; detaching hides the findings (`scanDomains.uat.spec.ts`) |
| UAT-W39 | A viewer sees the findings and the attached domain but no Attach or Detach, never sees an unattached domain, and replayed owner forms are refused |
| UAT-W40 | Another workspace's project is a 404 on the Security scan tab and its settings; my own project shows nothing of its domain |

### Billing (automated, `apps/web/e2e/specs/billing.uat.spec.ts`, decision 028)

Stripe is the fake in `apps/web/e2e/support/fakeStripe.ts`, reached through the real Stripe SDK.

| ID | Scenario |
| --- | --- |
| UAT-B1 | A new workspace opens nothing but billing: overview, projects and the OAuth callback all go to billing |
| UAT-B2 | The terms must be ticked (checked on the server); our page and Checkout both state the hold, trial and prices |
| UAT-B3 | A good card starts a 7-day trial at one Starter seat, the $1 hold is released, the workspace opens |
| UAT-B4 | A card whose bank skips the CVC check passes |
| UAT-B5 | A prepaid card is refused; no trial; no hold left; the workspace stays closed |
| UAT-B6 | A failed CVC is refused, the same way |
| UAT-B7 | Giving up after a decline adds no card |
| UAT-B8 | The webhook alone starts the trial; a replayed event changes nothing |
| UAT-B9 | A webhook without Stripe's signature gets 400 |
| UAT-B10 | A canceled subscription closes the workspace again |
| UAT-B11 | A member cannot add the card and is told to ask an owner |
| UAT-B12 | Each project shows its tier and 30-day requests; a busy project bills at Pro without proration; above 10M shows Enterprise |
| UAT-B13 | A staff owner (exempt domain) opens a workspace with no card and no Stripe calls; the workspace needs a card once a second owner joins (decision 029) |
| UAT-B14 | A staff admin in a customer's workspace does not make it free (decision 029) |

### Manual (needs a live service)

| ID | Scenario | Needs | Issue |
| --- | --- | --- | --- |
| UAT-M1 | A real magic-link email arrives from Cloudflare Email Service, and the link works once | Supahound's Supabase project, email domain | #21 |
| UAT-M2 | Connect Supabase completes the real consent and stores a sealed token | Registered OAuth app | #4 |
| UAT-M3 | The poller reads a live project's edge logs and records an `ok` run | Live token with `analytics:read` | #3 |
| UAT-M4 | One explainer call routes with ZDR on both models | AI Gateway Pro key | #6 |

## Mutation checks on record

| Check | Mutation | Result |
| --- | --- | --- |
| `getClaims()` verifies the signature | Fake Auth signs with a key that is not in its JWKS | UAT-W1 fails |
| Hook checks its signature | Fake Auth signs the hook with the wrong secret | UAT-W1 fails (401) |
| No shared caching of signed-in pages | Middleware stops setting `private, no-store` | 3 E2E checks fail |
| No second page for a repeat | Engine pages on every update at high or above | UAT-D4 fails |
| Sign-in email HTML is escaped | `renderSignInEmail` drops `escapeHtml` | 2 unit tests fail |
| Picks are checked against Supabase's list | `handleWatch` inserts the submitted refs | UAT-W12 fails |
| Remove needs the exact name | `removalOutcome` ignores the typed name | UAT-W14 fails |
| Removal keeps audit rows | Migration `20261109000000` left out | Postgres `projects.test.ts` fails |
| Never-loaded ownership is not clean (#10) | The run records no unassessed detectors | 3 tests fail, including UAT-D8 |
| Policies audit row precedes the query (#10) | Audit row written after the query | 1 Postgres test fails |
| A failed read keeps the old map (#10) | Failure also resets `ownership` to `{}` | 1 Postgres test fails |
| A failed read retries after an hour (#10) | Retry wait set to 0 | 1 Postgres test fails |
| A lost attempt retries after an hour (#10) | Retry wait keyed on `ownership_error` instead of a saved success | 1 Postgres test fails |
| 24-hour refresh (#10) | Never read again after the first attempt | 3 Postgres tests fail |
| An unreadable response is an error (#10) | Client reads a body without rows as no policies | 2 unit tests fail |
| "No owner-scoped tables" is its own state (#10) | `listProjects` drops the state | 2 tests fail, including UAT-D9 |
| The overview shows the coverage note (#10) | Page hides the note | UAT-W16 fails |
| Only a service_role JWT is a finding (#74) | The JWT rule drops its `role` check | 3 unit tests fail |
| Redirect hops pass the scope guard (#74) | `scopedGet` follows `Location` without `scannableUrl` | 2 unit tests fail |
| A leak path must answer at its own path (#74) | `probeLeakPaths` drops the same-path check | 1 unit test fails |
| An npmrc needs a known key (#74) | `leakShape` drops the known-key check | 1 unit test fails |
| Four in five env lines are KEY=VALUE (#74) | Ratio back to one in two | 1 unit test fails |
| The billing gate (decision 028) | `withPaidTenantForUser` stops throwing for unpaid tenants | 10 Postgres billing tests fail |
| The web app uses the gate (decision 028) | `paidTenant` passes billing "off" | UAT-B1 fails |
| Staff exemption ends with the owners (decision 029) | The membership trigger never fires | 4 Postgres exemption tests fail |
| The scheduler polls exempt workspaces (decision 029) | `dueProjects` drops `OR exempt_at IS NOT NULL` | 1 Postgres exemption test fails |
| The exempt domain must match (decision 029) | E2E exempt list set to another domain | UAT-B13 fails |
| Only the sole owner is exempt (decision 029) | Admins may be granted it; the gate skips the sole-owner check | UAT-B13 and UAT-B14 fail |
| Alerts send once per severity (#16) | `pendingAlerts` ignores `alerted_severity` | 4 Postgres alert tests fail |
| A sent alert is marked (#16) | `sendPendingAlerts` never calls `markAlerted` | 5 Postgres alert tests fail |
| Model text loses its links (#16) | `cleanText` skips `stripLinks` | 1 unit test fails |
| Only owners and admins set the threshold (#16) | `setEmailAlertsAction` treats every role as owner | UAT-W18 fails |
| Project pages show only this tenant's projects (#98) | `loadProjectPage` falls back to the first project for an unknown ID | UAT-W21 fails (200, not 404) |
| The dashboard lists one project's incidents (#98) | `listOpenIncidents` ignores its project filter | `projects.test.ts` fails |
| History keeps to its project (#44) | `listIncidentHistory` and `getIncident` drop the project filter | 4 Postgres tests fail |
| The detail keeps to its project (#44) | `getIncident` alone drops the project filter | UAT-W25 fails (200, not 404) |
| Open incidents stay in the window (#44) | The window drops `status = 'open'` | 1 Postgres test fails |
| The window is 30 days (#44) | The window set to 3650 days | 1 Postgres test fails |
| The cursor keeps microseconds (#44) | The cursor is cut to milliseconds | 1 Postgres test fails (a row is skipped) |
| Ties on last seen break by id (#44) | The keyset compares `last_seen_at` only | 1 Postgres test fails |
| No next page after a full last page (#44) | `next` set when the page is exactly full | 2 Postgres tests fail |
| The list follows the cursor (#44) | The page ignores `?before=` | UAT-W23 fails |
| Bad IDs and cursors never reach Postgres (#44) | `parseIncidentId` returns its input; `parseCursor` skips the digit check | 1 unit test fails each |
| Stored explanation text is cleaned (#44) | `explanationOf` skips `cleanText` | 2 unit tests fail |
| The detail hides the raw actor (#44) | The page prints `actor` next to the alias | UAT-W24 fails |
| Project rows hidden without a role (#24) | `project_access` policies pass every row | 5 Postgres tests fail; UAT-W26 fails (the other project shows) |
| Every project table gets `project_access` (#24) | `project_usage` left out of the policy loop | `isolation.test.ts` catalog check fails |
| Settings writes need Editor (#24) | `project_settings` policy passes every role | 1 Postgres test fails |
| Only an Owner grants Owner (#24) | `people_*` policies drop `role <> 'owner'` | 3 Postgres tests fail |
| `project_role` stays in the tenant (#24) | The function drops its join on `projects` | 3 Postgres tests fail (Owner on another tenant's project ID) |
| An invite needs the invited address (#24) | `acceptInvite` skips the email check | 1 Postgres test fails |
| An invite expires (#24) | `acceptInvite` ignores `expires_at` | 1 Postgres test fails |
| An invite works once (#24) | `acceptInvite` ignores `accepted_at` | 1 Postgres test fails |
| Alerts go to the project's people (#24) | `alertRecipients` drops its project filter | 1 Postgres test fails |
| The backfill keeps members' access (#24) | The backfill statement removed | 3 Postgres tests fail |
| The server checks the role before an invite (#24) | `inviteAction` skips `canInviteAs` (RLS still refuses) | UAT-W27 fails (500, not the role notice) |
| An invite link survives sign-in (#24) | `/auth/confirm` ignores the `supahound_next` cookie | UAT-W26 fails (lands on onboarding) |
| Nobody manages their own role (#24) | `canManagePerson` drops the self check | 1 unit test fails |
| Admins never grant Owner (#24) | `assignableRoles("admin")` includes Owner | 2 unit tests fail |
| Invite email HTML is escaped (#24) | `renderInviteEmail` drops `escapeHtml` on the lead | 1 unit test fails |
| RLS off is rated by the API grants (#11) | `rls_disabled` ignores grants | 1 unit test fails |
| `USING (true)` is detected (#11) | `isTrueExpr` never matches | 9 unit tests fail |
| A restrictive policy still filters (#11) | Restrictive policies ignored | 1 unit test fails |
| `security_invoker` views pass (#11) | The invoker check removed | 2 tests fail (unit and Postgres) |
| FORCE is not required (#11) | RLS counts only when forced | 2 unit tests fail |
| The Advisor's "unavailable" lint is not clean (#11) | The lint ignored | 2 tests fail (unit and Postgres) |
| An Advisor body without lints is an error (#11) | Read as no lints | 1 unit test fails |
| No Advisor free text is kept (#11) | `parseLints` keeps `title` | 2 unit tests fail |
| Names with control characters are dropped (#11) | `safeName` allows them | 3 unit tests fail |
| Advisor duplicates show once (#11) | `dedupePosture` keeps all | 2 tests fail (unit and Postgres) |
| Posture raises detections (#11) | `raiseForPosture` returns its input | 4 tests fail (unit and Postgres) |
| The raise agrees with the Posture page (#11) | `postureExposedTables` filters by severity before dedupe | 1 Postgres test fails |
| Service-role findings are not raised (#11) | The detector check removed | 1 unit test fails |
| Scan now runs within the 24 hours (#11) | The claim ignores a pending request | 1 Postgres test fails |
| Daily refresh (#11) | Refresh wait set to 10^9 s | 3 Postgres tests fail |
| A failed scan retries after an hour (#11) | Retry wait 0 | 1 Postgres test fails |
| A failed source keeps its findings (#11) | Failed sources wipe their rows | 3 Postgres tests fail |
| Posture audit row precedes the calls (#11) | Audit row not written | 1 Postgres test fails |
| Posture rows hidden without a project role (#11) | `project_access` passes every row | 3 Postgres tests fail |
| Only owners, admins and editors ask for a scan (#11) | INSERT policy passes every role / UPDATE policy passes every role | 1 Postgres test fails each |
| Signed-in users never write findings (#11) | Findings INSERT policy passes every role | 1 Postgres test fails |
| The overview never calls a failed scan clean (#11) | `postureLine` drops the unable state / hides the Advisor gap | 1 web unit test fails each |
| The server checks the role before Scan now (#11) | `scanNowAction` skips `canScan` | UAT-W30 fails (no role notice) |
| The Posture tab shows the fix SQL (#11) | The page hides the SQL | UAT-W29 fails |
| One project per scan domain (#100) | Primary key widened to `(tenant_id, domain_id, project_id)` | 2 Postgres tests fail |
| Only verified domains link, for every writer (#100) | The trigger drops `verified_at IS NOT NULL` | 2 Postgres tests fail |
| Only Owners and Admins attach, in RLS (#100) | `scan_link_insert` passes every role | 1 Postgres test fails |
| Only Owners and Admins detach, in RLS (#100) | `scan_link_delete` passes every role | 1 Postgres test fails |
| Links hidden without a project role (#100) | `project_access` on `scan_domain_links` passes every row | 3 Postgres tests fail |
| Scan data follows the link (#100) | `scan_link_access` passes every row | 4 Postgres tests fail |
| The tab shows the newest finished scan (#100) | The lateral join picks the oldest | 1 Postgres test fails |
| Attach needs Owner or Admin (#100) | `canLinkDomains` uses `edit_settings` | 1 web unit test fails |
| The server checks the role before attach and detach (#100) | Both actions skip `canLinkDomains` (RLS still refuses) | UAT-W39 fails (`missing`, not the role notice) |
| Evidence is an allowlist (#100) | `evidenceItems` also shows unknown keys | 2 web unit tests fail; UAT-W38 fails (the planted secret shows) |
| At most the last four characters (#100) | `last4` shape check removed | 1 web unit test fails |
| A Supabase-shaped hook answer (#87) | Hook answers 200 with no JSON content type | 15 of 27 E2E tests fail (the fake Auth rolls back) |

Older mutation checks (RLS, vault, OAuth, ZDR guard, windows) are listed in each WIP doc's build log.
