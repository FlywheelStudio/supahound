# 036: Project roles, RLS by project, and email invites

Date: 2026-11-12 · Issue #24 · Builds 033; amends 030 (who gets alert email)

## Context

Decision 033 gave each project its own people with four roles and email invites. Erik's answers:
workspace roles map down on the day it ships (owner → Owner, admin → Admin, member → Viewer on
every project), invites expire after 7 days, and an owner or admin can cancel or resend. This
record fixes how it works. The migration reaches production before the new code, so the old code
must keep working on the new schema.

## Decision

1. **Effective role, computed in SQL** (`supahound.project_role(project)`): a workspace owner is
   Owner and a workspace admin at least Admin on every project of the workspace, with no rows.
   Anyone else has the role in `project_members`, or no access. A workspace admin can also hold
   Owner on one project. So a project added later, by any code, is at once open to the workspace
   owners and admins, and a change of workspace role applies at once. No trigger.
2. **Invitees are workspace members.** Accepting adds a `memberships` row with role `member` (never
   `owner` or `admin`) and one `project_members` row. Every existing gate (`withTenantForUser`,
   the paid gate, the workspace switcher) keeps working. The staff billing exemption (029) keys on
   workspace owners only, so an invited project Owner never ends it.
3. **RLS by project.** Every table with project data (`projects`, `service_role_networks`,
   `poll_runs`, `incidents`, `findings`, `project_usage`, `audit_log`) gets a RESTRICTIVE SELECT
   policy: a transaction with `app.user_id` set sees a project's rows only with a role on it.
   Without `app.user_id` (poller, billing sync, Stripe webhook, invite acceptance) the whole tenant
   stays visible, as before. `audit_log` rows with no project are for workspace owners and admins.
4. **Writes per role, in RLS and in the server actions.**

   | Action | Owner | Admin | Editor | Viewer |
   | --- | --- | --- | --- | --- |
   | See the project, its incidents, settings and people | Yes | Yes | Yes | Yes |
   | Change project settings (email alert threshold) | Yes | Yes | Yes | No |
   | Invite, resend, cancel; change roles; remove people | Yes | Yes, not Owners | No | No |
   | Grant, change or remove the Owner role | Yes | No | No | No |
   | Remove the project | Yes | Workspace admins only | No | No |

   Workspace-level actions keep the workspace role: connect Supabase, add projects, billing.
   Nobody changes or removes their own role, and a workspace owner's or admin's project role
   follows from the workspace, so the People page does not change it. Every project always has
   an Owner (the workspace owner), so no "last owner" rule is needed.
5. **Invites.** The token is `<tenant>.<32 random bytes, base64url>`; only its SHA-256 is stored.
   The tenant part lets the lookup run inside the tenant's RLS. An invite expires 7 days after it
   is sent, works once, and needs the signed-in user's verified email (from `getClaims()`) to equal
   the invited address, case-insensitive. Opening the link (GET) changes nothing; the invitee
   presses Accept (POST), so a mail scanner cannot use up the invite. A second invite to the same
   address, or a resend, replaces the token and the expiry; the old link dies. A resend within
   60 seconds is refused. Accepting never lowers a role the person already has.
6. **Sign-in handoff.** A signed-out invitee goes to `/login?next=/invite?...`. The login form
   stores `next` in an httpOnly cookie for 1 hour; `/auth/confirm` reads and clears it. A link
   opened in another browser lands on the app as usual, and the invite link still works.
7. **Email.** The invite email goes through the web Worker's existing `EMAIL` binding and sender
   (decision 014), after the transaction commits. No new service.
8. **Alert email goes to the project's people** (amends 030): workspace owners and admins, and the
   people with a role on the project. A person invited to one project gets no email about another.
9. **Leaving.** Removing a person's last project role also removes their `member` workspace
   membership.

## Alternatives considered

- **Rows for workspace owners and admins on every project, with a trigger on new projects.**
  Rejected: two sources of truth, a trigger to keep in step with workspace role changes, and the
  picker's `INSERT ... RETURNING` would fail the new SELECT policy before an AFTER trigger ran.
- **Project access in app code only, RLS by tenant as before.** Rejected: every tenant-wide list
  (overview, incidents, project dropdown, billing page) would need its own filter, and one missed
  filter leaks a project. RLS covers them all.
- **A `guest` workspace role for invitees.** Rejected: it changes the workspace role set the
  billing rules and the old code read.
- **A SECURITY DEFINER accept function.** Rejected: in Supabase the tables' owner is not a
  superuser and forced RLS gives it no policy, so it would read nothing. Acceptance runs in the
  tenant's transaction after the token and email checks.

## Consequences

- Old code on the new schema: owners see and do what they did before; members keep every
  existing project through the backfill. A project that old code adds after the migration is not
  visible to workspace members until the backfill runs again (owners and admins see it at once).
- Every new table with project data needs the `project_access` policy. `isolation.test.ts` lists
  every table; `people.test.ts` checks the project policy on each project table.
- Deploy the poller no later than the web app. The per-project alert recipients live in the
  poller; an old poller would email invited people about every project of the workspace.
