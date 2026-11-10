# 027: Flywheel's hosted deploy config lives in a private repo

Date: 2026-11-10

## Context

The repo is public (decision 025). Its two `wrangler.jsonc` files are the templates that
self-hosters fill in. Flywheel's hosted deploy on app.supahound.com needs real values in the same
files: Hyperdrive IDs, the OAuth client ID, the Supabase URL and publishable key, the sending
address and the custom domain. None of these is a secret. Committed to the public files, they
would turn the templates into Flywheel's config and publish internal infrastructure IDs.

Erik decided on 2026-11-10 to keep the production config out of the public repo.

## Decision

1. **A private repo holds the production config.** It has a production `wrangler.jsonc` per
   Worker, the Supabase Auth settings, the deploy scripts and the runbook.
2. **The public `wrangler.jsonc` files stay templates.** Placeholders only. Self-hosters edit
   their own copies, as `docs/self-hosting.md` says.
3. **Deploys run from a fresh clone.** The deploy script clones this repo at a branch, copies the
   production configs over the templates in that clone only, builds, and deploys. No checkout that
   a person or a session works in ever holds production values.
4. **Secrets go in no repo.** Database passwords, master keys, the hook secret and the OAuth
   client secret live in a git-ignored folder and the password manager. They upload with each
   deploy (`wrangler deploy --secrets-file`), so a Worker never runs without them.
5. **Database passwords never reach a tool transcript.** The login users get SCRAM-SHA-256
   verifiers made on the operator's machine, not plaintext passwords.

## Alternatives considered

- **Wrangler environments in the public files (`env.production`).** One file, but the real values
  become public and every self-hoster reads Flywheel's config.
- **A git-ignored folder inside this repo.** Simple, but nothing backs it up, and new git
  worktrees do not contain it. Each session works in its own worktree (decision 019).
- **A plain folder outside any repo.** Never committed anywhere, and lost with the laptop.

## Consequences

- A change to a public `wrangler.jsonc` (a new binding or var) needs the same change in the
  private configs before the next deploy. The private runbook says so.
- `docs/self-hosting.md` stays the single public guide. Flywheel's deploy follows it.
