# WIP: one Stripe subscription per project (#99)

Decisions [032](../decisions/032-subscription-per-project.md) (spec) and
[041](../decisions/041-project-subscriptions-build.md) (how). Branch `feature/project-subscriptions`.
Erik approved the build; the production rollout waits for his separate approval.

## Goal

Each watched project bills on its own Stripe subscription at its tier. The workspace keeps one
Stripe customer, the validated card and one 7-day trial. Existing seat subscriptions move to
project subscriptions with an operator CLI, with no double charge.

## Approach

- Migration `20261112050000_project_subscriptions.sql` (additive, no DROP): `billing_accounts.billing_model`
  (`workspace` default, `project`), table `project_subscriptions` (payment history, never deleted).
- `packages/core/src/billing/projects.ts`: pure rules (trial for a new project, workspace standing,
  the reconcile plan, the conversion plan).
- `packages/core/src/billing/flow.ts`: `syncBilling` routes by model; `reconcileProjects` makes
  Stripe match the watched projects; webhook routes events by subscription ID.
- `packages/core/src/billing/convert.ts` + `pnpm convert-subscriptions` (dry run default, `--apply`).
- Web: Project Settings → Plan & billing (status, next charge, invoices, portal), workspace billing summary.
- Fake Stripe: anchor/trial on create, list, price change, invoices, customer update.

## Files expected to change

Migration; `packages/core/src/{billing,db,datacontrols}`; `packages/core/src/cli.ts`;
`apps/web/app/w/[tenantId]/{billing,p/[projectId]/settings/plan,projects,settings}`; `apps/web/lib/billing.ts`;
`apps/poller/src/index.ts`; `apps/web/e2e/**`; docs.

## Build log

- 2026-11-12: decision numbers 039 and 040 are taken by open branches, so this is 041. UATs W45+, B15+.
