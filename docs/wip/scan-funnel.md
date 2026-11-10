# WIP: Scan funnel (hackme.si)

Build the free AI pentest funnel into Supahound as a lead-gen front door (decision 016). The scan
is the one-time snapshot; Supahound is the always-on version. The spec is the hackme.si PRD, a private Flywheel document.

## Status — 2026-11-08

Built the **authorization backbone**: the part every active scan rests on, and the part that is
purely defensive. Nothing active runs until a domain is proven-owned and scope-locked.

- Done:
  - Data model migration `supabase/migrations/20261108000000_scan_funnel.sql` — `scan_domains`,
    `scan_authorizations` (append-only), `scans`, `scan_findings`, `scan_jobs`. Every table carries
    `tenant_id`, forced RLS, the tenant-isolation policy, and `(tenant_id, id)` FKs.
  - `packages/core/src/scan/scope.ts` — registrable-apex extraction (public suffix list),
    sensitive-target denylist (gov/mil/platforms), and the in-scope check the engine will call on
    every target.
  - `packages/core/src/scan/verify.ts` — single-use challenge token, multi-resolver DoH TXT lookup
    with a quorum rule, constant-time match, structured audit trail.
  - Branded `DomainId`, `ScanId`, `ScanFindingId` in `tenancy/scope.ts`.
  - Tests: `scanScope.test.ts`, `scanVerify.test.ts`, and the new tables wired into
    `db/isolation.test.ts`. Full core suite: 283 pass (Postgres cluster ran). Typecheck + lint clean.
  - New dependency: `tldts` in `@supahound/core`.

- **Next step (MVP milestone 1 — funnel + passive):**
  1. Core repositories for the scan tables (`createDomain`, `recordVerification`, `saveAuthorization`,
     `createScan`, `insertScanFindings`, queue claim) in `packages/core/src/db/`, in the
     `withTenantForUser` style, plus their db tests.
  2. Passive checks module `packages/core/src/scan/passive.ts` — security headers, TLS, and
     Supabase detection from public client JS and network calls. Non-exploitative reads only.
  3. Web funnel in `apps/web/app/` — URL input, verification UI (show the TXT record, poll Verify),
     clickwrap scope/ToS acceptance, email gate, on-page score + teaser, emailed full report.
     Reuse the existing auth, `withPool`, and email helpers.
  4. Finding→Supahound monitor mapping and trial pre-fill (verified domain carries over).

- Blockers / open: see below. Nothing blocks the next code step.

## Approach

- **Two gates, both in code.** Verification (`verify.ts`) proves control; scope (`scope.ts`) proves
  the target is inside the verified apex and not a protected class. The engine must call
  `assertInScope` on every target; it never scans on a false return it forgot to check.
- **Verification quorum.** Read TXT over Cloudflare and Google DoH (extensible). Verified only when
  a strict majority agree, never fewer than two; a resolver error counts as disagreement. This
  defeats stale caches and split-horizon answers.
- **Shared tenancy.** Scan tables are ordinary Supahound tenant tables, so the isolation test covers
  them automatically. The app reaches them only through tenant-scoped transactions.
- **Passive first.** The active engine (OSS scanners + AI probes in a sandbox) is a later milestone,
  gated behind both authorization checks and legal review.

## Open questions & risks

- **Legal review of the active-scan ToS** before any active milestone (PRD). Backbone + passive only
  for now.
- **Account vs. email-first entry.** PRD wants a light "enter URL + email" start, but shared tenancy
  needs a tenant. Decide whether the funnel signs the user in (magic link) up front or binds the
  scan to a provisional tenant. Current model assumes a tenant exists (reuses `withTenantForUser`).
- **Free-scan limit scope** — per account vs. per domain; automated cadence per tier; whether
  Advanced (Supabase-connected) mode is itself gated behind a subscription.
- **Sandbox choice** for the active engine — must match Supahound's infra and run OSS tools safely.
- **Report quality bar** — AI findings must be accurate; false positives destroy trust. Needs a
  validation/confidence step (the explainer's validator pattern is a precedent).

## Definition of done (feature)

Working code + passing lint/typecheck; tests for each module and gotcha; `docs/features/scan-funnel.md`
written; this WIP doc deleted; STATE.md → Completed; INDEX.md updated.
