import { createHash } from "node:crypto";
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
}

export type PollOutcome =
  | { status: "ok"; findings: number; notified: number }
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

  // 4. Explain incidents that page, one model call per incident, outside any transaction.
  // An explainer failure never costs the findings or the alert: it falls back to template text.
  const explained = new Map<number, ExplainResult>();
  for (const [i, u] of updates.entries()) {
    if (!u.notify) continue;
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

  return { status: "ok", findings: findings.length, notified: explained.size };
}
