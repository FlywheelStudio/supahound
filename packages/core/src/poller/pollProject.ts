import { createHash } from "node:crypto";
import { alertDue, renderIncidentEmail, type RenderedEmail } from "../alerts/email.js";
import type { Pool } from "pg";
import * as repo from "../db/repo.js";
import { withTenant } from "../db/tenant.js";
import { ServiceRoleNetworks } from "../detectors/serviceRole.js";
import { buildFeatures, type IncidentFeatures } from "../explainer/features.js";
import type { ExplainResult } from "../explainer/llm.js";
import { templateExplanation } from "../explainer/template.js";
import { applyFindings } from "../incidents/engine.js";
import type { Incident } from "../incidents/incident.js";
import { LogsApiError, MAX_WINDOW_MS, type LogsQuery } from "../logs/client.js";
import { normalizeRow } from "../logs/event.js";
import { edgeRollupSql } from "../logs/sql.js";
import { parsePolicyRows, SqlQueryError, type ReadOnlyQuery } from "../ownership/client.js";
import { ownershipFromPolicies, POLICIES_SQL, type OwnershipMap } from "../ownership/ownership.js";
import { scan } from "../scan.js";
import type { EnvVars } from "../config/fields.js";
import type { ProjectScope } from "../tenancy/scope.js";
import { accessTokenFor } from "../supabase/credentials.js";
import { OAuthError, type OAuthClient } from "../supabase/oauth.js";
import type { TokenVault } from "../vault/vault.js";

// One poll of one project, entirely inside one tenant's scope. Transactions stay short and never
// span an external call (Supabase logs, the model): load → call → compute → save.

export interface PollDeps {
  app: Pool;
  vault: TokenVault;
  // Supabase OAuth app credentials, for refreshing tokens. Null for static tokens (tests, CLI).
  oauth?: OAuthClient | null;
  queryLogs: (query: LogsQuery, options: { token: string }) => Promise<Record<string, unknown>[]>;
  // Read-only SQL on the customer's project, for POLICIES_SQL only (issue #10, decision 024).
  queryPolicies: (query: ReadOnlyQuery, options: { token: string }) => Promise<Record<string, unknown>[]>;
  explain: (features: IncidentFeatures) => Promise<ExplainResult>;
  now?: () => Date;
  // Minimum time between polls of one project. Supabase allows 10 analytics queries a minute.
  intervalSeconds?: number;
  // Settings such as SUPAHOUND_SOURCE_COLUMN (Workers: the env binding; Node: process.env).
  env?: EnvVars;
  // Incident alert email (decision 030). Null or absent: no email is sent and alerts stay pending.
  alerts?: AlertDeps | null;
}

export interface OutgoingEmail extends RenderedEmail {
  to: string;
  from: { email: string; name: string };
}

export interface AlertDeps {
  send: (message: OutgoingEmail) => Promise<unknown>;
  from: { email: string; name: string };
  // The web app's origin, for the dashboard and settings links.
  appUrl: string;
}

// Bounds the Worker's time and subrequests; the rest stay pending for the next poll.
export const MAX_ALERTS_PER_POLL = 10;

export type PollOutcome =
  | { status: "ok"; findings: number; notified: number; emailed: number }
  | { status: "unable_to_assess"; errorCode: string }
  | { status: "skipped"; reason: "not_found" | "paused" | "claimed_elsewhere" | "nothing_new" };

// Logs land late, so a window ends this far behind now. A log that lands later still is missed:
// the cost of never counting a request twice.
export const LAG_SECONDS = 120;
export const FIRST_LOOKBACK_MINUTES = 5;
// A poll holds no transaction across its external calls, but the Supabase query, the model
// calls (20 s timeout each) and the save fit well inside this.
export const STALE_RUN_SECONDS = 600;
// Ownership from RLS policies is read again after this long (decision 024), and on the first poll.
export const OWNERSHIP_REFRESH_SECONDS = 24 * 60 * 60;
// After a failed read, the next attempt waits this long instead of running on every poll.
export const OWNERSHIP_RETRY_SECONDS = 60 * 60;

const floorToMinute = (ms: number) => Math.floor(ms / 60_000) * 60_000;

