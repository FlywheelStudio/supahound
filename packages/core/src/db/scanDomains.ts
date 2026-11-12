import type { ScanSeverity } from "../scan/secrets.js";
import { domainId, type DomainId, type ProjectId } from "../tenancy/scope.js";
import type { TenantTx } from "./tenant.js";

// Scan domains per project (issue #100, decisions 034 and 040). Every statement repeats
// tenant_id, as in repo.ts. A verified scan domain belongs to at most one project through
// supahound.scan_domain_links. RLS refuses links by anyone but the project's owners and admins,
// and a trigger refuses an unverified domain; the functions here return an outcome first, so a
// refused write never reaches the database in normal use.

export interface ScanDomain {
  id: DomainId;
  apex: string;
}

export interface LinkedDomain extends ScanDomain {
  linkedAt: Date;
}

// The domains linked to one project, by apex.
export async function listProjectDomains(tx: TenantTx, project: ProjectId): Promise<LinkedDomain[]> {
  const rows = await tx.query<{ id: string; apex: string; linked_at: Date }>(
    `SELECT d.id, d.apex, l.linked_at
     FROM supahound.scan_domain_links l
     JOIN supahound.scan_domains d ON d.tenant_id = l.tenant_id AND d.id = l.domain_id
     WHERE l.tenant_id = $1 AND l.project_id = $2
     ORDER BY d.apex`,
    [tx.tenantId, project],
  );
  return rows.map((r) => ({ id: domainId(r.id), apex: r.apex, linkedAt: r.linked_at }));
}

// Verified domains with no project yet. RLS shows unlinked domains only to workspace owners and
// admins (decision 040), so for anyone else this is empty.
export async function listLinkableDomains(tx: TenantTx): Promise<ScanDomain[]> {
  const rows = await tx.query<{ id: string; apex: string }>(
    `SELECT d.id, d.apex FROM supahound.scan_domains d
     WHERE d.tenant_id = $1 AND d.verified_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM supahound.scan_domain_links l WHERE l.tenant_id = d.tenant_id AND l.domain_id = d.id)
     ORDER BY d.apex`,
    [tx.tenantId],
  );
  return rows.map((r) => ({ id: domainId(r.id), apex: r.apex }));
}

// linked: done. already: linked to this project before. taken: linked to another project (never
// named: the caller may have no role on it). unverified: not verified, or not visible to the caller.
export type LinkOutcome = "linked" | "already" | "taken" | "unverified";

export async function linkDomain(tx: TenantTx, project: ProjectId, domain: DomainId, by: string | null): Promise<LinkOutcome> {
  const [d] = await tx.query<{ verified: boolean }>(
    "SELECT verified_at IS NOT NULL AS verified FROM supahound.scan_domains WHERE tenant_id = $1 AND id = $2",
    [tx.tenantId, domain],
  );
  if (!d?.verified) return "unverified";
  const inserted = await tx.query<{ domain_id: string }>(
    `INSERT INTO supahound.scan_domain_links (tenant_id, domain_id, project_id, linked_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, domain_id) DO NOTHING RETURNING domain_id`,
    [tx.tenantId, domain, project, by],
  );
  if (inserted.length > 0) return "linked";
  const [existing] = await tx.query<{ project_id: string }>(
    "SELECT project_id FROM supahound.scan_domain_links WHERE tenant_id = $1 AND domain_id = $2",
    [tx.tenantId, domain],
  );
  return existing?.project_id === project ? "already" : "taken";
}

// Detaches a domain from this project. False when it was not linked to this project.
export async function unlinkDomain(tx: TenantTx, project: ProjectId, domain: DomainId): Promise<boolean> {
  const rows = await tx.query(
    "DELETE FROM supahound.scan_domain_links WHERE tenant_id = $1 AND domain_id = $2 AND project_id = $3 RETURNING domain_id",
    [tx.tenantId, domain, project],
  );
  return rows.length > 0;
}

export type ScanStatus = "queued" | "running" | "done" | "failed";

