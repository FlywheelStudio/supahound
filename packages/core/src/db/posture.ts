import type { Severity } from "../detectors/finding.js";
import { countBySeverity, dedupePosture, exposedTables, type SeverityCounts } from "../posture/findings.js";
import type { PostureFinding, PostureSource, SourceStatus } from "../posture/types.js";
import { projectId, type ProjectId } from "../tenancy/scope.js";
import type { TenantTx } from "./tenant.js";

// Posture scan storage (issue #11, decision 038). Every statement repeats tenant_id, as in
// repo.ts. One posture_scans row per project; posture_findings holds each source's latest result.

export interface PostureScanRecord {
  id: string;
  requestedAt: Date | null;
  attemptedAt: Date | null;
  finishedAt: Date | null;
  catalogStatus: SourceStatus | null;
  catalogScannedAt: Date | null;
  advisorStatus: SourceStatus | null;
  advisorScannedAt: Date | null;
  tablesChecked: number | null;
  viewsChecked: number | null;
  policiesChecked: number | null;
}

interface ScanRow {
  id: string; requested_at: Date | null; attempted_at: Date | null; finished_at: Date | null;
  catalog_status: SourceStatus | null; catalog_scanned_at: Date | null; advisor_status: SourceStatus | null;
  advisor_scanned_at: Date | null; tables_checked: number | null; views_checked: number | null; policies_checked: number | null;
}

const SCAN_COLUMNS = `id, requested_at, attempted_at, finished_at, catalog_status, catalog_scanned_at, advisor_status,
  advisor_scanned_at, tables_checked, views_checked, policies_checked`;

const toScan = (r: ScanRow): PostureScanRecord => ({
  id: r.id, requestedAt: r.requested_at, attemptedAt: r.attempted_at, finishedAt: r.finished_at,
  catalogStatus: r.catalog_status, catalogScannedAt: r.catalog_scanned_at, advisorStatus: r.advisor_status,
  advisorScannedAt: r.advisor_scanned_at, tablesChecked: r.tables_checked, viewsChecked: r.views_checked,
  policiesChecked: r.policies_checked,
});

export async function getPostureScan(tx: TenantTx, project: ProjectId): Promise<PostureScanRecord | null> {
  const rows = await tx.query<ScanRow>(
    `SELECT ${SCAN_COLUMNS} FROM supahound.posture_scans WHERE tenant_id = $1 AND project_id = $2`,
    [tx.tenantId, project],
  );
  return rows[0] ? toScan(rows[0]) : null;
}

// A scan "succeeded" when its save ran after the last claim and the catalog read was good.
const SUCCEEDED = "(s.finished_at >= s.attempted_at AND s.catalog_status = 'ok')";
const PENDING = "(s.requested_at IS NOT NULL AND (s.attempted_at IS NULL OR s.requested_at > s.attempted_at))";

// Claims a scan when one is due: never attempted, a "Scan now" is pending, the last success is
// refreshSeconds old, or the last attempt that did not succeed (failed, or lost mid-scan) is
// retrySeconds old. Creates the row on the first scan. The upsert takes the row lock, so two
// workers never both scan. Returns the scan row's id, or null when not due.
export async function claimPostureScan(
  tx: TenantTx,
  project: ProjectId,
  now: Date,
  intervals: { refreshSeconds: number; retrySeconds: number },
): Promise<string | null> {
  const rows = await tx.query<{ id: string }>(
    `INSERT INTO supahound.posture_scans AS s (tenant_id, project_id, attempted_at) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, project_id) DO UPDATE SET attempted_at = EXCLUDED.attempted_at
     WHERE s.attempted_at IS NULL OR ${PENDING}
        OR s.attempted_at <= $3::timestamptz - make_interval(secs =>
             CASE WHEN ${SUCCEEDED} THEN $4::double precision ELSE $5::double precision END)
     RETURNING s.id`,
    [tx.tenantId, project, now, intervals.refreshSeconds, intervals.retrySeconds],
  );
  return rows[0]?.id ?? null;
}

export type SourceResult = { status: "ok"; findings: PostureFinding[] } | { status: Exclude<SourceStatus, "ok"> };

export interface PostureResult {
  catalog: SourceResult & { counts?: { tables: number; views: number; policies: number } };
  advisor: SourceResult | null; // null: the Advisor was not asked
}

// Saves one scan. A source that succeeded replaces its findings; a source that failed keeps its
// last good findings and records the error code.
export async function savePostureScan(tx: TenantTx, project: ProjectId, scanId: string, result: PostureResult, now: Date): Promise<void> {
  for (const [source, r] of [["catalog", result.catalog], ["advisor", result.advisor]] as [PostureSource, SourceResult | null][]) {
    if (r?.status !== "ok") continue;
    await tx.query("DELETE FROM supahound.posture_findings WHERE tenant_id = $1 AND project_id = $2 AND source = $3", [
      tx.tenantId, project, source,
    ]);
    if (r.findings.length === 0) continue;
    await tx.query(
      `INSERT INTO supahound.posture_findings
         (tenant_id, project_id, scan_id, source, check_id, severity, schema_name, object_name, object_type, evidence, found_at)
       SELECT $1, $2, $3, $4, f.check_id, f.severity, f.schema_name, f.object_name, f.object_type, f.evidence, $5
       FROM jsonb_to_recordset($6::jsonb) AS f(check_id text, severity text, schema_name text, object_name text, object_type text, evidence jsonb)`,
      [tx.tenantId, project, scanId, source, now, JSON.stringify(r.findings.map((f) => ({
        check_id: f.check, severity: f.severity, schema_name: f.schema, object_name: f.object, object_type: f.objectType, evidence: f.evidence,
      })))],
    );
  }
  const counts = result.catalog.status === "ok" ? result.catalog.counts ?? null : null;
  await tx.query(
    `UPDATE supahound.posture_scans SET finished_at = $4,
       catalog_status = $5, catalog_scanned_at = CASE WHEN $5 = 'ok' THEN $4 ELSE catalog_scanned_at END,
       advisor_status = COALESCE($6, advisor_status),
       advisor_scanned_at = CASE WHEN $6 = 'ok' THEN $4 ELSE advisor_scanned_at END,
       tables_checked = COALESCE($7, tables_checked), views_checked = COALESCE($8, views_checked),
       policies_checked = COALESCE($9, policies_checked)
     WHERE tenant_id = $1 AND project_id = $2 AND id = $3`,
    [tx.tenantId, project, scanId, now, result.catalog.status, result.advisor?.status ?? null,
      counts?.tables ?? null, counts?.views ?? null, counts?.policies ?? null],
  );
}

