# 026: The scan funnel's secrets scanner reads client code and probes a fixed list of leak paths

Amends [016](016-scan-funnel.md).

Date: 2026-11-10

## Context

The hackme.si funnel (decision 016) promises a free scan of a domain the user proves they own.
Credentials shipped to the public are the most common severe finding on a Supabase app: a
`service_role` key or an `sb_secret_` key in the browser bundle bypasses every RLS policy.

Decision 016 set milestone 1 to passive checks only, with legal review before any active scan.
Reading the pages and scripts a site serves is passive: a browser does the same. Requesting
`/.env` or `/.git/config` is not quite passive: the site never links those URLs.

Erik decided on 2026-11-10 (issue #74) that the secrets scanner also probes common leak paths.

## Decision

1. **Two entry points.** `scanClientCode` reads the page, each same-apex `<script src>` and each
   public source map. `probeLeakPaths` requests a fixed list of paths. The funnel calls them
   separately, so it can turn the probe off without a code change.
2. **What a probe may do.** One `GET` per path on the fixed list in `scan/secrets.ts`, on the
   verified host only. No other method, no query strings, no path guessing, no recursion. The probe
   never walks `.git/objects` or downloads a repository: that is exploitation, not detection.
3. **Scope on every request.** Every URL, including each redirect hop, each script and each source
   map, passes `assertInScope` before it is fetched. Redirects are followed by hand. A third-party
   script host (a CDN, analytics) is recorded as skipped and never fetched.
4. **A file must look like the file.** An SPA answers `200` with its HTML shell for any path. A
   leak path is a finding only when the body has the real file shape (`KEY=VALUE` lines for
   `.env`, `[core]` for `.git/config`) and is not HTML.
5. **Evidence never holds a secret.** A finding stores the rule id, the URL, a SHA-256 fingerprint
   and at most the last four characters. For an exposed `.env`, it stores the key names, never the
   values. The emailed report follows the same rule.
6. **Fixed limits.** Caps on bytes per response, scripts per page, redirects and time per request.
   Every request names the scanner in its User-Agent.

## Alternatives considered

- **Client code only.** The safest line under decision 016. Rejected by Erik: an exposed `.env` or
  `.git` directory is a frequent, severe leak that client code never shows.
- **A wordlist of hundreds of paths.** Rejected: that is directory brute-forcing, an active scan.
  The fixed list stays short and each entry names a file a JavaScript app commonly leaks.
- **A third-party scanner library.** Rejected: a new dependency, and most do not run on workerd. The
  rules are plain regular expressions in TypeScript.

## Consequences

- The leak-path probe goes past decision 016's "passive first" line. The scope agreement text in
  the funnel must name it. **Legal review should cover the probe before it ships to the public
  funnel** (`needs-erik` on #74); until then the funnel can call `scanClientCode` alone.
- A new rule needs a test that proves it can fail: a near miss that must not match.
- Test fixtures build fake keys at runtime, so the repo's gitleaks scan stays clean.
