# People and roles per project

Issue #24. Decisions 033 (scope) and 036 (how). Migration `20261112000000_project_people.sql`.

## What it does

Each project has people, each with one role: Owner, Admin, Editor or Viewer. Project Settings →
People (`/w/<tenant>/p/<project>/settings/people`) lists them. Owners and admins invite people by
email to that one project, and resend, cancel, change roles and remove people there. The invitee
gets an email, signs in with a magic link, presses Accept and lands on the project. A person sees
only the projects they have a role on: in the dropdown, on the overview, and by URL (404).

| Action | Owner | Admin | Editor | Viewer |
| --- | --- | --- | --- | --- |
| See the project, its incidents, settings and people | Yes | Yes | Yes | Yes |
| Change project settings (email alert threshold) | Yes | Yes | Yes | No |
| Invite, resend, cancel; change roles; remove people | Yes | Yes, not Owners | No | No |
| Grant, change or remove the Owner role | Yes | No | No | No |
| Remove the project | Yes | Workspace admins only | No | No |

Workspace owners and admins are Owner and Admin on every project, with no rows. Workspace-level
actions (connect Supabase, add projects, billing) still use the workspace role.

## How it works

- **Role in SQL.** `supahound.project_role(project)` returns the signed-in user's effective role,
  or NULL when the project is not in the tenant or the user has no role. `listProjects` returns it
  per project (`ProjectSummary.role`); `people.projectRole(tx, project)` reads it for one.
- **RLS.** A RESTRICTIVE SELECT policy `project_access` on `projects`, `service_role_networks`,
  `poll_runs`, `incidents`, `findings`, `project_usage` and `audit_log` hides a project's rows from
  a signed-in user (`app.user_id` set) without a role. Transactions without a user (poller, billing
  sync, Stripe webhook, invite acceptance) see the whole tenant. Write policies: `project_settings`
  (UPDATE projects: editor and up), `project_remove` (DELETE projects: project Owner or workspace
  owner/admin), `people_insert/update/delete` on `project_members` and `project_invites` (owner and
  admin; only an owner touches the `owner` role), `invites_read` (owners and admins).
- **Core:** `packages/core/src/db/people.ts`: roles, invite tokens, `listPeople`, `listInvites`,
  `createInvite` (renews an open invite to the same address), `renewInvite` (60-second cooldown),
  `cancelInvite`, `setPersonRole`, `removePerson`, `previewInvite`, `acceptInvite`.
- **Web rules:** `apps/web/lib/people.ts` (pure): the matrix (`can`, `canRemoveProject`,
  `assignableRoles`, `canManagePerson`), form parsing, notices, `handleInvite`.
- **Gate:** `lib/projectPage.ts` `paidProject(...)`: the paid gate, then the project role in the
  same transaction; no role → `NotAMemberError` → 404. `loadProjectPage` 404s when the role is null.
- **Actions:** `app/w/[tenantId]/p/[projectId]/settings/people/actions.ts` (invite, resend, cancel,
  set role, remove). Each checks the matrix inside its transaction. Emails go out after commit.
- **Invite page:** `app/invite/page.tsx` (GET: preview only; never writes) and `actions.ts`
  (POST: `acceptInvite`). A signed-out visitor goes to `/login?next=...`; the login action stores
  `next` in the httpOnly cookie `supahound_next` (1 hour) and `/auth/confirm` reads and clears it.
- **Email:** `lib/email/invite.ts` renders it (escaped, capped, one link); the Worker's `EMAIL`
  binding sends it.
- **Alerts:** `repo.alertRecipients(tx, project)` returns workspace owners and admins and the
  project's people. The poller calls it per project.

## Data model and RLS

- `project_members (tenant_id, project_id, user_id, role)`: PK `(tenant_id, project_id, user_id)`. FKs:
  `(tenant_id, project_id) → projects` and `(tenant_id, user_id) → memberships`, both cascade.
- `project_invites`: `email` (lower case), `role`, `token_hash` (SHA-256 hex, unique),
  `invited_by`, `sent_at`, `expires_at`, `accepted_at/accepted_by`, `canceled_at`. One open invite
  per address per project (partial unique index). FK `(tenant_id, project_id) → projects`, cascade.
- Both: `tenant_id`, forced RLS, `tenant_isolation` policy, grants to `supahound_app` only.
- Backfill: every workspace `member` gets `viewer` on every project of its workspace. It is safe to
  run again; see Gotchas before you do.

## External services

None new. The invite email uses the web Worker's Cloudflare Email binding and `EMAIL_FROM_ADDRESS`.

## Testing

- Postgres, `packages/core/test/db/people.test.ts` (29): visibility per role on every project
  table, no-user transactions see all, workspace-wide audit rows, another tenant's project, the
  effective role, settings and remove writes per role, people and invite writes per role (viewer,
  editor, admin vs Owner), invites hidden from editors and viewers, cross-tenant writes, hash-only
  storage, accept once, wrong email, expiry, cancel, renew and resend (old link dead, cooldown),
  already a member, tenant-bound and malformed tokens, no role lowering, billing exemption kept,
  leaving the workspace with the last role, the people list, alert recipients per project.
- Postgres, `peopleBackfill.test.ts` (3): the backfill on a database with data, the roles decision
  033 promised, a second run changes nothing, a re-run covers a project added in between.
- `isolation.test.ts` lists both new tables; `alerts.test.ts` and `users.test.ts` fixtures give
  members a project role.
- Web unit, `apps/web/test/people.test.ts` (20): the matrix, parsing, paths, `handleInvite`, the email.
- E2E, `apps/web/e2e/specs/people.uat.spec.ts`: UAT-W26 (invite → signed-out link → sign in →
  accept → only that project; other project 404; link works once), UAT-W27 (a viewer and a
  replayed owner form refused; an admin cannot invite an Owner), UAT-W28 (wrong address, resend
  kills the old link, expiry, cancel; a non-member 404). The spec reads the real invite email from
  the wrangler log (`e2e/support/mail.ts`).
- Mutation checks (14, all red, then restored): docs/TESTING.md.
- Old code on the new schema (the migration alone, before any app change): core 553 of 556 and
  E2E 47 of 50 green. The six reds were the isolation test's table list and fixtures that add a
  workspace `member` after the migration (`users.test.ts` 2, UAT-W13, W18, W22). The old code
  writes no such row in production: only `createWorkspace` writes memberships, always `owner`.

## Gotchas

- **Re-running the backfill.** It gives every workspace `member` the viewer role on every
  project. Run it again only right after the deploy, before anyone accepts an invite; later it
  would open every project to people invited to one.
- **The deploy gap.** Old code that adds a project after the migration: owners and admins see it;
  workspace members do not, until the backfill runs again.
- **Deploy order.** The poller must deploy no later than the web app (per-project alert recipients).
- **No SECURITY DEFINER.** In Supabase the tables' owner is not a superuser, and forced RLS gives
  it no policy. The tests run migrations as a superuser and would not catch a definer function
  that reads nothing.
- **No policy on `project_members` reads it.** A policy that reads its own table recurses. The
  write policies call `project_role()`, a function, which Postgres does not inline.
- **Playwright:** the invite form's labels are "Email" and "Role"; match with `exact: true`.
