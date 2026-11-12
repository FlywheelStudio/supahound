import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { POLLABLE_STATUSES } from "../billing/policy.js";
import type { AlertLevel } from "../alerts/email.js";
import type { Finding, Severity } from "../detectors/finding.js";
import type { OwnershipMap } from "../ownership/ownership.js";
import { connectionId, projectId, projectScope, tenantId, type ConnectionId, type ProjectId, type ProjectScope, type TenantId } from "../tenancy/scope.js";
import type { TokenVault } from "../vault/vault.js";
import type { BillingMode } from "./billing.js";
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
  name: string;
  connectionId: ConnectionId;
  supabaseRef: string;
  ownership: OwnershipMap;
  // The last successful read of the project's RLS policies; null = never loaded (decision 024).
  ownershipRefreshedAt: Date | null;
  ownershipAttemptedAt: Date | null;
  ownershipError: string | null;
  expectedAsns: number[];
  paused: boolean;
  // The lowest severity that emails members, or "off" (decision 030).
  emailAlerts: AlertLevel;
}

export async function getProject(tx: TenantTx, id: ProjectId): Promise<ProjectRecord | null> {
  const rows = await tx.query<{
    connection_id: string; supabase_ref: string; ownership: OwnershipMap; expected_asns: number[]; paused: boolean;
    ownership_refreshed_at: Date | null; ownership_attempted_at: Date | null; ownership_error: string | null;
    email_alerts: AlertLevel; name: string;
  }>(
    `SELECT name, connection_id, supabase_ref, ownership, expected_asns, paused,
            ownership_refreshed_at, ownership_attempted_at, ownership_error, email_alerts
     FROM supahound.projects WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    scope: projectScope(tx.tenantId, id),
    name: r.name,
    connectionId: connectionId(r.connection_id),
    supabaseRef: r.supabase_ref,
    ownership: r.ownership,
    ownershipRefreshedAt: r.ownership_refreshed_at,
    ownershipAttemptedAt: r.ownership_attempted_at,
    ownershipError: r.ownership_error,
    expectedAsns: r.expected_asns,
    paused: r.paused,
    emailAlerts: r.email_alerts,
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
// refreshSeconds, or the last unsaved attempt (failed, or lost mid-read) older than retrySeconds. The conditional update takes the
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
                 CASE WHEN ownership_refreshed_at >= ownership_attempted_at THEN $4::double precision ELSE $5::double precision END))
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
  // The severity of the last alert email; null when none went out (decision 030).
  alertedSeverity?: Severity | null;
}

export async function openIncidents(tx: TenantTx, id: ProjectId): Promise<IncidentRecord[]> {
  const rows = await tx.query<{
    id: string; actor: string; severity: Severity; detectors: string[]; signals: string[];
    finding_count: number; hits: number; opened_at: Date; last_seen_at: Date; alerted_severity: Severity | null;
  }>(
    `SELECT id, actor, severity, detectors, signals, finding_count, hits, opened_at, last_seen_at, alerted_severity
     FROM supahound.incidents WHERE tenant_id = $1 AND project_id = $2 AND status = 'open'`,
    [tx.tenantId, id],
  );
  return rows.map((r) => ({
    id: r.id, actor: r.actor, severity: r.severity, detectors: r.detectors, signals: r.signals,
    findingCount: r.finding_count, hits: r.hits, openedAt: r.opened_at, lastSeenAt: r.last_seen_at,
    alertedSeverity: r.alerted_severity,
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

export type AuditAction = "logs_query" | "policies_query" | "model_call" | "alert_email";

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
//
// billing "stripe" skips tenants whose subscription may not be polled (decision 028), unless the
// workspace is exempt (decision 029); "off" is for self-hosting without billing. The scheduler
// reads billing_accounts (tenant_id, status, exempt_at) only. A membership trigger clears
// exempt_at when the owners change, so the scheduler needs no access to memberships.
export async function dueProjects(
  schedulerPool: Pool,
  olderThanSeconds: number,
  limit: number,
  billing: BillingMode,
): Promise<ProjectScope[]> {
  const res = await schedulerPool.query<{ tenant_id: string; id: string }>(
    billing === "off"
      ? `SELECT p.tenant_id, p.id FROM supahound.projects p
         WHERE NOT p.paused AND (p.last_polled_at IS NULL OR p.last_polled_at < now() - make_interval(secs => $1))
         ORDER BY p.last_polled_at NULLS FIRST
         LIMIT $2`
      : `SELECT p.tenant_id, p.id FROM supahound.projects p
         JOIN supahound.billing_accounts b ON b.tenant_id = p.tenant_id AND (b.status = ANY($3::text[]) OR b.exempt_at IS NOT NULL)
         WHERE NOT p.paused AND (p.last_polled_at IS NULL OR p.last_polled_at < now() - make_interval(secs => $1))
         ORDER BY p.last_polled_at NULLS FIRST
         LIMIT $2`,
    billing === "off" ? [olderThanSeconds, limit] : [olderThanSeconds, limit, POLLABLE_STATUSES],
  );
  return res.rows.map((r) => projectScope(tenantId(r.tenant_id), r.id));
}

// The tenants whose subscription allows polling, for the daily usage count (decision 028).
// Scheduler role: reads billing_accounts (tenant_id, status) only.
export async function billedTenants(schedulerPool: Pool): Promise<TenantId[]> {
  const res = await schedulerPool.query<{ tenant_id: string }>(
    "SELECT tenant_id FROM supahound.billing_accounts WHERE status = ANY($1::text[]) ORDER BY tenant_id",
    [POLLABLE_STATUSES],
  );
  return res.rows.map((r) => tenantId(r.tenant_id));
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
  emailAlerts: AlertLevel;
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
    last_unassessed: string[] | null; ownership_loaded: boolean; ownership_empty: boolean; email_alerts: AlertLevel;
  }>(
    `SELECT p.id, p.name, p.supabase_ref, p.paused, p.last_polled_at, p.email_alerts,
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
    emailAlerts: r.email_alerts,
  }));
}

