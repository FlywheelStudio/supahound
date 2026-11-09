# Workflow

Updated 2026-11-09. Decision 019. All work runs through GitHub issues.

## Branches

Three long-lived kinds, and no more:

| Branch | Role | Who merges |
| --- | --- | --- |
| `main` | Production. Only `develop` merges here | Erik |
| `develop` | Integration. Every feature PR targets it | PR after green CI |
| `feature/<slug>` or `fix/<slug>` | The one active piece of work | Its author, through a PR |

- Before you start new work, run `git fetch && git branch -a`. If the work belongs on an open
  branch, do it there.
- Every branch ends merged or deleted. Leave no unpushed commits and no stale branches.
- Each Claude session works in its own git worktree, so two sessions never share a checkout:
  `git worktree add ../supahound-<slug> -b feature/<slug> origin/develop`.
- No auto-deploys yet. Both `develop` and `main` run CI only. Production deploys stay manual and
  need Erik's approval.

## The loop

1. **Issue.** Pick an open issue, or open one with a template (feature, bug, UAT scenario,
   decision). Give it acceptance criteria, labels and a milestone.
2. **Branch.** `feature/<slug>` from `develop`.
3. **WIP doc.** `docs/wip/<slug>.md` with the goal, approach and files expected to change. Add the
   item to In progress in `STATE.md`, with the issue number.
4. **Build.** Write tests with the code. Prove each new check can fail (`docs/TESTING.md`).
5. **PR into `develop`.** The description says `Closes #<n>`. The "PR hygiene" check fails without
   it. Fill in the template's definition-of-done list.
6. **CI green.** Typecheck, lint, all Vitest suites (Postgres included), build, E2E + UAT.
7. **Merge.** Then delete the branch. GitHub closes the issue, because `develop` is the default branch.
8. **Done.** Write the feature doc, delete the WIP doc, move the item to Completed in `STATE.md`.

`develop` is the default branch (since 2026-11-09). GitHub runs `claude.yml` and reads
`dependabot.yml` from it. Branch protection on `develop` and `main` requires a PR and green CI
(the three checks above). No approval is required, and force pushes and deletion are blocked.

## Labels

| Group | Labels |
| --- | --- |
| Type | `type:feature`, `type:bug`, `type:chore`, `type:docs`, `type:decision`, `type:uat`, `type:research` |
| Area | `area:core`, `area:detectors`, `area:incidents`, `area:poller`, `area:web`, `area:db`, `area:posture`, `area:alerts`, `area:billing`, `area:infra` |
| Priority | `priority:p0` (blocks the milestone gate), `priority:p1`, `priority:p2` |
| State | `blocked` (waits outside the repo), `needs-erik` (an account, key, decision or access) |
| Automation | `claude` (hands the issue to the Claude GitHub Action) |

The labeler workflow adds `area:*` labels to PRs from the paths they change.

## Milestones

One per roadmap phase: Validate, Dogfood V1, Private beta, Paid launch. See [ROADMAP.md](ROADMAP.md).

## Automation

| Workflow | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | PR, push to `develop` or `main` | Typecheck, lint, tests, build; E2E + UAT job |
| `pr-hygiene.yml` | PR opened or edited | Fails if the PR does not close an issue |
| `labeler.yml` | PR | Adds `area:*` labels by path |
| `claude.yml` | `@claude` in an issue or PR, or the `claude` label | Claude Code works the issue and opens a PR into `develop` |
| `dependabot.yml` | Weekly / monthly | Dependency update PRs (`type:chore`) |

Only owners, members and collaborators can start the Claude workflow. It needs the
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` repository secret (`/install-github-app` sets it up).

## Services

Never add a new service without Erik's approval. Stay on the stack in the decision records:
Cloudflare Workers, Queues, Hyperdrive and Email; Supabase Postgres and Auth; Stripe; Vercel AI Gateway.
