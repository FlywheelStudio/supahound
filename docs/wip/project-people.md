# WIP: People and roles per project

Issue #24. Decisions 033 (scope) and 036 (how). Branch `feature/project-people`.

## Goal

Each project has people with one role (Owner, Admin, Editor, Viewer). Owners and admins invite
people by email to one project. RLS enforces project access inside the tenant.

## Approach

- Migration `20261112000000_project_people.sql`: `project_members`, `project_invites`,
  `supahound.project_role()`, restrictive RLS on every table with project data, backfill.
- Workspace owners and admins have the Owner and Admin role on every project without rows.
- Invitees become workspace `member`s plus one `project_members` row.
- Core: `packages/core/src/db/people.ts`. Web: `lib/people.ts` (pure), People page, accept page.
- Alerts go to the people of the project, not to every workspace member.

## Build log

- 2026-11-12: Wrote the migration first and ran the unchanged suites on it (old code + new
  schema). Core: 3 of 556 red, all expected:
  - `isolation.test.ts` "forces RLS on every table": the test's exact table list lacks the two new
    tables. A catalog check, not a behaviour change.
  - `users.test.ts` (2): the fixture adds a workspace `member` AFTER the migration, then reads
    projects. With no project role, RLS hides the project. In production no such row can exist
    before the new code ships: only `createWorkspace` writes memberships (always `owner`), and the
    backfill gives every existing member the viewer role.
  - E2E on old code + new schema: 47 of 50 green. Red: UAT-W13, W18 and W22. Each one inserts a
    workspace `member` with `adminQuery` after the migration and then expects to see the project.
    Same cause as above; not reachable in production with the old code.
  - Fix for the fixtures: add the member's project role (an invite, or a `project_members` row),
    as a real member would have after the backfill.