export interface IncidentSummary {
  id: string;
  projectId: ProjectId;
  projectName: string;
  severity: Severity;
  detectors: string[];
  hits: number;
  lastSeenAt: Date;
  summary: { summary?: string } | null;
}

// Open incidents, worst first. With `project`, only that project's (the project dashboard).
export async function listOpenIncidents(tx: TenantTx, limit = 50, project?: ProjectId): Promise<IncidentSummary[]> {
  const rows = await tx.query<{
    id: string; project_id: string; project_name: string; severity: Severity; detectors: string[]; hits: number;
    last_seen_at: Date; summary: { summary?: string } | null;
  }>(
    `SELECT i.id, i.project_id, p.name AS project_name, i.severity, i.detectors, i.hits, i.last_seen_at, i.summary
     FROM supahound.incidents i
     JOIN supahound.projects p ON p.tenant_id = i.tenant_id AND p.id = i.project_id
     WHERE i.tenant_id = $1 AND i.status = 'open' AND ($3::uuid IS NULL OR i.project_id = $3::uuid)
     ORDER BY CASE i.severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
              i.last_seen_at DESC
     LIMIT $2`,
    [tx.tenantId, limit, project ?? null],
  );
  return rows.map((r) => ({
    id: r.id, projectId: projectId(r.project_id), projectName: r.project_name, severity: r.severity, detectors: r.detectors, hits: r.hits,
    lastSeenAt: r.last_seen_at, summary: r.summary,
  }));
}

// Incident history (issue #44, decision 035). The window: last seen in the last 30 days, or still
// open. The engine resolves an incident only when its actor acts again after the 15-minute window,
// so an actor who goes quiet leaves the incident open; it must stay reachable from the dashboard.

export const INCIDENT_HISTORY_DAYS = 30;

// Keyset position: the last row of a page. `lastSeenUs` is epoch microseconds as a decimal string,
// read from SQL. A JS Date holds milliseconds only, so a cursor built from one would skip rows
// that differ in the microseconds.
export interface IncidentCursor {
  lastSeenUs: string;
  id: string;
}

export interface IncidentHistoryItem {
  id: string;
  status: "open" | "resolved";
  actor: string;
  severity: Severity;
  detectors: string[];
  signals: string[];
  findingCount: number;
  hits: number;
  openedAt: Date;
  lastSeenAt: Date;
  summary: unknown;
}

export interface IncidentDetail extends IncidentHistoryItem {
  summarySource: "model" | "template" | null;
}

const IN_WINDOW = `(i.status = 'open' OR i.last_seen_at >= $3::timestamptz - make_interval(days => ${INCIDENT_HISTORY_DAYS}))`;
const US_TO_TS = (param: string) => `(timestamptz 'epoch' + ${param}::bigint * interval '1 microsecond')`;

interface IncidentRow {
  id: string; status: "open" | "resolved"; actor: string; severity: Severity; detectors: string[]; signals: string[];
  finding_count: number; hits: number; opened_at: Date; last_seen_at: Date; summary: unknown;
  summary_source: "model" | "template" | null; last_seen_us: string;
}

