import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Finding, Severity } from "../detectors/finding.js";
import type { OwnershipMap } from "../ownership/ownership.js";
import { connectionId, projectId, projectScope, tenantId, type ConnectionId, type ProjectId, type ProjectScope } from "../tenancy/scope.js";
import type { TokenVault } from "../vault/vault.js";
import type { TenantTx } from "./tenant.js";

// Repositories. Each takes a TenantTx and repeats `tenant_id = tx.tenantId` in every statement,
// so a missing or broken RLS policy still cannot widen a query (defence in depth).

export async function createTenant(tx: TenantTx, name: string): Promise<void> {
  await tx.query("INSERT INTO supahound.tenants (id, name) VALUES ($1, $2)", [tx.tenantId, name]);
}

export async function createConnection(
  tx: TenantTx,
  vault: TokenVault,
  input: { label: string; token: string },
): Promise<ConnectionId> {
  const id = connectionId(randomUUID());
  const sealed = vault.seal(input.token, { tenantId: tx.tenantId, connectionId: id });
  await tx.query(
    `INSERT INTO supahound.connections (id, tenant_id, label, sealed_token, key_version)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, tx.tenantId, input.label, sealed, vault.keyVersionOf(sealed)],
  );
  return id;
}

export async function openConnectionToken(tx: TenantTx, vault: TokenVault, id: ConnectionId): Promise<string> {
  const rows = await tx.query<{ sealed_token: Buffer }>(
    "SELECT sealed_token FROM supahound.connections WHERE tenant_id = $1 AND id = $2",
    [tx.tenantId, id],
  );
  const row = rows[0];
  if (!row) throw new Error("Connection not found for this tenant");
  return vault.open(row.sealed_token, { tenantId: tx.tenantId, connectionId: id });
}

export async function createProject(
  tx: TenantTx,
  input: { connectionId: ConnectionId; supabaseRef: string; name: string },
): Promise<ProjectId> {
  const rows = await tx.query<{ id: string }>(
    `INSERT INTO supahound.projects (tenant_id, connection_id, supabase_ref, name)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [tx.tenantId, input.connectionId, input.supabaseRef, input.name],
  );
  return projectId(rows[0]!.id);
}

export interface ProjectRecord {
  scope: ProjectScope;
  connectionId: ConnectionId;
  supabaseRef: string;
  ownership: OwnershipMap;
  // The last successful read of the project's RLS policies; null = never loaded (decision 024).
  ownershipRefreshedAt: Date | null;
  ownershipAttemptedAt: Date | null;
  ownershipError: string | null;
  expectedAsns: number[];
  paused: boolean;
}

export async function getProject(tx: TenantTx, id: ProjectId): Promise<ProjectRecord | null> {
  const rows = await tx.query<{
    connection_id: string; supabase_ref: string; ownership: OwnershipMap; expected_asns: number[]; paused: boolean;
    ownership_refreshed_at: Date | null; ownership_attempted_at: Date | null; ownership_error: string | null;
  }>(
    `SELECT connection_id, supabase_ref, ownership, expected_asns, paused,
            ownership_refreshed_at, ownership_attempted_at, ownership_error
     FROM supahound.projects WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    scope: projectScope(tx.tenantId, id),
    connectionId: connectionId(r.connection_id),
    supabaseRef: r.supabase_ref,
    ownership: r.ownership,
    ownershipRefreshedAt: r.ownership_refreshed_at,
    ownershipAttemptedAt: r.ownership_attempted_at,
    ownershipError: r.ownership_error,
    expectedAsns: r.expected_asns,
    paused: r.paused,
  };
}

// Stores a loaded ownership map. A hand-set map (CLI, tests) counts as a successful load too.
export async function setOwnership(tx: TenantTx, id: ProjectId, ownership: OwnershipMap, at: Date = new Date()): Promise<void> {
  await tx.query(
    `UPDATE supahound.projects
     SET ownership = $3, ownership_refreshed_at = $4, ownership_attempted_at = $4, ownership_error = NULL
     WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, id, JSON.stringify(ownership), at],
  );
}

// Claims a policies refresh when one is due: never attempted, the last success older than
// refreshSeconds, or the last failure older than retrySeconds. The conditional update takes the
// row lock, so two workers never both refresh.
export async function claimOwnershipRefresh(
  tx: TenantTx,
  id: ProjectId,
  now: Date,
  intervals: { refreshSeconds: number; retrySeconds: number },
): Promise<boolean> {
  const rows = await tx.query(
    `UPDATE supahound.projects SET ownership_attempted_at = $3
     WHERE tenant_id = $1 AND id = $2
       AND (ownership_attempted_at IS NULL
            OR ownership_attempted_at <= $3::timestamptz - make_interval(secs =>
                 CASE WHEN ownership_error IS NULL THEN $4::double precision ELSE $5::double precision END))
     RETURNING id`,
    [tx.tenantId, id, now, intervals.refreshSeconds, intervals.retrySeconds],
  );
  return rows.length === 1;
}