// Windows are contiguous and minute-aligned: each starts where the last assessed one ended
// (Supabase rounds bounds to the minute, so aligned bounds stay exact). After a failure the next
// good poll covers the failed span. A gap over 24 hours is cut to the newest 24 and flagged.
export function nextWindow(lastAssessed: Date | null, now: Date): { start: Date; end: Date; truncated: boolean } | null {
  const end = floorToMinute(now.getTime() - LAG_SECONDS * 1000);
  let start = lastAssessed ? lastAssessed.getTime() : end - FIRST_LOOKBACK_MINUTES * 60_000;
  let truncated = false;
  if (end - start > MAX_WINDOW_MS) {
    start = end - MAX_WINDOW_MS;
    truncated = true;
  }
  if (end <= start) return null;
  return { start: new Date(start), end: new Date(end), truncated };
}

function errorCode(err: unknown): string {
  if (err instanceof OAuthError) return err.status === 401 || err.status === 400 ? "unauthorized" : "token_refresh_failed";
  if (err instanceof LogsApiError || err instanceof SqlQueryError) {
    if (err.status === 401 || err.status === 403) return "unauthorized";
    if (err.status === 429) return "rate_limited";
    return "query_failed";
  }
  return "network_error";
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function ownershipDue(project: repo.ProjectRecord, now: Date): boolean {
  const attempted = project.ownershipAttemptedAt;
  if (attempted === null) return true;
  // Only a read that saved counts as a success. An attempt with no save after it (failed, or the
  // worker died mid-read) waits the retry interval.
  const succeeded = project.ownershipRefreshedAt !== null && project.ownershipRefreshedAt >= attempted;
  const wait = succeeded ? OWNERSHIP_REFRESH_SECONDS : OWNERSHIP_RETRY_SECONDS;
  return now.getTime() - attempted.getTime() >= wait * 1000;
}

// Reads the project's RLS policies when due. The audit row is written before the query runs; the
// query runs outside any transaction. A failure keeps the last good map and never fails the poll.
// Returns the map to use and whether one has ever loaded.
async function refreshOwnership(
  scope: ProjectScope,
  project: repo.ProjectRecord,
  token: string,
  deps: PollDeps,
  now: Date,
): Promise<{ ownership: OwnershipMap; loaded: boolean }> {
  const current = { ownership: project.ownership, loaded: project.ownershipRefreshedAt !== null };
  if (!ownershipDue(project, now)) return current;
  const claimed = await withTenant(deps.app, scope.tenantId, async (tx) => {
    const ok = await repo.claimOwnershipRefresh(tx, scope.projectId, now, {
      refreshSeconds: OWNERSHIP_REFRESH_SECONDS, retrySeconds: OWNERSHIP_RETRY_SECONDS,
    });
    if (ok) {
      await repo.appendAudit(tx, { projectId: scope.projectId, action: "policies_query", detail: { sql_sha256: sha256(POLICIES_SQL) } });
    }
    return ok;
  });
  if (!claimed) return current;

  let ownership: OwnershipMap;
  try {
    const rows = await deps.queryPolicies({ projectRef: project.supabaseRef, sql: POLICIES_SQL }, { token });
    ownership = ownershipFromPolicies(parsePolicyRows(rows));
  } catch (err) {
    const code = err instanceof SqlQueryError && err.status < 300 ? "invalid_response" : errorCode(err);
    await withTenant(deps.app, scope.tenantId, (tx) => repo.failOwnershipRefresh(tx, scope.projectId, code));
    return current;
  }
  await withTenant(deps.app, scope.tenantId, (tx) => repo.setOwnership(tx, scope.projectId, ownership, now));
  return { ownership, loaded: true };
}

export async function pollProject(scope: ProjectScope, deps: PollDeps): Promise<PollOutcome> {
  const now = deps.now?.() ?? new Date();
  const sql = edgeRollupSql(deps.env ? { env: deps.env } : {});

  // 1. Claim, load and record intent. The audit row is written before the query runs.
  const loaded = await withTenant(deps.app, scope.tenantId, async (tx) => {
    const project = await repo.getProject(tx, scope.projectId);
    if (!project) return { skip: "not_found" as const };
    if (project.paused) return { skip: "paused" as const };
    await repo.failStaleRuns(tx, scope.projectId, now, STALE_RUN_SECONDS);
    const window = nextWindow(await repo.lastAssessedUntil(tx, scope.projectId), now);
    if (!window) return { skip: "nothing_new" as const };
    if (!(await repo.claimProject(tx, scope.projectId, now, deps.intervalSeconds ?? 60))) {
      return { skip: "claimed_elsewhere" as const };
    }
    const runId = await repo.startPollRun(tx, scope.projectId, window);
    await repo.appendAudit(tx, {
      projectId: scope.projectId,
      action: "logs_query",
      detail: {
        sql_sha256: sha256(sql),
        window_start: window.start.toISOString(),
        window_end: window.end.toISOString(),
        window_truncated: window.truncated,
      },
    });
    return {
      project, runId, window,
      networks: await repo.loadNetworks(tx, scope.projectId),
      open: await repo.openIncidents(tx, scope.projectId),
    };
  });
  if ("skip" in loaded) return { status: "skipped", reason: loaded.skip! };
  const { project, runId, window } = loaded;

  // Token: opened (and refreshed if near expiry) in its own short, row-locked transaction.
  let token: string;
  try {
    token = await accessTokenFor(deps.app, deps.vault, scope.tenantId, project.connectionId, deps.oauth ?? null, now);
  } catch (err) {
    const code = err instanceof OAuthError ? errorCode(err) : "token_unavailable";
    await withTenant(deps.app, scope.tenantId, (tx) => repo.finishPollRun(tx, runId, { status: "unable_to_assess", errorCode: code }));
    return { status: "unable_to_assess", errorCode: code };
  }

  // Detector 2's input: the RLS policies, read again when due (decision 024).
  const owners = await refreshOwnership(scope, project, token, deps, now);

  // 2. Query Supabase outside any transaction. A failure is "unable to assess", never all-clear.
  let rows: Record<string, unknown>[];
  try {
    rows = await deps.queryLogs({ projectRef: project.supabaseRef, sql, start: window.start, end: window.end }, { token });
  } catch (err) {
    const code = errorCode(err);
    await withTenant(deps.app, scope.tenantId, (tx) => repo.finishPollRun(tx, runId, { status: "unable_to_assess", errorCode: code }));
    return { status: "unable_to_assess", errorCode: code };
  }

  // 3. Detect and group, in memory, for this project only.
  const networks = new ServiceRoleNetworks();
  if (loaded.networks.length > 0) networks.learn(scope, loaded.networks);
  const events = rows.map(normalizeRow);
  // Never-loaded ownership is "unable to assess" for detector 2, not an empty (clean) map.
  const unassessedDetectors: ("cross_tenant")[] = owners.loaded ? [] : ["cross_tenant"];
  const findings = scan(events, {
    scope, networks, ownership: owners.loaded ? owners.ownership : {}, expectedAsns: new Set(project.expectedAsns),
  });
  const openIncidents: Incident[] = loaded.open.map((i) => ({
    ...i, scope, status: "open", detectors: i.detectors as Incident["detectors"],
  }));
  const { updates, resolved } = applyFindings(scope, openIncidents, findings, now);

  // 4. Explain incidents that page or will email, one model call per incident, outside any
  // transaction. An explainer failure never costs the findings or the alert: it falls back to
  // template text.
  // An incident is explained once per severity: when it opens or its severity changes. A pending
  // alert that keeps failing to send reuses its stored explanation; it never calls the model again.
  const before = new Map(loaded.open.map((o) => [o.id, o]));
  const explained = new Map<number, ExplainResult>();
  for (const [i, u] of updates.entries()) {
    const prev = u.incident.id ? before.get(u.incident.id) : undefined;
    const changed = !prev || prev.severity !== u.incident.severity;
    const willEmail = changed && alertDue(u.incident.severity, prev?.alertedSeverity ?? null, project.emailAlerts);
    if (!u.notify && !willEmail) continue;
    const features = buildFeatures(u.incident, u.findings);
    try {
      explained.set(i, await deps.explain(features));
    } catch {
      explained.set(i, {
        explanation: templateExplanation(features), source: "template", model: null, zdrConfirmed: null,
        attempts: [{ model: "explainer", outcome: "error" }],
      });
    }
  }

  // 5. Save everything for this poll in one short transaction.
  await withTenant(deps.app, scope.tenantId, async (tx) => {
    for (const r of resolved) await repo.upsertIncident(tx, scope.projectId, { ...r, id: r.id });
    for (const [i, u] of updates.entries()) {
      const incidentId = await repo.upsertIncident(tx, scope.projectId, { ...u.incident, id: u.incident.id });
      await repo.insertFindings(tx, scope.projectId, runId, u.findings.map((f) => ({ ...f, incidentId })));
      const e = explained.get(i);
      if (e) {
        await repo.setIncidentSummary(tx, incidentId, e.explanation, e.source);
        await repo.appendAudit(tx, {
          projectId: scope.projectId,
          action: "model_call",
          detail: {
            incident_id: incidentId,
            source: e.source,
            model: e.model,
            zero_data_retention_requested: true,
            zdr_confirmed: e.zdrConfirmed,
            attempts: e.attempts.map((a) => `${a.model}:${a.outcome}`).join(","),
          },
        });
      }
    }
    await repo.saveNetworks(tx, scope.projectId, networks.known(scope));
    await repo.finishPollRun(tx, runId, { status: "ok", templates: events.length, findings: findings.length, unassessedDetectors });
  });

  // 6. Email pending alerts, after the save, so an email never describes unsaved state.
  const emailed = await sendPendingAlerts(scope, deps);

  return { status: "ok", findings: findings.length, notified: explained.size, emailed };
}

const severityRank = { low: 1, medium: 2, high: 3, critical: 4 } as const;

// Sends each pending alert of one project to every member with an address, one email per
// recipient (members never see each other's addresses). An incident is marked alerted when at
// least one email went out, or when there is nobody to send to; otherwise it stays pending and
// the next poll retries it. Every attempt is audited with counts only. Never throws: a failure
// here must not fail a poll whose results are already saved.
export async function sendPendingAlerts(scope: ProjectScope, deps: PollDeps): Promise<number> {
  const alerts = deps.alerts;
  if (!alerts) return 0;
  try {
    const loaded = await withTenant(deps.app, scope.tenantId, async (tx) => {
      const project = await repo.getProject(tx, scope.projectId);
      if (!project) return null;
      return { project, pending: await repo.pendingAlerts(tx, scope.projectId), recipients: await repo.alertRecipients(tx, scope.projectId) };
    });
    if (!loaded || loaded.pending.length === 0) return 0;

    const base = new URL(`/w/${scope.tenantId}`, alerts.appUrl).toString();
    const settingsUrl = new URL(`/w/${scope.tenantId}/projects`, alerts.appUrl).toString();
    let emailed = 0;
    for (const a of loaded.pending.slice(0, MAX_ALERTS_PER_POLL)) {
      const rendered = renderIncidentEmail({
        projectName: loaded.project.name,
        incident: a,
        previousSeverity: a.alertedSeverity,
        explanation: a.summary,
        dashboardUrl: base,
        settingsUrl,
      });
      let sent = 0;
      let failed = 0;
      for (const to of loaded.recipients) {
        try {
          await alerts.send({ to, from: alerts.from, ...rendered });
          sent += 1;
        } catch {
          failed += 1;
        }
      }
      const done = sent > 0 || loaded.recipients.length === 0;
      const outcome = loaded.recipients.length === 0 ? "no_recipients" : sent === 0 ? "failed" : failed > 0 ? "partial" : "sent";
      await withTenant(deps.app, scope.tenantId, async (tx) => {
        if (done) await repo.markAlerted(tx, a.id, a.severity);
        await repo.appendAudit(tx, {
          projectId: scope.projectId,
          action: "alert_email",
          detail: {
            incident_id: a.id,
            severity: a.severity,
            escalated: a.alertedSeverity !== null && severityRank[a.severity] > severityRank[a.alertedSeverity],
            recipients: loaded.recipients.length,
            sent,
            failed,
            outcome,
          },
        });
      });
      if (sent > 0) emailed += 1;
    }
    return emailed;
  } catch {
    // IDs only, never error text (it can hold addresses or SQL).
    console.log(JSON.stringify({ event: "alert_email_crashed", project_id: scope.projectId }));
    return 0;
  }
}
