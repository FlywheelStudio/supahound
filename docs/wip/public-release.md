# WIP: Public release (fair source under FSL-1.1-ALv2)

Decision 025. Milestone "Public release", issues #63–#68.

## Status — 2026-11-10

- Merged 2026-11-10: #61, #62, then PR #69: leak audit (#63), site split (#64), self-hosting
  (#65), public files (#66). On `develop`: core 352, web 68, poller 9 tests, 27 E2E, CI green.
- The private site repo exists: `FlywheelStudio/supahound-site` (main, CI green). It holds #61's
  content edits.
- **Public since 2026-11-10 (#68).** Erik chose to publish before the legal review. Secret scanning
  with push protection, private vulnerability reporting and the ruleset "develop and main" are on.
  UAT-W14 flake fixed (#70).
- **Next step:** legal review of `CLA.md` and `LICENSE.md`, then the rehearsal (#67). `main` gets
  the release through PR #77 (Erik merges `main`).

## Remaining

1. **Rehearsal (#67).** Follow `docs/self-hosting.md` on clean Cloudflare and Supabase accounts. It
   is blocked on the OAuth app (#4) and a live database (#8). Settle the four items under "Not
   verified yet" in the guide.
2. **Legal review.** `CLA.md` is not a vetted template. `LICENSE.md` is the FSL template with the
   licensor filled in.
3. **Never `@claude` on an outsider's issue or PR.**
4. **Deploy the app** to `app.supahound.com` (needs #4 and #8). The marketing site is live on
   `supahound.com` and `www.supahound.com` since 2026-11-10; its sign-up links point at the app and
   fail until the app ships.

## Build log

- gitleaks default rules missed 2 of 3 planted secrets (a Postgres URL and an AWS-shaped key).
  `.gitleaks.toml` adds 7 rules; each was proven on a planted secret.
- gitleaks skips merge commits by default; a `git log --merges --cc` grep covered them.
- The 87 Claude workflow runs have logs that become public with the repo. #68 deletes them first.
- UAT-W14 (#61) failed once in 11 runs under parallel load on the trial merge; it looks like a
  pre-existing flake.
- `login-users.sql` first failed as a non-superuser: Supabase's `postgres` may not name
  NOSUPERUSER or NOBYPASSRLS in `ALTER ROLE`. The rerun path now changes only the password and
  refuses an existing user with elevated attributes.
- `claude.yml` now refuses fork PRs and outsider-authored issues, not only outsider commenters.