const INCIDENT_COLUMNS = `i.id, i.status, i.actor, i.severity, i.detectors, i.signals, i.finding_count, i.hits,
  i.opened_at, i.last_seen_at, i.summary, i.summary_source,
  ((extract(epoch FROM i.last_seen_at) * 1000000)::numeric(20,0))::text AS last_seen_us`;

const toHistoryItem = (r: IncidentRow): IncidentHistoryItem => ({
  id: r.id, status: r.status, actor: r.actor, severity: r.severity, detectors: r.detectors, signals: r.signals,
  findingCount: r.finding_count, hits: r.hits, openedAt: r.opened_at, lastSeenAt: r.last_seen_at, summary: r.summary,
});

// One project's incidents in the window, newest first (last seen, then id). Pass the previous
// page's `next` as `after`. `next` is null on the last page.
export async function listIncidentHistory(
  tx: TenantTx,
  project: ProjectId,
  opts: { now: Date; limit: number; after?: IncidentCursor | null },
): Promise<{ incidents: IncidentHistoryItem[]; next: IncidentCursor | null }> {
  const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit)));
  const after = opts.after ?? null;
  const rows = await tx.query<IncidentRow>(
    `SELECT ${INCIDENT_COLUMNS}
     FROM supahound.incidents i
     WHERE i.tenant_id = $1 AND i.project_id = $2 AND ${IN_WINDOW}
       AND ($4::text IS NULL OR (i.last_seen_at, i.id) < (${US_TO_TS("$4")}, $5::uuid))
     ORDER BY i.last_seen_at DESC, i.id DESC
     LIMIT $6`,
    [tx.tenantId, project, opts.now, after?.lastSeenUs ?? null, after?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    incidents: page.map(toHistoryItem),
    next: rows.length > limit && last ? { lastSeenUs: last.last_seen_us, id: last.id } : null,
  };
}

// One incident of this project, in the window; null otherwise. Another project's or another
// tenant's incident ID is null too, so the page answers 404 in every case.
export async function getIncident(tx: TenantTx, project: ProjectId, incidentId: string, now: Date): Promise<IncidentDetail | null> {
  const rows = await tx.query<IncidentRow>(
    `SELECT ${INCIDENT_COLUMNS}
     FROM supahound.incidents i
     WHERE i.tenant_id = $1 AND i.project_id = $2 AND ${IN_WINDOW} AND i.id = $4::uuid`,
    [tx.tenantId, project, now, incidentId],
  );
  const r = rows[0];
  return r ? { ...toHistoryItem(r), summarySource: r.summary_source } : null;
}

export interface ConnectionSummary {
  id: ConnectionId;
  label: string;
  createdAt: Date;
}

export async function listConnections(tx: TenantTx): Promise<ConnectionSummary[]> {
  const rows = await tx.query<{ id: string; label: string; created_at: Date }>(
    "SELECT id, label, created_at FROM supahound.connections WHERE tenant_id = $1 ORDER BY created_at, id",
    [tx.tenantId],
  );
  return rows.map((r) => ({ id: connectionId(r.id), label: r.label, createdAt: r.created_at }));
}

// The project picker (issue #9). A ref already watched in this tenant is skipped, so a double
// submit or two admins picking at once never fails and never duplicates. Returns the refs added.
export async function watchProjects(
  tx: TenantTx,
  connection: ConnectionId,
  projects: { ref: string; name: string }[],
): Promise<string[]> {
  if (projects.length === 0) return [];
  const rows = await tx.query<{ supabase_ref: string }>(
    `INSERT INTO supahound.projects (tenant_id, connection_id, supabase_ref, name)
     SELECT $1, $2, p.ref, p.name FROM unnest($3::text[], $4::text[]) AS p(ref, name)
     ON CONFLICT (tenant_id, supabase_ref) DO NOTHING
     RETURNING supabase_ref`,
    [tx.tenantId, connection, projects.map((p) => p.ref), projects.map((p) => p.name)],
  );
  return rows.map((r) => r.supabase_ref);
}

