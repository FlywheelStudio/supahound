# 030: Incident alert email to every member, threshold per project

Date: 2026-11-11 · Issue #16 · Builds on 014 (Cloudflare Email Service)

## Context

The incident engine opened incidents and wrote summaries, but nobody was told. Issue #16 asks for
one email per incident. Three questions needed an answer: who gets it, which incidents send it, and
how a failed send is retried. Erik answered the first two on 2026-11-11.

## Decision

1. **Recipients: every member of the workspace** (amended by 036: the project's people only). Each member gets their own email (no shared
   `To:` line). The address comes only from the verified JWT (`getClaims()`), copied onto
   `memberships.email` when the workspace is created and when the member opens the workspace
   overview. The migration backfills existing members from `auth.users` on Supabase.
2. **Threshold: every severity by default, changeable per project.** `projects.email_alerts` is
   `low` (every incident), `medium`, `high`, `critical` or `off`. Owners and admins change it on
   the Projects page; members see it.
3. **The incident row is the outbox.** `incidents.alerted_severity` records the severity of the
   last email. After each poll saves, the poller sends every open incident at or above the
   threshold whose `alerted_severity` is null or lower, then marks it. This gives:
   - one email per incident, not per event (repeats at the same severity never send);
   - a new email when the incident escalates;
   - a retry on the next poll when every send failed.
   Incidents already open when this shipped were marked sent, so the release sent no backlog.
4. **The model is called once per severity.** An incident is explained when it opens or its
   severity changes. A pending alert that keeps failing reuses its stored explanation.
5. **Content.** The email shows the severity, what happened, the likely impact, the suggested
   remediation (the explainer's `nextSteps`; omitted when there are none), and the incident details.
   The actor is an alias (`User <fingerprint>`), never the user ID. All text is cleaned of links,
   cut to length, then HTML-escaped. The only links are Supahound's own dashboard and settings
   pages. Sender: `EMAIL_FROM_ADDRESS` on the poller (hosted: `alerts@email.supahound.com`).

## Alternatives considered

- **Owners and admins only.** Rejected by Erik: everyone in the workspace should know.
- **High and critical only (the engine's paging rule).** Rejected by Erik as the default, kept as
  a setting.
- **One alert address per workspace.** Needs a settings form and a verification step. Can be added
  later next to the member list.
- **Mark sent before sending.** Simpler, but a failed send loses the alert. Rejected.
- **A SECURITY DEFINER function to let a user write their own email outside a tenant.** Not
  needed: the write runs inside the tenant transaction under the existing policy. A new
  "update own membership" policy was rejected, because RLS cannot limit columns and a member
  could change their own `role`.

## Consequences

- A member who has never opened the workspace since this shipped and was not in the backfill gets
  no email until they do. Team invites (#24) must store the address when they add a member.
- When the workspace has no addresses at all, the alert is marked done with outcome
  `no_recipients`, so it does not arrive late.
- When at least one recipient got the email, the alert is marked done; other recipients' failures
  are counted in the audit row, not retried.
- Every attempt writes an `alert_email` audit row with counts only (no addresses).
- At most 10 alerts per project per poll; the rest wait for the next poll.
- Issue #16's "copy fix prompt" button is not built: email cannot copy to the clipboard. The
  remediation steps are in the email as text. A copy button belongs on the incident page (#44).
