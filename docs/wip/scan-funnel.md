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

## Status — 2026-11-10: secrets scanner (#74, decision 026)

Erik asked for a secrets scanner and chose to probe leak paths as well as client code (decision 026).

- Done:
  - `packages/core/src/scan/fetch.ts` — `scopedGet`, the only way `scan/` reads a target. Every URL
    and every redirect hop passes the scope guard. Redirects are followed by hand. It accepts http(s)
    on the default port only, with no credentials in the URL. It caps bytes, redirects and time, and
    sends a named User-Agent. #51's header and TLS checks should use it too.
  - `packages/core/src/scan/secrets.ts`:
    - `scanClientCode`: the page, its same-apex `<script src>` and script preloads, chunk paths
      named in the code (Vite relative imports, Next.js `static/chunks/`), and public source maps.
      Third-party script hosts are recorded as skipped, never fetched.
    - `probeLeakPaths`: one GET each for the fixed list (`.env` x5, `.npmrc`, `.git/config`,
      `.git/HEAD`, `.aws/credentials`). A response is a finding only when it is a 200 at the same
      path, is not HTML, and has the file's shape.
    - 16 prefix-anchored rules. A JWT is a finding only with `role: service_role`; its project ref
      goes into the evidence.
    - Output rows match `scan_findings` (`severity`, `type`, `endpoint`, `evidence`, `fix`,
      `supahoundMonitor`). Supabase key findings map to the `service_role_misuse` monitor.
  - Evidence holds the rule id, a 12-hex SHA-256 fingerprint, the last 4 characters, the offset and
    an occurrence count. An exposed `.env` gives key names only. Endpoints drop query strings.
  - Tests: `test/scanSecrets.test.ts`, 86 tests. Every rule has a positive sample and a near miss.
    Fake keys come from a seeded generator, so gitleaks stays clean (local `gitleaks dir`: no leaks).
    Mutations are on record in TESTING.md.
- Problems solved: the first test generator multiplied past 2^53, so its low bits collapsed and the
  "random" hex had too few symbols. It now uses `Math.imul`. The placeholder check reads the last 16
  characters, so a fixed prefix such as `sk_live_` cannot add variety to a fake key.
- Known gaps: chunks that webpack builds from a runtime map (no literal path) are not found. Base64
  inline source maps are not decoded. The scanner does not read `SourceMap` response headers.
- Next: #51 wires `scanClientCode` (and `probeLeakPaths` once legal review clears it) into the scan
  job and the report.

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
  for now. Legal review should also cover the leak-path probe (decision 026) before the public funnel
  calls it. The scope agreement text must name it.
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