// A failed refresh keeps the last good map; only the error code changes.
export async function failOwnershipRefresh(tx: TenantTx, id: ProjectId, errorCode: string): Promise<void> {
  await tx.query("UPDATE supahound.projects SET ownership_error = $3 WHERE tenant_id = $1 AND id = $2", [
    tx.tenantId, id, errorCode,
  ]);
}

// Claims the project for one poll. The conditional update takes the row lock, so of two workers
// racing for the same project exactly one gets a row back; the other skips.
export async function claimProject(tx: TenantTx, id: ProjectId, now: Date, intervalSeconds: number): Promise<boolean> {
  const rows = await tx.query(
    `UPDATE supahound.projects SET last_polled_at = $3
     WHERE tenant_id = $1 AND id = $2 AND NOT paused
       AND (last_polled_at IS NULL OR last_polled_at <= $3::timestamptz - make_interval(secs => $4))
     RETURNING id`,
    [tx.tenantId, id, now, intervalSeconds],
  );
  return rows.length === 1;
}

// A run left in `running` (the worker died after the start transaction) becomes
// "unable to assess", so the dashboard never shows a silent gap as healthy.
export async function failStaleRuns(tx: TenantTx, id: ProjectId, now: Date, olderThanSeconds: number): Promise<number> {
  const rows = await tx.query(
    `UPDATE supahound.poll_runs SET status = 'unable_to_assess', error_code = 'worker_lost', finished_at = $3
     WHERE tenant_id = $1 AND project_id = $2 AND status = 'running'
       AND started_at < $3::timestamptz - make_interval(secs => $4)
     RETURNING id`,
    [tx.tenantId, id, now, olderThanSeconds],
  );
  return rows.length;
}

// End of the last window that was fully assessed. The next poll starts here, so windows never
// overlap (no double counting) and a failed poll's span is covered by the next good one.
export async function lastAssessedUntil(tx: TenantTx, id: ProjectId): Promise<Date | null> {
  const rows = await tx.query<{ until: Date | null }>(
    "SELECT max(window_end) AS until FROM supahound.poll_runs WHERE tenant_id = $1 AND project_id = $2 AND status = 'ok'",
    [tx.tenantId, id],
  );
  return rows[0]?.until ?? null;
}

export async function loadNetworks(tx: TenantTx, id: ProjectId): Promise<number[]> {
  const rows = await tx.query<{ asn: number }>(
    "SELECT asn FROM supahound.service_role_networks WHERE tenant_id = $1 AND project_id = $2 ORDER BY asn",
    [tx.tenantId, id],
  );
  return rows.map((r) => r.asn);
}

export async function saveNetworks(tx: TenantTx, id: ProjectId, asns: number[]): Promise<void> {
  if (asns.length === 0) return;
  await tx.query(
    `INSERT INTO supahound.service_role_networks (tenant_id, project_id, asn)
     SELECT $1, $2, unnest($3::integer[]) ON CONFLICT DO NOTHING`,
    [tx.tenantId, id, asns],
  );
}

export async function startPollRun(tx: TenantTx, id: ProjectId, window: { start: Date; end: Date }): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    `INSERT INTO supahound.poll_runs (tenant_id, project_id, window_start, window_end)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [tx.tenantId, id, window.start, window.end],
  );
  return rows[0]!.id;
}

export async function finishPollRun(
  tx: TenantTx,
  runId: string,
  result: {
    status: "ok" | "unable_to_assess"; errorCode?: string; templates?: number; findings?: number;
    // Detectors this run could not check (decision 024). Meaningful on "ok" runs only.
    unassessedDetectors?: Finding["detector"][];
  },
): Promise<void> {
  await tx.query(
    `UPDATE supahound.poll_runs
     SET status = $3, error_code = $4, templates = $5, findings = $6, unassessed_detectors = $7, finished_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, runId, result.status, result.errorCode ?? null, result.templates ?? null, result.findings ?? null,
      result.unassessedDetectors ?? []],
  );
}

