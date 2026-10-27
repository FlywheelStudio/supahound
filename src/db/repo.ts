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
  await tx.query("INSERT INTO guardbase.tenants (id, name) VALUES ($1, $2)", [tx.tenantId, name]);
}

export async function createConnection(
  tx: TenantTx,
  vault: TokenVault,
  input: { label: string; token: string },
): Promise<ConnectionId> {
  const id = connectionId(randomUUID());
  const sealed = vault.seal(input.token, { tenantId: tx.tenantId, connectionId: id });
  await tx.query(
    `INSERT INTO guardbase.connections (id, tenant_id, label, sealed_token, key_version)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, tx.tenantId, input.label, sealed, vault.keyVersionOf(sealed)],
  );
  return id;
}

export async function openConnectionToken(tx: TenantTx, vault: TokenVault, id: ConnectionId): Promise<string> {
  const rows = await tx.query<{ sealed_token: Buffer }>(
    "SELECT sealed_token FROM guardbase.connections WHERE tenant_id = $1 AND id = $2",
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
    `INSERT INTO guardbase.projects (tenant_id, connection_id, supabase_ref, name)
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
  expectedAsns: number[];
  paused: boolean;
}

export async function getProject(tx: TenantTx, id: ProjectId): Promise<ProjectRecord | null> {
  const rows = await tx.query<{
    connection_id: string; supabase_ref: string; ownership: OwnershipMap; expected_asns: number[]; paused: boolean;
  }>(
    `SELECT connection_id, supabase_ref, ownership, expected_asns, paused
     FROM guardbase.projects WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    scope: projectScope(tx.tenantId, id),
    connectionId: connectionId(r.connection_id),
    supabaseRef: r.supabase_ref,
    ownership: r.ownership,
    expectedAsns: r.expected_asns,
    paused: r.paused,
  };
}

export async function setOwnership(tx: TenantTx, id: ProjectId, ownership: OwnershipMap): Promise<void> {
  await tx.query("UPDATE guardbase.projects SET ownership = $3 WHERE tenant_id = $1 AND id = $2", [
    tx.tenantId, id, JSON.stringify(ownership),
  ]);
}

export async function markPolled(tx: TenantTx, id: ProjectId, at: Date): Promise<void> {
  await tx.query("UPDATE guardbase.projects SET last_polled_at = $3 WHERE tenant_id = $1 AND id = $2", [tx.tenantId, id, at]);
}

export async function loadNetworks(tx: TenantTx, id: ProjectId): Promise<number[]> {
  const rows = await tx.query<{ asn: number }>(
    "SELECT asn FROM guardbase.service_role_networks WHERE tenant_id = $1 AND project_id = $2 ORDER BY asn",
    [tx.tenantId, id],
  );
  return rows.map((r) => r.asn);
}

export async function saveNetworks(tx: TenantTx, id: ProjectId, asns: number[]): Promise<void> {
  if (asns.length === 0) return;
  await tx.query(
    `INSERT INTO guardbase.service_role_networks (tenant_id, project_id, asn)
     SELECT $1, $2, unnest($3::integer[]) ON CONFLICT DO NOTHING`,
    [tx.tenantId, id, asns],
  );
}

export async function startPollRun(tx: TenantTx, id: ProjectId, window: { start: Date; end: Date }): Promise<string> {
  const rows = await tx.query<{ id: string }>(
    `INSERT INTO guardbase.poll_runs (tenant_id, project_id, window_start, window_end)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [tx.tenantId, id, window.start, window.end],
  );
  return rows[0]!.id;
}

export async function finishPollRun(
  tx: TenantTx,
  runId: string,
  result: { status: "ok" | "unable_to_assess"; errorCode?: string; templates?: number; findings?: number },
): Promise<void> {
  await tx.query(
    `UPDATE guardbase.poll_runs
     SET status = $3, error_code = $4, templates = $5, findings = $6, finished_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [tx.tenantId, runId, result.status, result.errorCode ?? null, result.templates ?? null, result.findings ?? null],
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
      `INSERT INTO guardbase.findings
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
     FROM guardbase.incidents WHERE tenant_id = $1 AND project_id = $2 AND status = 'open'`,
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
      `INSERT INTO guardbase.incidents
         (tenant_id, project_id, actor, status, severity, detectors, signals, finding_count, hits, opened_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [tx.tenantId, id, incident.actor, incident.status, incident.severity, incident.detectors, incident.signals,
        incident.findingCount, incident.hits, incident.openedAt, incident.lastSeenAt],
    );
    return rows[0]!.id;
  }
  await tx.query(
    `UPDATE guardbase.incidents
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
    `UPDATE guardbase.incidents SET summary = $3, summary_source = $4, updated_at = now()
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
    "INSERT INTO guardbase.audit_log (tenant_id, project_id, action, detail) VALUES ($1, $2, $3, $4)",
    [tx.tenantId, entry.projectId, entry.action, JSON.stringify(entry.detail)],
  );
}

// Scheduler path. Runs on a pool that logs in as a member of guardbase_scheduler, which can read
// project IDs and poll times and nothing else. Returns scopes only; each job then opens its own
// tenant transaction.
export async function dueProjects(schedulerPool: Pool, olderThanSeconds: number, limit: number): Promise<ProjectScope[]> {
  const res = await schedulerPool.query<{ tenant_id: string; id: string }>(
    `SELECT tenant_id, id FROM guardbase.projects
     WHERE NOT paused AND (last_polled_at IS NULL OR last_polled_at < now() - make_interval(secs => $1))
     ORDER BY last_polled_at NULLS FIRST
     LIMIT $2`,
    [olderThanSeconds, limit],
  );
  return res.rows.map((r) => projectScope(tenantId(r.tenant_id), r.id));
}
