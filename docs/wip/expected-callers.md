# WIP: Service-role alerts without an ASN (#184)

Decision 050. Goal: stop false High service-role alerts and repeat emails; let Owners and Admins
mark a network as expected.

## Status — 2026-11-24

- **PR 1 (this branch, `feature/expected-callers`): built.** Platform names in `HOSTING_ORG`;
  `serviceRoleActor` keys on a fingerprint of the network name when the ASN is missing, and the
  evidence carries the normalized name as `network`; repeat suppression in `sendPendingAlerts`.
- **Replay check (local only, no data committed):** 24 hours of rollup rows from two dogfood
  projects through detector 4. Before #182: 11 High findings. After #182: 3 High (a platform
  network). This branch: 0.
- **Next: PR 2 (#185), expected networks and name-keyed network memory** (decision 050 points 4 and 5).
  Needs a migration: a table of expected networks (like `public_tables`, decision 045) and name
  rows for `service_role_networks` with their own seeded state. UI: a "Mark this network as
  expected" button on a service-role incident for Owners and Admins, and a list with Remove in
  project settings. Audit `detection_setting` with `setting: "expected_network"`.

## Files changed (PR 1)

- `packages/core/src/network/classify.ts`: platform names, `networkName`.
- `packages/core/src/detectors/serviceRole.ts`: `serviceRoleActor`, `network` in the evidence.
- `packages/core/src/alerts/email.ts`: `REPEAT_WINDOW_DAYS`, `repeatSuppressible`.
- `packages/core/src/db/repo.ts`: `repeatAlertSent`.
- `packages/core/src/poller/pollProject.ts`: the suppression step in `sendPendingAlerts`.
- Tests: `test/serviceRole.test.ts`, `test/db/alerts.test.ts`. Both proved to fail without the change.

## Problems and notes

- `test/db/incidentHistory.test.ts` fails on a Mac whose Postgres time zone has daylight saving
  time: `make_interval(days => 30)` on a `timestamptz` spans the 1 November change, so the
  boundary moves one hour and the "too old" row is listed. It fails on clean `develop` too. CI runs
  in UTC. Not changed here.
- No production deploy yet. #182 and this PR are on `develop` only; production keeps sending the
  false alerts until a release ships (needs Erik's approval).