export type ScanRequest = "queued" | "already_queued" | "too_soon";

// "Scan now" (decision 038). Refused while a request is pending, and within cooldownSeconds of
// the last attempt. The caller checks the role; RLS refuses viewers too.
export async function requestPostureScan(tx: TenantTx, project: ProjectId, user: string, cooldownSeconds: number): Promise<ScanRequest> {
  const rows = await tx.query<{ id: string }>(
    `INSERT INTO supahound.posture_scans AS s (tenant_id, project_id, requested_at, requested_by) VALUES ($1, $2, now(), $3)
     ON CONFLICT (tenant_id, project_id) DO UPDATE SET requested_at = now(), requested_by = EXCLUDED.requested_by
     WHERE NOT ${PENDING} AND (s.attempted_at IS NULL OR s.attempted_at <= now() - make_interval(secs => $4::double precision))
     RETURNING s.id`,
    [tx.tenantId, project, user, cooldownSeconds],
  );
  if (rows.length === 1) return "queued";
  const scan = await getPostureScan(tx, project);
  const pending = scan?.requestedAt != null && (scan.attemptedAt === null || scan.requestedAt > scan.attemptedAt);
  return pending ? "already_queued" : "too_soon";
}

export interface StoredPostureFinding extends PostureFinding {
  id: string;
  foundAt: Date;
}

interface FindingRow {
  id: string; project_id: string; source: PostureSource; check_id: string; severity: Severity; schema_name: string | null;
  object_name: string | null; object_type: string | null; evidence: PostureFinding["evidence"]; found_at: Date;
}

const toFinding = (r: FindingRow): StoredPostureFinding => ({
  id: r.id, source: r.source, check: r.check_id, severity: r.severity, schema: r.schema_name, object: r.object_name,
  objectType: r.object_type, evidence: r.evidence, foundAt: r.found_at,
});

// One project's findings, Advisor duplicates of catalog findings dropped, worst first.
export async function listPostureFindings(tx: TenantTx, project: ProjectId): Promise<StoredPostureFinding[]> {
  const rows = await tx.query<FindingRow>(
    `SELECT id, project_id, source, check_id, severity, schema_name, object_name, object_type, evidence, found_at
     FROM supahound.posture_findings WHERE tenant_id = $1 AND project_id = $2`,
    [tx.tenantId, project],
  );
  return dedupePosture(rows.map(toFinding));
}

// The tables whose posture raises detections on them (decision 038). No severity filter here:
// exposedTables dedupes first, so a low catalog finding hides the Advisor's high duplicate, as on
// the Posture page.
export async function postureExposedTables(tx: TenantTx, project: ProjectId): Promise<Map<string, string>> {
  const rows = await tx.query<FindingRow>(
    `SELECT id, project_id, source, check_id, severity, schema_name, object_name, object_type, evidence, found_at
     FROM supahound.posture_findings
     WHERE tenant_id = $1 AND project_id = $2 AND schema_name = 'public'`,
    [tx.tenantId, project],
  );
  return exposedTables(rows.map(toFinding));
}

export interface PostureSummary {
  projectId: ProjectId;
  scan: PostureScanRecord | null;
  counts: SeverityCounts;
}

// Every visible project's scan state and finding counts, for the overview and the dashboard.
// RLS hides the projects the signed-in user has no role on.
export async function postureSummaries(tx: TenantTx): Promise<Map<ProjectId, PostureSummary>> {
  const scans = await tx.query<ScanRow & { project_id: string }>(
    `SELECT project_id, ${SCAN_COLUMNS} FROM supahound.posture_scans WHERE tenant_id = $1`,
    [tx.tenantId],
  );
  const findings = await tx.query<FindingRow>(
    `SELECT id, project_id, source, check_id, severity, schema_name, object_name, object_type, '{}'::jsonb AS evidence, found_at
     FROM supahound.posture_findings WHERE tenant_id = $1`,
    [tx.tenantId],
  );
  const byProject = new Map<string, StoredPostureFinding[]>();
  for (const r of findings) byProject.set(r.project_id, [...(byProject.get(r.project_id) ?? []), toFinding(r)]);
  const out = new Map<ProjectId, PostureSummary>();
  for (const s of scans) {
    const id = projectId(s.project_id);
    out.set(id, { projectId: id, scan: toScan(s), counts: countBySeverity(byProject.get(s.project_id) ?? []) });
  }
  return out;
}
