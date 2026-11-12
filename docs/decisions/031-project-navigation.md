# 031: Project navigation: a project dropdown, and the URL holds the project

Date: 2026-11-11 · Issue #98 · Amends 030 (where the alert threshold is set)

## Context

Every page drew its own header, and the only project view was a row on the workspace overview.
Erik asked for a project dropdown, as in Flywheel's PushFire and ULink consoles, with a dashboard,
incidents, scan findings ("hack.me findings"), people and settings for each project. We read both consoles' source:

- PushFire puts the switcher in the sidebar header (tile, name, plan badge), lists the projects and
  "New project", and navigates to `/projects/<id>/overview`. It stores no "last project".
- ULink stores the chosen project in `localStorage` and does not navigate on a switch, so a user
  can stay on the old project's page after a switch.

## Decision

1. **The URL holds the project:** `/w/<tenant>/p/<project>/...`. Nothing is stored in a cookie or
   browser storage. A switch is a link to the new project's dashboard.
2. **One sidebar shell** (`apps/web/components/Shell.tsx`). Its header is the project dropdown
   (tile, name, ref, plan badge; "All projects"; "+ Add project" for owners and admins). Under it:
   Dashboard, Incidents, Security scan, then Settings (General, Notifications, Plan & billing,
   People), then the workspace pages (Overview, Projects, Billing).
3. **Each page renders the shell from its own membership transaction.** There is no layout-level
   data fetch. `lib/projectPage.ts` loads the role, the project list and the page's data in one
   paid-gate transaction. A project ID that is not in the list is a 404, so another workspace's
   project ID looks exactly like a made-up one.
4. **The workspace overview stays** at `/w/<tenant>`. It holds the setup checklist and the
   onboarding notices, and links each project to its dashboard.
5. **The email alert threshold moves** from the Projects page to project Settings → Notifications.
6. **Unbuilt pages exist and say so.** Security scan (#100) and People (#24) show a "Soon" badge
   in the nav and a Coming soon panel. SMS shows as a disabled form in Notifications (#32).
7. **No client JavaScript for the dropdown.** It is a `<details>` element, keyed by project and
   page so it closes after a switch.

## Alternatives considered

- **A layout that loads the project list.** Rejected: a layout does not re-run on every
  navigation, so it must not be the access check, and the billing page must render before a card
  exists.
- **Redirect `/w/<tenant>` to the last project.** Rejected for now: it needs stored state, and the
  overview carries onboarding.

## Consequences

- Every new project page calls `loadProjectPage` and renders `Shell`. UAT-W21 checks the 404.
- Decisions 032–034 fill in billing, people and findings per project.
