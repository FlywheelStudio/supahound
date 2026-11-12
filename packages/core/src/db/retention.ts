import { INCIDENT_HISTORY_DAYS } from "./repo.js";
import type { TenantTx } from "./tenant.js";

// Incident retention (issue #43, decision 037). Runs once a day per tenant, inside withTenant, so
// RLS and the repeated tenant_id keep it to one tenant. The window is the incident history window
// (decision 035): 30 days after an incident's last activity.
//
// A workspace that pays (billing/policy.ts payingAccount) loses nothing: the caller passes
// deleteHistory false, and only steps 1 (resolve, which deletes nothing) and 5 (OAuth states,
// which are not customer data) run.
//
// The rules, in this order, in one transaction:
//   1. An OPEN incident last seen more than 30 days ago is resolved. The engine resolves an
//      incident only when its actor acts again, so a quiet actor leaves it open forever. Open
//      incidents are never deleted: they are resolved first. The UPDATE re-checks last_seen_at
//      after any committed poll save, so an incident the poller already updated stays open. A poll
//      that loaded the incident before this job and saves after it fails once on the findings
//      foreign key; the queue retries it, and the retry opens a new incident.
//   2. A RESOLVED incident last seen more than 30 days ago is deleted.
//   3. A finding created more than 30 days ago is deleted. No page reads findings; the incident
//      row holds the counts the pages show.
//   4. A poll run started more than 30 days ago is deleted, unless it is the project's latest run
//      or latest successful run (the next poll starts where that one ended, and the dashboard shows
//      the latest status), or findings still point at it.
//   5. An OAuth state that has expired is deleted (it holds a PKCE verifier).
// Not touched: audit_log (append-only for the app; its retention is a separate decision),
// project_usage (one small row per project per day, no personal data), service-key networks
// (detector settings, not history).

export const RETENTION_DAYS = INCIDENT_HISTORY_DAYS;

export interface RetentionResult {
  resolved: number;
  incidents: number;
  findings: number;
  pollRuns: number;
  oauthStates: number;
}

const CUTOFF = `$2::timestamptz - make_interval(days => ${RETENTION_DAYS})`;

export async function applyRetention(tx: TenantTx, now: Date, opts: { deleteHistory: boolean }): Promise<RetentionResult> {
  const p = [tx.tenantId, now];
  const resolved = await tx.query(
    `UPDATE supahound.incidents SET status = 'resolved', updated_at = $2
     WHERE tenant_id = $1 AND status = 'open' AND last_seen_at < ${CUTOFF}
     RETURNING id`,
    p,
  );
  const oauthStates = await tx.query(
    "DELETE FROM supahound.oauth_states WHERE tenant_id = $1 AND expires_at < $2 RETURNING id",
    p,
  );
  if (!opts.deleteHistory) {
    return { resolved: resolved.length, incidents: 0, findings: 0, pollRuns: 0, oauthStates: oauthStates.length };
  }
  const incidents = await tx.query(
    `DELETE FROM supahound.incidents
     WHERE tenant_id = $1 AND status = 'resolved' AND last_seen_at < ${CUTOFF}
     RETURNING id`,
    p,
  );
  const findings = await tx.query(
    `DELETE FROM supahound.findings WHERE tenant_id = $1 AND created_at < ${CUTOFF} RETURNING id`,
    p,
  );
  const pollRuns = await tx.query(
    `DELETE FROM supahound.poll_runs r
     WHERE r.tenant_id = $1 AND r.started_at < ${CUTOFF} AND r.status <> 'running'
       AND NOT EXISTS (SELECT 1 FROM supahound.findings f WHERE f.tenant_id = r.tenant_id AND f.poll_run_id = r.id)
       AND r.id NOT IN (
         SELECT DISTINCT ON (l.project_id) l.id FROM supahound.poll_runs l
          WHERE l.tenant_id = $1 ORDER BY l.project_id, l.started_at DESC)
       AND r.id NOT IN (
         SELECT DISTINCT ON (k.project_id) k.id FROM supahound.poll_runs k
          WHERE k.tenant_id = $1 AND k.status = 'ok' ORDER BY k.project_id, k.window_end DESC)
     RETURNING r.id`,
    p,
  );
  return {
    resolved: resolved.length, incidents: incidents.length, findings: findings.length,
    pollRuns: pollRuns.length, oauthStates: oauthStates.length,
  };
}