export interface ScanFindingRecord {
  id: string;
  severity: ScanSeverity;
  type: string;
  endpoint: string | null;
  // Structured evidence as stored. The web app shows an allowlist of keys only (lib/scanDomains.ts).
  evidence: Record<string, unknown>;
  fix: string | null;
  supahoundMonitor: string | null;
}

export interface DomainScanResult extends LinkedDomain {
  // The newest finished scan, or null when no scan of this domain has finished.
  latest: { id: string; finishedAt: Date | null; score: number | null; findings: ScanFindingRecord[] } | null;
  // The status of a scan newer than `latest` that has not finished (queued, running or failed).
  newer: Exclude<ScanStatus, "done"> | null;
}

// Most findings shown per scan. A scan rarely has more; the page says when it cuts the list.
export const MAX_FINDINGS_PER_SCAN = 200;

const SEVERITY_ORDER = "CASE f.severity WHEN 'critical' THEN 5 WHEN 'high' THEN 4 WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1 END";

// For the project's Security scan tab: each linked domain with its latest finished scan's findings,
// most severe first.
export async function projectScanResults(tx: TenantTx, project: ProjectId): Promise<DomainScanResult[]> {
  const domains = await tx.query<{
    id: string; apex: string; linked_at: Date; scan_id: string | null; finished_at: Date | null; score: number | null; last_status: ScanStatus | null;
  }>(
    `SELECT d.id, d.apex, l.linked_at, done.id AS scan_id, done.finished_at, done.score, last.status AS last_status
     FROM supahound.scan_domain_links l
     JOIN supahound.scan_domains d ON d.tenant_id = l.tenant_id AND d.id = l.domain_id
     LEFT JOIN LATERAL (
       SELECT s.id, s.finished_at, s.score FROM supahound.scans s
       WHERE s.tenant_id = l.tenant_id AND s.domain_id = l.domain_id AND s.status = 'done'
       ORDER BY s.created_at DESC, s.id DESC LIMIT 1
     ) done ON true
     LEFT JOIN LATERAL (
       SELECT s.status FROM supahound.scans s
       WHERE s.tenant_id = l.tenant_id AND s.domain_id = l.domain_id
       ORDER BY s.created_at DESC, s.id DESC LIMIT 1
     ) last ON true
     WHERE l.tenant_id = $1 AND l.project_id = $2
     ORDER BY d.apex`,
    [tx.tenantId, project],
  );
  const scanIds = domains.map((d) => d.scan_id).filter((id): id is string => id !== null);
  const findings = scanIds.length === 0 ? [] : await tx.query<{
    id: string; scan_id: string; severity: ScanSeverity; type: string; endpoint: string | null;
    evidence: Record<string, unknown>; fix: string | null; supahound_monitor: string | null; n: number;
  }>(
    `SELECT * FROM (
       SELECT f.id, f.scan_id, f.severity, f.type, f.endpoint, f.evidence, f.fix, f.supahound_monitor,
              row_number() OVER (PARTITION BY f.scan_id ORDER BY ${SEVERITY_ORDER} DESC, f.type, f.id)::int AS n
       FROM supahound.scan_findings f
       WHERE f.tenant_id = $1 AND f.scan_id = ANY($2::uuid[])
     ) ranked WHERE n <= $3 ORDER BY scan_id, n`,
    [tx.tenantId, scanIds, MAX_FINDINGS_PER_SCAN],
  );
  const byScan = new Map<string, ScanFindingRecord[]>();
  for (const f of findings) {
    const list = byScan.get(f.scan_id) ?? [];
    list.push({
      id: f.id, severity: f.severity, type: f.type, endpoint: f.endpoint, evidence: f.evidence, fix: f.fix,
      supahoundMonitor: f.supahound_monitor,
    });
    byScan.set(f.scan_id, list);
  }
  return domains.map((d): DomainScanResult => ({
    id: domainId(d.id),
    apex: d.apex,
    linkedAt: d.linked_at,
    latest: d.scan_id ? { id: d.scan_id, finishedAt: d.finished_at, score: d.score, findings: byScan.get(d.scan_id) ?? [] } : null,
    newer: d.last_status && d.last_status !== "done" ? d.last_status : null,
  }));
}
