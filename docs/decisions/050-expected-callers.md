# 050: Service-role alerts without an ASN: network names, repeat suppression, expected networks

Date: 2026-11-24 · Issues #184, #185 · Builds on 003 (network memory), 030 (alert email), 045 (detection settings)

## Context

Detector 4 (`service_role_misuse`) sent High alerts for normal server traffic, several times a day.
On a dogfood workspace, every service-role incident in 14 days was a false positive. Four causes:

1. **Edge logs carry no ASN.** `request.cf.asn` was empty on every request checked;
   `request.cf.asOrganization` was filled. `HOSTING_ASNS` and `projects.expected_asns` never match,
   and decision 003's network memory learns nothing.
2. **Platform names missing.** `HOSTING_ORG` lacked the application platforms (Railway, Render,
   Fly.io, Vercel, Heroku, Netlify, Supabase). #182 added Amazon's EU registrant, "A100 ROW".
   A server on a missing platform raised `non_hosting_network` (High).
3. **One actor for every network without an ASN.** The actor was `service_role:asn:unknown`, so a
   cloud server and a home connection shared one incident key.
4. **Each new incident emails.** The engine resolves an incident when its actor is quiet for one
   poll. The next call opens a new incident, and its first email goes out.

Erik asked on 2026-11-24 for a way to tell real problems from noise and to whitelist the noise.

## Decision

1. **Platform names are hosting networks.** `HOSTING_ORG` matches the platforms above, `fly\.io`
   rather than `fly`. The ASN list stays, in case the field comes back.
2. **The actor keys on the network name.** `serviceRoleActor`: `service_role:asn:<n>` when the log
   has an ASN; else `service_role:net:<fingerprint>` of the normalized network name (`networkName`:
   lowercase letters, digits and single spaces, at most 80 characters); else
   `service_role:asn:unknown`. The finding's evidence carries the normalized name as `network`.
   Cloudflare sets the name from the caller's IP, so the caller does not choose it. The explainer
   does not receive it (its features are an allowlist).
3. **Repeat suppression.** A new incident does not email when another incident of the same project,
   with the same actor and the same signal set, had an email sent (outcome `sent` or `partial`) at
   the same or a higher severity in the last 7 days. The window counts from the audit row of the
   last email actually sent, so a suppressed repeat never extends it. The suppressed incident is
   marked alerted at its severity and audited as `alert_email` with outcome `repeat_suppressed`. A
   later rise in severity emails. The dashboard lists every incident. It applies to every detector,
   not only detector 4: any incident that reopens daily for the same actor is the same noise.
   Never suppressed: critical
   incidents, and the `browser_caller` and `mobile_app_caller` signals, because a key in a browser
   or an app is a leak each time it shows.
4. **Expected networks (#185).** Owners and Admins mark a network as expected by its
   normalized name, from a service-role incident or from project settings. A mark silences the
   network signals (`non_hosting_network`, `new_network`) for that name only; it never silences
   a browser, a mobile app or a manual tool. Stored like decision 045's public tables: its own
   table with `tenant_id`, forced RLS, RESTRICTIVE insert and delete for Owners and Admins, and a
   `detection_setting` audit row for each mark and unmark.
5. **Network memory by name (#185, with point 4).** When the ASN is missing, decision 003's memory keys
   on the network name. Names have their own seeded state: the first poll that sees names learns
   them silently, even for a project that already has ASN rows. Without that, every known provider
   would raise `new_network` once on the first poll after the deploy.

## Alternatives considered

- **Treat the project's own edge functions as known by user agent** (`SupabaseEdgeRuntime ...
  ref=<project ref>`). Rejected: gated on a hosting network, it adds nothing once the names match;
  not gated, anyone with the key could fake the user agent and silence a High signal.
- **Suppress on actor alone.** Rejected: before point 2, every network without an ASN shared one
  actor, so a home-network leak would have merged into an old false positive and not emailed.
- **Keep an incident open for a quiet period instead of suppressing emails.** Rejected for now: it
  changes the incident timeline and history (decision 035) for every detector. Suppression changes
  only who gets an email.
- **A reputation feed for network types.** The PRD rules feeds out.

## Consequences

- On the first deploy, open service-role incidents whose actor was `service_role:asn:unknown`
  resolve, and new ones open under the network actor. A new incident on a non-hosting network
  emails once.
- A real leak from the same network as an earlier alert does not email again for 7 days. The
  dashboard shows it, and any rise in severity, a browser or app caller, or a critical finding
  still emails.
- `projects.expected_asns` stays, but it matches nothing while logs carry no ASN. Expected networks
  (point 4) replace it.
