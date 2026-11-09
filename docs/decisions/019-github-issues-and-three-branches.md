# 019 — GitHub issues hold the work; three branches

Date: 2026-11-09. Status: accepted (Erik).

## Context

The backlog lived in `STATE.md`, and nothing checked a PR before merge. Several Claude sessions
work on the repo at once. Two of them shared one checkout, and their commits landed on each other's
branches. Stale branches stayed open.

## Decision

- **GitHub issues are the backlog.** Each piece of work has an issue with acceptance criteria, labels
  and a milestone. Milestones are the PRD roadmap phases. Each PR must close an issue: the "PR
  hygiene" check fails otherwise.
- **`STATE.md` keeps only In progress and Completed,** with issue numbers. The backlog is not
  stored twice.
- **Three branches:** one `feature/*` (or `fix/*`), `develop` and `main` (production). Feature PRs
  target `develop`. Only `develop` merges into `main`. Every branch ends merged or deleted.
- **Check branches before new work.** If the work belongs on an open branch, do it there.
- **One git worktree per session.** No two sessions share a checkout.
- **CI gates merges:** typecheck, lint, every Vitest suite with Postgres (never skipped), build,
  and E2E + UAT.
- **No auto-deploys yet.** Production deploys stay manual and need approval.
- **No new services without asking.** The Claude GitHub Action and Dependabot were approved on
  2026-11-09.

## Alternatives considered

- Keep the backlog in `STATE.md`. Rejected: nothing links a commit to the work item, and CI cannot
  enforce it.
- Trunk-based on `main` only. Rejected by Erik: `develop` is the integration branch before production.
- A GitHub Projects board as the source of truth. Kept as a view over the issues, not a second list.

## Consequences

- `docs/WORKFLOW.md` describes the loop. `CLAUDE.md` points to it.
- `develop` is the default branch, so `Closes #n` closes issues on merge, and the Claude Action and
  Dependabot run from `develop`.
- Branch protection on `develop` and `main`: PR required, the three CI checks required, no approval
  (Erik is the only reviewer), no force pushes or deletion, admins included. Approved 2026-11-09.
- Decision numbers 016–018 are taken by open branches (scan funnel, marketing site). If those
  merge in another order, the numbers stay as they are; no renumbering.