export async function insertFindings(
  tx: TenantTx,
  id: ProjectId,
  runId: string,
  findings: (Finding & { incidentId: string | null })[],
): Promise<void> {
  for (const f of findings) {
    await tx.query(
      `INSERT INTO supahound.findings
         (tenant_id, project_id, poll_run_id, incident_id, detector, severity, actor, signals, evidence, hits, first_seen, last_seen)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [tx.tenantId, id, runId, f.incidentId, f.detector, f.severity, f.actor, f.signals, JSON.stringify(f.evidence),
        f.hits, f.firstSeen, f.lastSeen],
    );
  }
}

export interface IncidentRecord {
  id: string;
  actor: string;
  severity: Severity;
  detectors: string[];
  signals: string[];
  findingCount: number;
  hits: number;
  openedAt: Date;
  lastSeenAt: Date;
}

export async function openIncidents(tx: TenantTx, id: ProjectId): Promise<IncidentRecord[]> {
  const rows = await tx.query<{
    id: string; actor: string; severity: Severity; detectors: string[]; signals: string[];
    finding_count: number; hits: number; opened_at: Date; last_seen_at: Date;
  }>(
    `SELECT id, actor, severity, detectors, signals, finding_count, hits, opened_at, last_seen_at
     FROM supahound.incidents WHERE tenant_id = $1 AND project_id = $2 AND status = 'open'`,
    [tx.tenantId, id],
  );
  return rows.map((r) => ({
    id: r.id, actor: r.actor, severity: r.severity, detectors: r.detectors, signals: r.signals,
    findingCount: r.finding_count, hits: r.hits, openedAt: r.opened_at, lastSeenAt: r.last_seen_at,
  }));
}

// Inserts a new incident (id null) or updates an open one; returns its id.
export async function upsertIncident(
  tx: TenantTx,
  id: ProjectId,
  incident: Omit<IncidentRecord, "id"> & { id: string | null; status: "open" | "resolved" },
): Promise<string> {
  if (incident.id === null) {
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO supahound.incidents
         (tenant_id, project_id, actor, status, severity, detectors, signals, finding_count, hits, opened_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [tx.tenantId, id, incident.actor, incident.status, incident.severity, incident.detectors, incident.signals,
        incident.findingCount, incident.hits, incident.openedAt, incident.lastSeenAt],
    );
    return rows[0]!.id;
  }
  await tx.query(
    `UPDATE supahound.incidents
     SET status = $4, severity = $5, detectors = $6, signals = $7, finding_count = $8, hits = $9,
         last_seen_at = $10, updated_at = now()
     WHERE tenant_id = $1 AND project_id = $2 AND id = $3`,
    [tx.tenantId, id, incident.id, incident.status, incident.severity, incident.detectors, incident.signals,
      incident.findingCount, incident.hits, incident.lastSeenAt],
  );
  return incident.id;
}

export async function setIncidentSummary(
  tx: TenantTx,
  incidentId: string,
  summary: object,
  source: "model" | "template",
): Promise<void> {
  await tx.query(
    `UPDATE supahound.incidents SET summary = $3, summary_source = $4, updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, incidentId, JSON.stringify(summary), source],
  );
}

export type AuditAction = "logs_query" | "policies_query" | "model_call";

export async function appendAudit(
  tx: TenantTx,
  entry: { projectId: ProjectId | null; action: AuditAction; detail: Record<string, string | number | boolean | null> },
): Promise<void> {
  await tx.query(
    "INSERT INTO supahound.audit_log (tenant_id, project_id, action, detail) VALUES ($1, $2, $3, $4)",
    [tx.tenantId, entry.projectId, entry.action, JSON.stringify(entry.detail)],
  );
}

// Scheduler path. Runs on a pool that logs in as a member of supahound_scheduler, which can read
// project IDs and poll times and nothing else. Returns scopes only; each job then opens its own
// tenant transaction.
export async function dueProjects(schedulerPool: Pool, olderThanSeconds: number, limit: number): Promise<ProjectScope[]> {
  const res = await schedulerPool.query<{ tenant_id: string; id: string }>(
    `SELECT tenant_id, id FROM supahound.projects
     WHERE NOT paused AND (last_polled_at IS NULL OR last_polled_at < now() - make_interval(secs => $1))
     ORDER BY last_polled_at NULLS FIRST
     LIMIT $2`,
    [olderThanSeconds, limit],
  );
  return res.rows.map((r) => projectScope(tenantId(r.tenant_id), r.id));
}

// Dashboard reads. Called inside withTenantForUser, so the tenant is a verified membership.

export interface ProjectSummary {
  id: ProjectId;
  name: string;
  supabaseRef: string;
  paused: boolean;
  lastPolledAt: Date | null;
  openIncidents: number;
  lastRunStatus: "running" | "ok" | "unable_to_assess" | null;
  // Detector 2 coverage (decision 024): "unable_to_assess" when the latest finished run lists it as
  // unassessed; "no_owned_tables" when the policies loaded but scope no table to an owner.
  crossTenant: "assessed" | "unable_to_assess" | "no_owned_tables" | null;
}

