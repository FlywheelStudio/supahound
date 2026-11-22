# 046: The scan lists what a site's anon key exposes, with one GET to the project's PostgREST root

Amends [016](016-scan-funnel.md) and [026](026-scan-secrets-leak-paths.md). Shown on the tab of
[034](034-scan-domains-per-project.md) and [040](040-scan-domain-links.md).

Date: 2026-11-22 · Issue #139

## Context

The secrets scanner (decision 026) reads a verified site's client code. A Supabase app ships its
project URL and anon key there by design, so the scanner reports nothing for them. The question
that matters is what that key can reach: every table, view and function the `anon` role has a
grant on is open through the Data API, and RLS is the only thing between it and the rows.
PostgREST's root (`https://<ref>.supabase.co/rest/v1/`) answers with an OpenAPI description that
lists those names, without reading a row.

The Supabase project host is not the verified apex, so the scope guard of decision 016 refuses it.
Erik decided on 2026-11-22 to build the check, scoped as below. Legal review was recommended before
it reaches the public funnel.

## Decision

1. **One more host in scope, and only one URL on it.** `https://<ref>.supabase.co/rest/v1/`
   exactly, where `<ref>` is 20 lowercase letters or digits and the verified site's own client code
   (the page, its same-apex scripts and source maps, all read through `scopedGet`) names
   `https://<ref>.supabase.co`. No other path, query, port, Supabase host (`supabase.com`,
   `*.supabase.in`, custom domains, subdomains of the project host) or trailing dot. The rule is
   `supabaseHostInScope` in `scan/scope.ts`; the URL check is `supabaseRestRootUrl` in
   `scan/fetch.ts`.
2. **Only the key the site ships for that project.** The check runs only when the same code holds
   an anon JWT (`role: "anon"`) whose `ref` claim is that project. A key for another project, a
   key without a ref, a `service_role` key or a publishable key is never sent. No other key is
   tried.
3. **One GET per project, at most two projects per scan.** `supabaseRestRootGet` sends `apikey` and
   `Authorization: Bearer` with the anon key, follows no redirect, and keeps `scopedGet`'s caps on
   bytes and time. No HEAD, no `Prefer: count`, no row read, no RPC call.
4. **Evidence is names and counts.** Table and view names (`/name`) and function names
   (`/rpc/name`), each through `safeName`, at most 100 listed per kind, with full counts and a
   count of dropped names. Column definitions are not read into the finding. The key itself is
   never stored: the finding holds its 12-hex fingerprint and last four characters, as a secret
   finding does.
5. **One finding.** Type `anon-key-exposure:openapi`, endpoint the PostgREST root, monitor
   `exposed_read`. Severity medium when tables or views are listed, low when only functions are.
   Nothing listed, a 401 or 403, a malformed or oversized document, or a failed request is no
   finding; the outcome is returned for the scan's audit trail.
6. **A separate entry point, off until the funnel calls it.** `scanClientCodeWithAnonExposure`
   (`scan/supabaseExposure.ts`) runs the secrets scan and then the check. `scanClientCode` alone
   never contacts Supabase. The funnel (#51) is not wired yet; when it is, it calls
   `scanClientCode` until legal review clears this check, then switches to the new entry point.
   There is no runtime flag to flip by mistake.
7. **The Security scan tab** shows the counts and names through the evidence allowlist, the fix
   (RLS and policies for tables the app reads, revoke anon grants on the rest, `security_invoker`
   views, revoke anon EXECUTE on functions), and a link to the Posture tab of the watched project
   with the same ref, or to Projects to connect it.

## Alternatives considered

- **One `HEAD ... Prefer: count=exact` per table** (the issue's optional step). Rejected for now: it
  touches data. A later decision can add it after legal review.
- **Any host the site's code names.** Rejected: a page could then point the scanner at any API.
  The rule names one product's host shape and one path.
- **Try the publishable key, or several keys.** Rejected: a publishable key carries no project ref,
  so it cannot be bound to the URL. The anon JWT is bound by its `ref` claim.
- **Report every project URL, probe none.** Rejected by Erik: the names are the useful part.

## Consequences

- The scan's request list now reaches a host outside the verified apex. The scope agreement text
  must name it, and **legal review should cover it before the public funnel calls it**.
- Apps on the new key model (publishable keys only) get no exposure finding. A later change can
  bind a publishable key to a project another way.
- `scopedGet` and `supabaseRestRootGet` share one request loop (`guardedGet`), so a fix to the caps
  covers both.
