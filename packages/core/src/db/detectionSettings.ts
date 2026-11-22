import { safeIdentifier } from "../detectors/finding.js";
import { isRpcBurstHits } from "../detectors/rpcExposure.js";
import { safeName } from "../posture/catalog.js";
import type { ProjectId } from "../tenancy/scope.js";
import { appendAudit } from "./repo.js";
import type { TenantTx } from "./tenant.js";

// Per-project detection settings (issue #160, decision 045). Every statement repeats tenant_id, as
// in repo.ts, and every change writes an audit row in the same transaction. The callers check the
// project role; RLS refuses the same writes again (migration 20261122150000).

// A table name the mark may hold: what the anon-read detector can match (safeIdentifier: lower
// case, at most 63 characters) and what posture stores (safeName). Anything else is null.
export function publicTableName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return safeName(value) === null ? null : safeIdentifier(value);
}

export interface PublicTableMark {
  table: string;
  markedAt: Date;
}

// The tables in `public` this project's Owners or Admins marked intentionally public, by name.
export async function listPublicTables(tx: TenantTx, project: ProjectId): Promise<PublicTableMark[]> {
  const rows = await tx.query<{ table_name: string; marked_at: Date }>(
    `SELECT table_name, marked_at FROM supahound.public_tables
     WHERE tenant_id = $1 AND project_id = $2 ORDER BY table_name`,
    [tx.tenantId, project],
  );
  return rows.map((r) => ({ table: r.table_name, markedAt: r.marked_at }));
}

export async function publicTableSet(tx: TenantTx, project: ProjectId): Promise<Set<string>> {
  return new Set((await listPublicTables(tx, project)).map((m) => m.table));
}

// Every visible project's marks, for the overview's posture counts.
export async function publicTablesByProject(tx: TenantTx): Promise<Map<string, Set<string>>> {
  const rows = await tx.query<{ project_id: string; table_name: string }>(
    "SELECT project_id, table_name FROM supahound.public_tables WHERE tenant_id = $1",
    [tx.tenantId],
  );
  const out = new Map<string, Set<string>>();
  for (const r of rows) out.set(r.project_id, (out.get(r.project_id) ?? new Set()).add(r.table_name));
  return out;
}

export type MarkOutcome = "marked" | "already" | "invalid";

// Marks a table intentionally public. by: the signed-in user (null for a system write).
export async function markPublicTable(tx: TenantTx, project: ProjectId, table: string, by: string | null): Promise<MarkOutcome> {
  const name = publicTableName(table);
  if (name === null) return "invalid";
  const rows = await tx.query<{ id: string }>(
    `INSERT INTO supahound.public_tables (tenant_id, project_id, table_name, marked_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, project_id, table_name) DO NOTHING RETURNING id`,
    [tx.tenantId, project, name, by],
  );
  if (rows.length === 0) return "already";
  await appendAudit(tx, { projectId: project, action: "detection_setting", detail: { setting: "public_table", change: "mark", table: name, by } });
  return "marked";
}

// Removes the mark. False when the table was not marked.
export async function unmarkPublicTable(tx: TenantTx, project: ProjectId, table: string, by: string | null): Promise<boolean> {
  const name = publicTableName(table);
  if (name === null) return false;
  const rows = await tx.query(
    "DELETE FROM supahound.public_tables WHERE tenant_id = $1 AND project_id = $2 AND table_name = $3 RETURNING id",
    [tx.tenantId, project, name],
  );
  if (rows.length === 0) return false;
  await appendAudit(tx, { projectId: project, action: "detection_setting", detail: { setting: "public_table", change: "unmark", table: name, by } });
  return true;
}

// Sets detector 12's paging threshold. False when the value is out of range or the project is not
// there (or RLS refused the update). An unchanged value writes no audit row.
export async function setRpcBurstHits(tx: TenantTx, project: ProjectId, hits: number, by: string | null): Promise<boolean> {
  if (!isRpcBurstHits(hits)) return false;
  const rows = await tx.query<{ previous: number }>(
    `UPDATE supahound.projects p SET rpc_burst_hits = $3
     FROM (SELECT rpc_burst_hits AS previous FROM supahound.projects WHERE tenant_id = $1 AND id = $2 FOR UPDATE) old
     WHERE p.tenant_id = $1 AND p.id = $2 RETURNING old.previous`,
    [tx.tenantId, project, hits],
  );
  const previous = rows[0]?.previous;
  if (previous === undefined) return false;
  if (previous !== hits) {
    await appendAudit(tx, { projectId: project, action: "detection_setting", detail: { setting: "rpc_burst_hits", from: previous, to: hits, by } });
  }
  return true;
}
