# 021: The public site marks every unbuilt feature "Coming soon", tied to an issue

Date: 2026-11-09

## Context

The marketing site (decision 017) describes the V1 product: posture scan, five detectors, alerts,
digest, incident history, agency features and paid plans. None of these run in production yet.
Erik decided on 2026-11-09: mark everything not built as "Coming soon", and switch each one on as
it ships. He also chose one contact address, hello@flywheel.so, for every purpose.

## Decision

1. `apps/web/content/features.ts` is the one registry of public features. Each feature has a
   status (`live` or `soon`) and the GitHub issue numbers that ship it. Issue numbers never render.
2. Pages tag capability lines with a feature ID. `<Soon id>` renders a "Coming soon" pill until the
   status is `live`. A site-wide early-access banner shows while any feature is `soon`. llms.txt
   appends "(coming soon)" to the same lines.
3. The PR that ships a feature flips its status to `live` in the same commit. A test fails if a
   `soon` feature has no issue, or a plan line names a capability without a feature ID.
4. Paid-plan CTAs say "Get early access". The sign-up page tells a visitor who picked a paid plan
   that paid plans are coming soon, until `paidPlans` is live.
5. `hello@flywheel.so` is the only contact address, including in the privacy policy and terms.
   This supersedes the legal@flywheel.so line in decision 017.
6. The privacy policy's data promises (incident retention, account deletion within 30 days,
   disconnect, subprocessor notice) are a to-do feature: issue #43.

## Alternatives considered

- **Remove unbuilt features from the site.** Rejected: the pages would have nothing to rank or
  convert on, and every page would need a rewrite as features ship.
- **One banner only, no per-feature badges.** Rejected: a visitor could not tell what works today.

## Consequences

- Prose on platform and compare pages describes the product without per-sentence badges; the
  banner covers it. When the last feature ships, the banner disappears by itself.
- Detector names on the site follow the PRD ("scraping", "database tampering"); the registry maps
  them to issues #12 (query fingerprinting) and #13 (sensitive-column writes).
