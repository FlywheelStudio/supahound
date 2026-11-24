# Service-role alerts without an ASN: network names, repeat suppression, expected networks

Issues #184 and #185. Decision 050. Builds on decisions 003, 030 and 045.

## What it does

Detector 4 (`service_role_misuse`) alerts when the service-role key is used from a browser, a mobile
app, a manual tool, a network that is not a cloud or hosting provider, or a hosting network the
project has not used before. Edge logs carry the network's org name but, in practice, no ASN. This
feature makes the detector work from the name:

- **Platform names are hosting networks.** Railway, Render, Fly.io, Vercel, Heroku, Netlify and
  Supabase join the cloud providers and Amazon's EU registrant ("A100 ROW", #182).
- **One incident per network.** Without an ASN, the actor is `service_role:net:<fingerprint>` of
  the normalized name, so a cloud server and a home connection never share an incident.
- **No repeat emails.** A new incident does not email when the same project, actor and signal set
  had an email sent at the same or a higher severity in the last 7 days. The dashboard lists it.
- **Expected networks.** Owners and Admins mark a network as expected from the incident page. The
  detector then raises no network signal for it. A browser, app or manual tool still alerts.
- **Network memory by provider.** "A hosting network not seen before" works without an ASN. It
  means a different provider: another Amazon region is not new.

## How it works

1. **Classify** (`packages/core/src/network/classify.ts`). `classifyNetwork` matches the ASN list,
   then `HOSTING_ORG` on the org name. `networkName` normalizes the name: lowercase letters, digits
   and single spaces, at most 80 characters. Cloudflare sets the name from the caller's IP.
2. **Detect** (`packages/core/src/detectors/serviceRole.ts`). `serviceRoleActor` builds the actor.
   The evidence holds the normalized name as `network` and `expectedNetwork` (true when a mark or an
   `expected_asns` entry matched). `new_network` uses the ASN memory when the log has an ASN, and
   otherwise the name memory, keyed by `networkMemoryKey`: the provider (`amazon`, `railway`, ...)
   or, for a generic host, the normalized name. Each memory has its own seeded state: the first poll
   that learns a key learns it silently, even for a project already seeded by ASN. Only hosting
   networks seen from server or unknown callers teach the memory.
3. **Poll** (`packages/core/src/poller/pollProject.ts`). The load step reads `loadNetworks`,
   `loadNetworkNames` and `expectedNetworkSet`; the save step writes both memories.
4. **Email** (`sendPendingAlerts`). Before an incident's first email, `repo.repeatAlertSent` looks for
   an `alert_email` audit row with outcome `sent` or `partial`, in the last 7 days, for another
   incident of this project with the same actor and the same signal set, at the same or a higher
   severity. On a match: no email, the incident is marked alerted, and the audit row says
   `repeat_suppressed`. Critical incidents and `browser_caller` or `mobile_app_caller` are never
   suppressed (`repeatSuppressible` in `alerts/email.ts`).
5. **Mark** (web). The incident page shows the network names its findings carry
   (`incidentNetworkNames`). For Owners and Admins, and only when the incident has a network signal,
   it offers "Mark as expected" for each unmarked name. The action (`markExpectedNetworkAction` in
   `settings/actions.ts`) checks the role in the same transaction as the write, and redirects to
   Settings → Notifications, which lists the marks with Remove. Logic: `apps/web/lib/detectionSettings.ts`.

## Data model and RLS

Migration `20261124000000_expected_networks.sql`, additive.

- `expected_networks (id, tenant_id, project_id, network, marked_by, marked_at)`: unique per project
  and name; the name has a CHECK for the normalized form. RLS: `tenant_isolation`, `project_access`
  (RESTRICTIVE SELECT), RESTRICTIVE INSERT and DELETE for the project's Owners and Admins. No UPDATE.
  Each mark and unmark writes a `detection_setting` audit row
  `{setting: "expected_network", change, network, by}`.
- `service_role_network_names (tenant_id, project_id, network, first_seen)`: `network` holds the
  memory key (a provider such as `amazon`, or a normalized name). RLS `tenant_isolation`,
  `project_access`; only transactions without a signed-in user (the poller) insert.
- Both cascade with the project, so a workspace purge (decision 037) removes them.

## External services

None new. The detector reads the same edge-log fields.

## Testing

- `packages/core/test/serviceRole.test.ts`: platform names, `networkName`, `serviceRoleActor`; a
  platform server raises nothing; a home network still raises High with the name in the evidence;
  a browser on a platform is still critical; name memory learns silently, flags a new provider
  once, learns silently when the ASN memory is seeded, treats another Amazon region as known, keys a
  generic host by name, never learns from a browser or manual tool; a mark silences network signals
  but not a browser.
- `packages/core/test/db/alerts.test.ts`: repeat suppression (7 cases, see the alert feature doc).
- `packages/core/test/db/expectedNetworks.test.ts`: who may mark and unmark (RLS for every role),
  the audit trail, stored names only, tenant isolation, poller-only memory writes; two full polls:
  silent first-poll learning, `new_network` once, a marked home network goes quiet, a browser on a
  marked network still alerts.
- `apps/web/test/expectedNetworks.test.ts`: roles, redirects and notices, input refused before any
  database call, which networks the incident page offers.
- UAT-W55 (`expectedNetworks.uat.spec.ts`).
- Mutation checks in `docs/TESTING.md`.
- Replay, local only: 24 hours of rollup rows from two dogfood projects. Before #182: 11 High
  findings; after this feature: 0. Replayed as sequential polls in first-seen order: 0
  `new_network` with the provider key, 8 with a raw-name key.

## Gotchas

- **The ASN is empty.** `request.cf.asn` was empty on every request checked on 2026-11-24. Anything
  keyed only on the ASN (`HOSTING_ASNS`, `expected_asns`) does nothing while that lasts. Covered by
  the no-ASN tests.
- **Key the memory on the provider, not the name.** One provider uses many names (9 Amazon names
  for one project's edge functions in one day), each first seen hours apart. Keyed on the raw name,
  a replay of that day raised 8 `new_network` alerts. Covered by "keys the memory on the provider".
- **Name memory needs its own seeded state.** Seeded with the ASN memory, every provider name would
  raise `new_network` on the first poll after the deploy. Covered by "learns names silently even
  when the ASN memory is already seeded".
- **Suppress on actor and signals, never on actor alone.** Before the network actor, every network
  without an ASN shared one actor. Covered by "emails a different actor, a different signal set".
- **The window counts from the last email sent.** A suppressed repeat must not extend it. Covered by
  "counts from the last email sent, not from a suppressed repeat".
- **A mark never hides a browser or app.** Covered in the unit, poll and UAT tests.
- **The actor change resolves old incidents.** On the first deploy, open incidents with the actor
  `service_role:asn:unknown` resolve, and new ones open under the network actor.