function crossTenantCoverage(lastUnassessed: string[] | null, loaded: boolean, empty: boolean): ProjectSummary["crossTenant"] {
  if (lastUnassessed?.includes("cross_tenant")) return "unable_to_assess";
  if (loaded && empty) return "no_owned_tables";
  return lastUnassessed === null ? null : "assessed";
}

export async function listProjects(tx: TenantTx): Promise<ProjectSummary[]> {
  const rows = await tx.query<{
    id: string; name: string; supabase_ref: string; paused: boolean; last_polled_at: Date | null;
    open_incidents: number; last_run_status: ProjectSummary["lastRunStatus"];
    last_unassessed: string[] | null; ownership_loaded: boolean; ownership_empty: boolean;
  }>(
    `SELECT p.id, p.name, p.supabase_ref, p.paused, p.last_polled_at,
            p.ownership_refreshed_at IS NOT NULL AS ownership_loaded,
            p.ownership = '{}'::jsonb AS ownership_empty,
            (SELECT r.unassessed_detectors FROM supahound.poll_runs r
              WHERE r.tenant_id = p.tenant_id AND r.project_id = p.id AND r.status = 'ok'
              ORDER BY r.started_at DESC LIMIT 1) AS last_unassessed,
            (SELECT count(*)::int FROM supahound.incidents i
              WHERE i.tenant_id = p.tenant_id AND i.project_id = p.id AND i.status = 'open') AS open_incidents,
            (SELECT r.status FROM supahound.poll_runs r
              WHERE r.tenant_id = p.tenant_id AND r.project_id = p.id ORDER BY r.started_at DESC LIMIT 1) AS last_run_status
     FROM supahound.projects p WHERE p.tenant_id = $1 ORDER BY p.name`,
    [tx.tenantId],
  );
  return rows.map((r) => ({
    id: projectId(r.id), name: r.name, supabaseRef: r.supabase_ref, paused: r.paused,
    lastPolledAt: r.last_polled_at, openIncidents: r.open_incidents, lastRunStatus: r.last_run_status,
    crossTenant: crossTenantCoverage(r.last_unassessed, r.ownership_loaded, r.ownership_empty),
  }));
}

export interface IncidentSummary {
  id: string;
  projectName: string;
  severity: Severity;
  detectors: string[];
  hits: number;
  lastSeenAt: Date;
  summary: { summary?: string } | null;
}

export async function listOpenIncidents(tx: TenantTx, limit = 50): Promise<IncidentSummary[]> {
  const rows = await tx.query<{
    id: string; project_name: string; severity: Severity; detectors: string[]; hits: number;
    last_seen_at: Date; summary: { summary?: string } | null;
  }>(
    `SELECT i.id, p.name AS project_name, i.severity, i.detectors, i.hits, i.last_seen_at, i.summary
     FROM supahound.incidents i
     JOIN supahound.projects p ON p.tenant_id = i.tenant_id AND p.id = i.project_id
     WHERE i.tenant_id = $1 AND i.status = 'open'
     ORDER BY CASE i.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
              i.last_seen_at DESC
     LIMIT $2`,
    [tx.tenantId, limit],
  );
  return rows.map((r) => ({
    id: r.id, projectName: r.project_name, severity: r.severity, detectors: r.detectors, hits: r.hits,
    lastSeenAt: r.last_seen_at, summary: r.summary,
  }));
}

export async function countConnections(tx: TenantTx): Promise<number> {
  const rows = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM supahound.connections WHERE tenant_id = $1", [tx.tenantId]);
  return rows[0]?.n ?? 0;
}

// Supabase OAuth state (decision 012). Only the hash is stored; the row is bound to the user and
// tenant that started the flow, expires after 10 minutes, and is consumed exactly once.
export async function createOAuthState(
  tx: TenantTx,
  input: { userId: string; stateHash: string; codeVerifier: string; expiresAt: Date },
): Promise<void> {
  await tx.query(
    `INSERT INTO supahound.oauth_states (tenant_id, user_id, state_hash, code_verifier, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [tx.tenantId, input.userId, input.stateHash, input.codeVerifier, input.expiresAt],
  );
}

export async function consumeOAuthState(tx: TenantTx, userId: string, stateHash: string, now: Date): Promise<string | null> {
  const rows = await tx.query<{ code_verifier: string }>(
    `UPDATE supahound.oauth_states SET used_at = $4
     WHERE tenant_id = $1 AND state_hash = $2 AND user_id = $3 AND used_at IS NULL AND expires_at > $4
     RETURNING code_verifier`,
    [tx.tenantId, stateHash, userId, now],
  );
  return rows[0]?.code_verifier ?? null;
}
