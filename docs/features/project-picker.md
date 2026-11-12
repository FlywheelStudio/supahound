# Project picker

Issue #9. Decisions 022 and 023. Part of the web app ([wip/web-app.md](../wip/web-app.md)).

## What it does

After Connect Supabase, owners and admins open `/w/<tenant>/projects`. They see the Supabase
projects each connection can reach, tick the ones to watch, and remove watched ones. Members see
the watched list only. A new project shows "waiting for first poll" on the overview until the
poller runs.

## How it works

1. **Page** (`apps/web/app/w/[tenantId]/projects/page.tsx`). One `withTenantForUser` transaction
   reads the role, the watched projects and the connections. For owners and admins it also reads
   each connection's token with `accessTokenInTx` (it refreshes under the row lock when near
   expiry). The Management API calls run after the transaction commits. Members get no token, so
   their visit never calls Supabase.
2. **Client** (`packages/core/src/supabase/management.ts`). `GET /v1/projects` with the bearer
   token. zod parses each row. The ref comes from `ref`, else `id`, and must match
   `^[a-z0-9]{20}$`. Bad rows are dropped. `isPickable` allows only `ACTIVE_*` statuses (or none).
3. **Watch** (`watchProjectsAction` → `handleWatch` in `apps/web/lib/picker.ts`). The form is not
   trusted. The action:
   - checks the role, and checks that the connection belongs to the tenant;
   - lists the connection's projects again;
   - inserts only submitted refs that Supabase returned and reports as running, with Supabase's
     name;
   - re-checks the role in the insert transaction.

   `repo.watchProjects` uses `ON CONFLICT (tenant_id, supabase_ref)`, so a repeat submit adds
   nothing. A ref whose removal is scheduled is listed again, and picking it keeps the project
   (decision 042).
4. **Remove** (`removeProjectAction` → `removalOutcome`). `?remove=<id>` shows a red panel that
   states the dates before the user confirms. The user types the exact name. One transaction
   checks the role, finds the project in the tenant, compares the name and schedules the removal.
   Since decision 042 nothing is deleted at once: see
   [project-removal-grace.md](project-removal-grace.md). Audit rows stay with `project_id = null`
   when the data job deletes the project (decision 022).
5. **Errors.** A 401 or 403 from Supabase, or a failed token refresh, shows "Reconnect Supabase".
   Other failures show "try again". Neither returns a 500.

## Data model

No new table. `supahound.projects` already has `tenant_id`, forced RLS, the `(tenant_id, id)`
key, the `(tenant_id, connection_id)` foreign key and `UNIQUE (tenant_id, supabase_ref)`. Two
tenants can watch the same ref independently. Migration
`20261109000000_audit_log_keep_on_project_delete.sql` sets the audit log's project foreign key to
`ON DELETE SET NULL (project_id)`.

## External services

- **Supabase Management API**, `GET /v1/projects`. The OAuth app needs the scope **`projects:read`**,
  in addition to `analytics:read` and `database:read` (decision 023; setup step 0 in
  `wip/web-app.md`, issue #4). Public copy and the privacy policy name all three scopes.
- `SUPABASE_API_URL` (Worker var, default `https://api.supabase.com`). Only E2E changes it.

## Testing

- `packages/core/test/management.test.ts` (16): URL and token, 401/403 → reconnect, 5xx,
  `ref`/`id`, bad rows dropped, names trimmed and capped, `isPickable`.
- `packages/core/test/db/projects.test.ts` (6, Postgres): repeat picks add nothing; two tenants
  share a ref; another tenant's connection is refused by the foreign key; removal deletes poll
  runs and keeps audit rows; a removal from another tenant does nothing; `accessTokenInTx`
  inside a membership transaction.
- `apps/web/test/picker.test.ts` (19): forged and inactive refs never insert; a member is refused
  before any Supabase call; a role lost between transactions; reconnect paths; exact-name removal.
- E2E `apps/web/e2e/specs/picker.uat.spec.ts`: UAT-W11 to UAT-W15, against
  `e2e/support/fakeManagement.ts`.
- Mutation checks: without the migration, the audit-row test fails. Inserting submitted refs
  without the Supabase filter fails UAT-W12. Ignoring the typed name fails UAT-W14.

## Gotchas

- New projects have empty ownership until #10 loads RLS policies. Detector 2 finds nothing for
  them until then.
- Picking is unlimited until plans exist (#25).
- The Coming-soon registry (`content/features.ts`, now in the private repo `FlywheelStudio/supahound-site`, decision 025) keeps `supabaseConnect` at `soon` until the OAuth app (#4) exists.
- `page.route` cannot stub server-side calls. E2E reaches the fake through `SUPABASE_API_URL`.
