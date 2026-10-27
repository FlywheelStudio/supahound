import { createHash } from "node:crypto";
import type { Pool } from "pg";
import * as repo from "../db/repo.js";
import { withTenant } from "../db/tenant.js";
import { ServiceRoleNetworks } from "../detectors/serviceRole.js";
import { buildFeatures } from "../explainer/features.js";
import type { ExplainResult } from "../explainer/llm.js";
import type { IncidentFeatures } from "../explainer/features.js";
import { applyFindings } from "../incidents/engine.js";
import type { Incident } from "../incidents/incident.js";
import { LogsApiError, pollWindow, type LogsQuery } from "../logs/client.js";
import { normalizeRow } from "../logs/event.js";
import { edgeRollupSql } from "../logs/sql.js";
import { scan } from "../scan.js";
import type { ProjectScope } from "../tenancy/scope.js";
import type { TokenVault } from "../vault/vault.js";

// One poll of one project, entirely inside one tenant's scope. Transactions stay short and never
// span an external call (Supabase logs, the model): load → call → compute → save.

export interface PollDeps {
  app: Pool;
  vault: TokenVault;
  queryLogs: (query: LogsQuery, options: { token: string }) => Promise<Record<string, unknown>[]>;
  explain: (features: IncidentFeatures) => Promise<ExplainResult>;
  now?: () => Date;
  windowMinutes?: number;
}

export type PollOutcome =
  | { status: "ok"; findings: number; notified: number }
  | { status: "unable_to_assess"; errorCode: string }
  | { status: "skipped"; reason: "not_found" | "paused" };

function errorCode(err: unknown): string {
  if (err instanceof LogsApiError) {
    if (err.status === 401 || err.status === 403) return "unauthorized";
    if (err.status === 429) return "rate_limited";
    return "query_failed";
  }
  return "network_error";
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function pollProject(scope: ProjectScope, deps: PollDeps): Promise<PollOutcome> {
  const now = deps.now?.() ?? new Date();
  const window = pollWindow(now, deps.windowMinutes ?? 2);
  const sql = edgeRollupSql();

  // 1. Load and record intent. The audit row is written before the query runs.
  const loaded = await withTenant(deps.app, scope.tenantId, async (tx) => {
    const project = await repo.getProject(tx, scope.projectId);
    if (!project) return { skip: "not_found" as const };
    if (project.paused) return { skip: "paused" as const };
    const runId = await repo.startPollRun(tx, scope.projectId, window);
    await repo.markPolled(tx, scope.projectId, now);
    let token: string;
    try {
      token = await repo.openConnectionToken(tx, deps.vault, project.connectionId);
    } catch {
      await repo.finishPollRun(tx, runId, { status: "unable_to_assess", errorCode: "token_unavailable" });
      return { failed: "token_unavailable" };
    }
    await repo.appendAudit(tx, {
      projectId: scope.projectId,
      action: "logs_query",
      detail: { sql_sha256: sha256(sql), window_start: window.start.toISOString(), window_end: window.end.toISOString() },
    });
    return {
      project, runId, token,
      networks: await repo.loadNetworks(tx, scope.projectId),
      open: await repo.openIncidents(tx, scope.projectId),
    };
  });
  if ("skip" in loaded) return { status: "skipped", reason: loaded.skip! };
  if ("failed" in loaded) return { status: "unable_to_assess", errorCode: loaded.failed! };
  const { project, runId, token } = loaded;

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
  const findings = scan(events, {
    scope, networks, ownership: project.ownership, expectedAsns: new Set(project.expectedAsns),
  });
  const openIncidents: Incident[] = loaded.open.map((i) => ({
    ...i, scope, status: "open", detectors: i.detectors as Incident["detectors"],
  }));
  const { updates, resolved } = applyFindings(scope, openIncidents, findings, now);

  // 4. Explain incidents that page, one model call per incident, outside any transaction.
  const explained = new Map<number, ExplainResult>();
  for (const [i, u] of updates.entries()) {
    if (u.notify) explained.set(i, await deps.explain(buildFeatures(u.incident, u.findings)));
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
    await repo.finishPollRun(tx, runId, { status: "ok", templates: events.length, findings: findings.length });
  });

  return { status: "ok", findings: findings.length, notified: explained.size };
}
