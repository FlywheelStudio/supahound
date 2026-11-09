Closes #

## What changed and why

## How it was tested

## Definition of done

- [ ] `pnpm typecheck` and `pnpm lint` pass
- [ ] `pnpm -r test` passes (the Postgres suites ran, not skipped)
- [ ] `pnpm e2e` passes, if `apps/web` changed
- [ ] New behaviour has tests: unit, Postgres, E2E or UAT
- [ ] Docs updated in this PR: STATE.md, INDEX.md, feature doc or decision record
- [ ] No real log rows, secrets or `.env` values in the diff
- [ ] New tables: `tenant_id`, forced RLS, `(tenant_id, id)` foreign key
- [ ] Model calls only through `packages/core/src/explainer/llm.ts`
