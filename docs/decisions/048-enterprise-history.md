# 048: Enterprise history: a year of incidents, findings and security events, per workspace

Date: 2026-11-22 · Issue #170 · Amends [035](035-incident-history-window.md) point 1,
[037](037-data-controls.md) section 2 and [044](044-security-events.md) points 8 and 9; builds on
[028](028-card-validated-trial.md), [029](029-staff-billing-exemption.md) and
[041](041-project-subscriptions-build.md)

## Context

Erik decided on 2026-11-22 that longer history is an Enterprise feature: Enterprise sees and keeps
**1 year** of incident history, findings and security events; every other workspace keeps today's
windows (incident history 30 days, decision 035; security events 90 days, decision 044). The issue
left two choices open: an Enterprise *project* or a workspace-level Enterprise flag, and how a
downgrade behaves under decision 037.

What the code holds today:

- **There is no Enterprise plan in the data.** Tiers are `starter` and `pro`
  (`projects.billing_tier`, `project_subscriptions.tier`), set by traffic every day. "Enterprise"
  (decision 028) is a project above 10 million requests in 30 days that *stays on Pro* while we
  agree terms by hand; it has no Stripe price. `needsEnterprise(requests30d)` is a prompt to talk,
  not a plan, and it changes with traffic from one day to the next.
- **Deletion under decision 037:** while a workspace pays, the daily data job deletes none of its
  history, whatever its age. Once it does not pay, the job deletes resolved incidents last seen
  more than 30 days ago, findings and poll runs older than 30 days (keeping each project's latest
  and latest `ok` run, and runs findings still point at) and security events older than 90 days.
  It resolves open incidents quiet for 30 days on every workspace (that deletes nothing). The purge
  of a closed workspace and the delete after a disconnect remove everything, whatever the window.

## Decision

1. **Per workspace, from an operator-set flag.** `billing_accounts.enterprise_at` (migration
   `20261122190000_enterprise_history.sql`, one nullable column) is when an operator marked the
   workspace Enterprise after terms were agreed. The app reads it and never writes it. Per project
   was the alternative (below); a workspace-level window also matches how the pages and the data
   job already work (the security log and the data job are per workspace).
2. **Staff-exempt workspaces (decision 029) get the Enterprise window too.** They already keep
   everything (an exemption counts as paying), and staff should see what Enterprise customers see.
   The exemption is checked on every read, so a workspace handed to a customer drops back to the
   standard window with its exemption.
3. **The window** (`packages/core/src/billing/history.ts`, `historyWindowFor`):

   | Plan | Incidents (list and detail), findings, poll runs | Security events |
   | --- | --- | --- |
   | Standard | 30 days (an open incident always shows, decision 035) | 90 days |
   | Enterprise (`enterprise_at` set, or staff-exempt) | 365 days | 365 days |

   An open incident quiet for 30 days is still resolved on every plan; a resolved incident stays
   in the window for its plan's length.
4. **Read from the plan on every query; nothing new per row.** `db/billing.ts` `historyWindow(tx)`
   reads the billing row in the transaction that lists (incident list, incident detail, security
   log) or deletes (the data job, through `retentionPlan`, which returns `paying` and the window
   from the same read). The queries take the window as a bound integer (`checkWindowDays`: 1 to
   3660), never as interpolated text.
5. **Deletion stays decision 037.** While a workspace pays, nothing is deleted, Enterprise or not.
   When a workspace does not pay, the data job deletes what is older than *its plan's* window:
   30/90 days on the standard plan, a year on Enterprise. The purge of a closed workspace and the
   delete after a disconnect are unchanged (they delete everything after their 30-day grace).
6. **Downgrade = the operator clears `enterprise_at`.** The older rows are hidden on the next
   request (the pages use the standard window at once). They are deleted under the existing rules:
   not while the workspace pays (so marking it Enterprise again brings them back), and by the next
   daily job once it no longer pays, as any workspace's history beyond its window is today. No new
   grace period: decision 037 already defers every deletion until payment stops.
7. **Pages.** Incidents and the security log say "the last 30 days" / "the last 90 days" or "the
   last year". Project settings → Plan & billing shows the history line ("Enterprise · 1-year
   history: incidents, findings and the security log", or the standard windows); the Enterprise
   card on workspace billing lists "1-year history"; workspace settings states the windows that
   apply. The marketing site's pricing copy is a follow-up in `supahound-site`.
8. **Marking a workspace.** An approved production write, as ending an exemption is (decision
   029): `UPDATE supahound.billing_accounts SET enterprise_at = now(), updated_at = now() WHERE
   tenant_id = '<tenant>'` (insert the row first if the workspace has none); `= NULL` downgrades.
   Self-hosters may set it the same way; with billing off a workspace never pays, so the window
   also sets what the data job keeps.

## Alternatives considered

- **Per project** (a third tier in `projects.billing_tier` / `project_subscriptions.tier`).
  Rejected for now: the tier is recomputed from traffic every day and drives Stripe prices,
  and Enterprise has no price; the security log is per workspace anyway, so it would still need
  a rule such as "a year if any project is Enterprise". A later decision can add a project tier
  when Enterprise gets a Stripe price; the window function then reads it instead of the flag.
- **Derive Enterprise from traffic** (`needsEnterprise`, above 10 million requests). Rejected: it
  grants a paid feature before terms exist, and a project dipping below the line would hide its
  history the next day.
- **A deploy variable listing Enterprise tenants.** Rejected: two Workers would need the same list,
  and the data job and pages would read config instead of the workspace's own row.
- **Keep a lapsed Enterprise workspace's year only while it pays.** Not needed: while it pays
  nothing is deleted anyway; the flag decides the window only for a workspace that stopped paying
  and was not downgraded, which keeps the contract's year until an operator clears it.

## Consequences

- The migration is additive (one nullable column, no default, no grant); applying it to a shared
  database needs Erik's approval (repo rule). No existing workspace changes window.
- `listIncidentHistory`, `getIncident`, `listSecurityEvents`, `deleteExpiredSecurityEvents` and
  `applyRetention` now require the window, so a new caller must state it (the typecheck enforces it).
- Index use is unchanged: `incidents_project_idx` and the security events' `(tenant_id, created_at)`
  index serve a year as they serve 30 days.
- Follow-up in `FlywheelStudio/supahound-site`: list "1-year history" under Enterprise on the
  pricing page.
