# Incident alert email

Issue #16. Decisions 014 and 030.

## What it does

When an incident opens or escalates, every member of the workspace gets an HTML email (with a
plain-text part). The email shows:

- the severity, as a colored badge, with one line on what it means;
- what happened, the likely impact and the suggested remediation (from the ZDR explainer, or its
  template when no model answers);
- incident details: project, actor alias, detectors, requests, findings, first and last seen,
  signals;
- a button to the dashboard, and a footer link to the threshold setting.

Owners and admins choose per project which severities email: every incident (default), medium and
above, high and above, critical only, or off. Members see the setting.

## How it works

1. **Addresses.** `memberships.email`, copied from the verified JWT: at workspace creation
   (`createWorkspace`) and on every visit to the overview (`recordMemberEmail`, which writes only
   when the address changed). The migration backfills from `auth.users` where it exists.
2. **Threshold.** `projects.email_alerts`. The Projects page form calls `setEmailAlertsAction` →
   `handleAlertSetting` (`apps/web/lib/alerts.ts`), which validates the level and checks the role
   in the same transaction as the write.
3. **Poll** (`packages/core/src/poller/pollProject.ts`). Step 4 explains an incident when the
   engine pages it or when it will email and is new or changed severity. Step 5 saves. Step 6,
   `sendPendingAlerts`:
   - one tenant transaction loads the project, `repo.pendingAlerts` and `repo.alertRecipients`;
   - for up to 10 pending incidents, `renderIncidentEmail` builds the email and the poller sends it
     to each recipient separately;
   - one more transaction marks the incident (`repo.markAlerted`) when at least one send worked or
     there was nobody to send to, and appends an `alert_email` audit row with counts only.
   It never throws: a failure here cannot fail a poll whose results are saved.
4. **Rendering** (`packages/core/src/alerts/email.ts`). Table layout with inline styles, 600 px
   wide, no images, no external CSS, no scripts. Every untrusted string goes through `cleanText`
   (one line, links stripped, truncated) and then `escapeHtml`; backticked identifiers become
   `<code>`. The subject is one line.
5. **Sending.** The poller Worker's `send_email` binding `EMAIL` (Cloudflare Email Service), from
   `EMAIL_FROM_ADDRESS` / `EMAIL_FROM_NAME`.

## Data model

| Column | Meaning |
| --- | --- |
| `memberships.email` | The member's address; null until known. CHECK: 3–320 chars, one `@`, no spaces, `<>,;"` |
| `projects.email_alerts` | `low` (default), `medium`, `high`, `critical`, `off` |
| `incidents.alerted_severity` | Severity of the last email; null = never sent |
| `audit_log.action` | Adds `alert_email` |

No new table and no new policy. Every write goes through `withTenant` or `withTenantForUser`; the
existing `tenant_isolation` policies cover them.

Pending, in SQL: open, `email_alerts <> 'off'`, rank(severity) ≥ rank(email_alerts), and
`alerted_severity` null or of lower rank. `markAlerted` never lowers a recorded severity.

## External services

Cloudflare Email Service (decision 014). The sender domain must be onboarded to Email Sending.
Hosted: `alerts@email.supahound.com`, set in the private deploy repo's `poller/wrangler.jsonc`.

## Testing

- `packages/core/test/alerts.test.ts`: thresholds, the severity in the subject and body, the
  remediation section present and absent, the actor alias, escalation text, own links only, HTML
  escaping, one-line subject, link stripping, truncation.
- `packages/core/test/db/alerts.test.ts` (Postgres): a full poll emails each member once; no repeat
  (UAT-D4); no cross-tenant recipient; default and changed thresholds; escalation; failed sends
  stay pending and retry; audit counts hold no address; no recipients; one model call per severity
  while sends fail; address writes stay in their tenant; the database CHECK.
- `apps/web/test/alerts.test.ts`: the threshold action's role and input checks.
- E2E: UAT-W17 (owner address on file, default level, owner changes it), UAT-W18 (member sees but
  cannot change it, even by replaying the owner's form; visiting records the member's address).

## Gotchas

- **Explain once per severity.** Explaining every pending incident on every poll would call the
  model each minute while a send keeps failing. Covered by "calls the model once per severity".
- **Replay tests need a server-rendered form.** A form React rendered on the client has no no-JS
  fallback, so a replayed copy does nothing (UAT-W18 captures the form after `page.goto`).
- **A member with no address gets nothing.** Invites (#24) must store the address.
- **Model text is untrusted even after validation.** `stripLinks` runs again in the email.
