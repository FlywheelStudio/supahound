# 025: Publish the repo under FSL-1.1-ALv2; the marketing site moves to a private repo

Date: 2026-11-10 · Issues #63–#68 (milestone "Public release")

## Context

Erik wants anyone to be able to run Supahound with their own accounts and keys. Flywheel keeps
selling a hosted Supahound with its own paid plans (decision 013). Erik's terms, 2026-11-10:

- Anyone may self-host.
- Nobody may host it as a commercial service or make money from hosting it.
- One repo is cleaner than two going forward.
- The scan funnel (decision 016) ships with the rest of the code.
- The marketing site and legal pages go to their own private repo.
- Contributor terms: use what is normal.

## Decision

1. **License: FSL-1.1-ALv2** (Functional Source License, Apache 2.0 future license), licensor
   Flywheel Studio LLC.
   - Any use is allowed except a *Competing Use*: "making the Software available to others in a
     commercial product or service" that substitutes for Supahound or for a Flywheel product built
     on it, or offers substantially similar functionality.
   - Internal use and professional services to a licensee are allowed. A company that runs
     Supahound on its own apps is fine. An agency that sells a Supahound dashboard to its clients
     is a Competing Use.
   - Each version becomes Apache-2.0 two years after it is published.
   - The repo calls itself *fair source*, never *open source*: FSL is not an OSI license.
2. **One repo.** This repo (`FlywheelStudio/supahound`) becomes public after the leak audit (#63).
   Its history, issues and PRs stay. No second public repo, no history rewrite.
3. **Contributor terms: a short CLA** (contributor license agreement), checked by a GitHub Action
   that stores signatures in the repo (`.github/cla/`). Under FSL a contributor keeps the copyright
   on their code; without a grant, Flywheel's hosted service running that code could itself be a
   Competing Use. Source-available projects that sell a hosted version (for example n8n) use a
   CLA. A DCO sign-off is the norm for Apache and MIT community projects, not this case.
4. **The marketing site moves to the private repo `FlywheelStudio/supahound-site`** (#64): the
   marketing and legal pages, their content, the SEO files, `llms.txt`, robots, sitemap and their
   tests. It serves `supahound.com`. The app serves `app.supahound.com` and keeps only a small
   brand config (name, support email, optional terms and privacy URLs), so a self-hosted copy
   shows no Flywheel terms. Supersedes the "lives in the web app" part of decision 017.
5. **The scan funnel ships.** The DNS-TXT authorization and scope guard are in the public code.
   The active-scan engine stays unbuilt until its legal review is done (decision 016). The
   self-hosting guide says that whoever runs a copy owns the legal risk of its scans.
6. **Self-hosting needs no Flywheel account** (#65). Every key and ID is the self-hoster's own:
   their Supabase project, their Supabase OAuth app, their Cloudflare account, their master keys.
   The model key is optional; without it alerts use template text. Billing (Stripe, #25) is
   hosted-only and off unless configured.
7. **Before the repo goes public** (#68, Erik approves the exact steps): delete the Claude
   workflow run logs, then change visibility, then turn on branch protection, secret-scanning
   push protection and private vulnerability reporting.

## Alternatives considered

- **AGPL-3.0.** OSI open source, but it allows commercial hosting as long as the host publishes
  its changes. It does not meet "nobody may make money from hosting it".
- **Elastic License 2.0.** Same hosting ban, but it never converts to an open license. FSL's
  two-year conversion costs little, because the hosted product runs the newest code.
- **BSL 1.1.** Needs a custom "additional use grant" per project and a change date of up to four
  years. FSL is BSL with those choices made and tested by others.
- **PolyForm Noncommercial.** Forbids every commercial use, including a company monitoring its own
  app. Too strict for the people Supahound is for.
- **A fresh public repo from one cleaned commit.** Hides the history, issues and PRs, but splits
  the project across two repos. The audit (#63) found nothing in them that needs hiding.
- **DCO instead of a CLA.** Lighter for contributors, but gives Flywheel no license to run
  contributed code in the hosted service under FSL.

## Consequences

- Leak audit (#63), 2026-11-10: gitleaks 8.30.1 with `.gitleaks.toml` (defaults plus seven
  Supabase, Postgres, Stripe, Vercel and master-key rules) over all 76 commits and every ref,
  merge resolutions included: no findings. Each custom rule was proven on a planted secret first.
  The issue, PR, comment and review text (68 issues and PRs) also scanned clean. The Actions secrets are
  `CLAUDE_CODE_OAUTH_TOKEN` only.
- CI runs the same gitleaks scan on every push and PR.
- Decision records keep their wording, including quotes from Erik. Records are never rewritten
  (workspace rule); later records supersede them.
- The PRD is a private Flywheel document. Public docs no longer link to it; the decision records
  and `docs/ARCHITECTURE.md` are the public spec.
- Branch protection becomes possible (public repos on GitHub Free). Decision 019 and `WORKFLOW.md`
  change when #68 is done.
- A license change later needs the CLA, which every outside contribution has signed.