// Stops watching a project. Its incidents, findings and poll runs go with it (cascade); its
// audit_log rows stay with project_id set to null (decision 022). The caller confirms the name.
export async function removeProject(tx: TenantTx, id: ProjectId): Promise<boolean> {
  const rows = await tx.query("DELETE FROM supahound.projects WHERE tenant_id = $1 AND id = $2 RETURNING id", [tx.tenantId, id]);
  return rows.length === 1;
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

// Incident alert email (issue #16, decision 030). The incident row is the outbox.

// Open incidents of this project that should email now: at or above the project's threshold,
// with no email yet at this severity or higher. A failed send leaves the row pending, so the
// next poll retries it; an escalation makes it pending again.
export interface PendingAlert {
  id: string;
  actor: string;
  severity: Severity;
  alertedSeverity: Severity | null;
  detectors: string[];
  signals: string[];
  findingCount: number;
  hits: number;
  openedAt: Date;
  lastSeenAt: Date;
  summary: { summary: string; likelyImpact: string; nextSteps: string[] } | null;
}

const RANK_SQL = (col: string) => `array_position(ARRAY['low','medium','high','critical']::text[], ${col})`;

export async function pendingAlerts(tx: TenantTx, id: ProjectId): Promise<PendingAlert[]> {
  const rows = await tx.query<{
    id: string; actor: string; severity: Severity; alerted_severity: Severity | null; detectors: string[];
    signals: string[]; finding_count: number; hits: number; opened_at: Date; last_seen_at: Date;
    summary: PendingAlert["summary"];
  }>(
    `SELECT i.id, i.actor, i.severity, i.alerted_severity, i.detectors, i.signals, i.finding_count, i.hits,
            i.opened_at, i.last_seen_at, i.summary
     FROM supahound.incidents i
     JOIN supahound.projects p ON p.tenant_id = i.tenant_id AND p.id = i.project_id
     WHERE i.tenant_id = $1 AND i.project_id = $2 AND i.status = 'open' AND p.email_alerts <> 'off'
       AND ${RANK_SQL("i.severity")} >= ${RANK_SQL("p.email_alerts")}
       AND (i.alerted_severity IS NULL OR ${RANK_SQL("i.alerted_severity")} < ${RANK_SQL("i.severity")})
     ORDER BY ${RANK_SQL("i.severity")} DESC, i.opened_at`,
    [tx.tenantId, id],
  );
  return rows.map((r) => ({
    id: r.id, actor: r.actor, severity: r.severity, alertedSeverity: r.alerted_severity, detectors: r.detectors,
    signals: r.signals, findingCount: r.finding_count, hits: r.hits, openedAt: r.opened_at, lastSeenAt: r.last_seen_at,
    summary: r.summary,
  }));
}

// Records that an email went out at this severity. Never lowers a recorded severity.
export async function markAlerted(tx: TenantTx, incidentId: string, severity: Severity): Promise<void> {
  await tx.query(
    `UPDATE supahound.incidents SET alerted_severity = $3
     WHERE tenant_id = $1 AND id = $2
       AND (alerted_severity IS NULL OR ${RANK_SQL("alerted_severity")} < ${RANK_SQL("$3::text")})`,
    [tx.tenantId, incidentId, severity],
  );
}

// Every member of the tenant with a known address, deduplicated.
export async function alertRecipients(tx: TenantTx): Promise<string[]> {
  const rows = await tx.query<{ email: string }>(
    `SELECT DISTINCT lower(email) AS email FROM supahound.memberships
     WHERE tenant_id = $1 AND email IS NOT NULL ORDER BY 1`,
    [tx.tenantId],
  );
  return rows.map((r) => r.email);
}

const EMAIL_RE = /^[^\s@<>,;"]+@[^\s@<>,;"]+$/;

export function isStorableEmail(email: string | null | undefined): email is string {
  return typeof email === "string" && email.length >= 3 && email.length <= 320 && EMAIL_RE.test(email);
}

// Copies the signed-in member's address (from verified JWT claims only) onto their membership in
// this tenant. Writes only when it changed. Returns true when it wrote.
export async function recordMemberEmail(tx: TenantTx, user: string, email: string | null | undefined): Promise<boolean> {
  if (!isStorableEmail(email)) return false;
  const rows = await tx.query(
    `UPDATE supahound.memberships SET email = $3
     WHERE tenant_id = $1 AND user_id = $2 AND email IS DISTINCT FROM $3 RETURNING user_id`,
    [tx.tenantId, user, email],
  );
  return rows.length === 1;
}

// Sets a project's alert threshold. The caller checks the member's role.
export async function setEmailAlerts(tx: TenantTx, id: ProjectId, level: AlertLevel): Promise<boolean> {
  const rows = await tx.query(
    "UPDATE supahound.projects SET email_alerts = $3 WHERE tenant_id = $1 AND id = $2 RETURNING id",
    [tx.tenantId, id, level],
  );
  return rows.length === 1;
}
