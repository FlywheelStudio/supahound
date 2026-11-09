# 016: The scan funnel (hackme.si) is a front door to Supahound, not a separate product

Date: 2026-11-08

## Context

The PRD ([hackme.si — AI Pentest Lead-Gen PRD](https://claude.ai/artifact/N4FjPDGkoHvoSUFXMSCsAp))
proposes a free, self-serve AI pentest. A founder enters a URL, proves domain ownership, accepts a
scope agreement, and gets a findings report. The report's gaps convert into a Supahound trial. The
scan is the one-time snapshot; Supahound is the always-on version.

## Decision

Build the funnel inside this repo, sharing Supahound's account, tenancy, and data model. Three
decisions fix the shape:

1. **Shared tenancy.** Every scan row carries `tenant_id` under the same forced RLS as the rest of
   the schema (decision 004). A scan account is a Supahound account. The new tables —
   `scan_domains`, `scan_authorizations`, `scans`, `scan_findings`, `scan_jobs` — join the
   isolation invariant tested in `isolation.test.ts`.

2. **Two authorization gates, both in code.** No active scan runs until (a) the user proves control
   of the apex with a DNS TXT record we issued, read over several DoH resolvers that must agree
   (`scan/verify.ts`), and (b) scope is locked to that apex (`scan/scope.ts`). The scope guard
   refuses any host outside the verified apex and denies protected classes (government, military,
   major platforms) regardless of a spoofed TXT record. `scan_authorizations` stores the accepted
   scope agreement as append-only legal evidence, like `audit_log`.

3. **Passive first.** Milestone 1 is the funnel plus passive, non-exploitative checks (headers,
   TLS, public-JS Supabase detection) — the PRD's own sequencing. The active engine (OSS scanners,
   AI exploit probes in a sandbox) is a later milestone, gated behind the two authorization checks
   and legal review of the active-scan ToS.

## Alternatives considered

- **A separate service.** Rejected: the whole value is that a scan account carries straight into
  Supahound (verified domain, connected project, finding→monitor mapping). A separate data model
  would make the integration an afterthought.
- **Verify by meta tag or file upload.** DNS TXT proves control of the domain itself, not just the
  current web host, and survives a host change. It is the classic choice and the strongest for an
  authorization record.
- **Trust a single resolver.** Rejected: a stale cache or split-horizon answer could pass a domain
  the user does not control. A quorum of resolvers is the mitigation.

## Consequences

- Apex extraction uses the public suffix list (`tldts`, new dependency in `@supahound/core`).
  Correct eTLD+1 parsing is a security boundary, not a convenience.
- The denylist is defence in depth behind DNS verification, and is meant to grow from config.
- Legal review of the active-scan ToS is still required before any active milestone ships (PRD,
  Open questions). This decision covers the funnel and passive checks only.
