# WIP: Public release (fair source under FSL-1.1-ALv2)

Decision 025. Milestone "Public release", issues #63–#68.

## Status — 2026-11-10

- Done in PR #69: leak audit (#63), site split (#64), self-hosting (#65), public files (#66).
- The private site repo exists: `FlywheelStudio/supahound-site` (main, CI on push).
- **Next step:** Erik merges #61 and #62, then #69 (after `develop` is merged into it; the conflicts
  are listed in the PR). Then the rehearsal (#67) and the publish (#68).

## Remaining

1. **Rehearsal (#67).** Follow `docs/self-hosting.md` on clean Cloudflare and Supabase accounts. It
   is blocked on the OAuth app (#4) and a live database (#8). Settle the four items under "Not
   verified yet" in the guide.
2. **Legal review.** `CLA.md` is not a vetted template. `LICENSE.md` is the FSL template with the
   licensor filled in.
3. **Publish (#68).** Irreversible; Erik approves the exact steps in the issue first.
   Never `@claude` on an outsider's issue or PR.
4. **After publish:** branch protection on `develop` and `main` (update `WORKFLOW.md` and decision
   019), secret-scanning push protection, private vulnerability reporting. Deploy the site to
   `supahound.com` and the app to `app.supahound.com`; production deploys need approval.

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
