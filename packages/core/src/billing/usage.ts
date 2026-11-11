import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { EnvVars } from "../config/fields.js";
import { saveDailyUsage } from "../db/billing.js";
import { appendAudit } from "../db/repo.js";
import { withTenant } from "../db/tenant.js";
import type { LogsQuery } from "../logs/client.js";
import { edgeRequestCountSql } from "../logs/sql.js";
import { accessTokenFor } from "../supabase/credentials.js";
import type { OAuthClient } from "../supabase/oauth.js";
import type { ConnectionId, ProjectId, TenantId } from "../tenancy/scope.js";
import type { TokenVault } from "../vault/vault.js";

// The daily usage count (decision 028). Once a day, for one tenant, counts each watched project's
// edge-log requests for the previous UTC day: one count query per project, audited like every
// other query Supahound runs on a customer project. A project whose count fails gets no row for
// that day, which can only lower its 30-day total, never raise it.

export interface UsageDeps {
  app: Pool;
  vault: TokenVault;
  oauth?: OAuthClient | null;
  queryLogs: (query: LogsQuery, options: { token: string }) => Promise<Record<string, unknown>[]>;
  env?: EnvVars;
  now?: () => Date;
}

// The UTC day before `now`, as YYYY-MM-DD, and its [start, end) window.
export function previousUtcDay(now: Date): { day: string; start: Date; end: Date } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 86_400_000);
  return { day: start.toISOString().slice(0, 10), start, end };
}

export async function countDailyUsage(tenant: TenantId, deps: UsageDeps): Promise<{ day: string; counted: number; failed: number }> {
  const now = deps.now?.() ?? new Date();
  const { day, start, end } = previousUtcDay(now);
  const sql = edgeRequestCountSql(deps.env);
  const projects = await withTenant(deps.app, tenant, (tx) =>
    tx.query<{ id: ProjectId; connection_id: ConnectionId; supabase_ref: string }>(
      "SELECT id, connection_id, supabase_ref FROM supahound.projects WHERE tenant_id = $1 AND NOT paused",
      [tenant],
    ),
  );
  let counted = 0;
  let failed = 0;
  for (const p of projects) {
    try {
      const token = await accessTokenFor(deps.app, deps.vault, tenant, p.connection_id, deps.oauth ?? null, now);
      const rows = await deps.queryLogs({ projectRef: p.supabase_ref, sql, start, end }, { token });
      const requests = Number(rows[0]?.requests ?? 0);
      if (!Number.isFinite(requests) || requests < 0) throw new Error("bad count");
      await withTenant(deps.app, tenant, async (tx) => {
        await appendAudit(tx, {
          projectId: p.id, action: "logs_query",
          detail: {
            purpose: "usage_count", sql_sha256: createHash("sha256").update(sql).digest("hex"),
            window_start: start.toISOString(), window_end: end.toISOString(), requests,
          },
        });
        await saveDailyUsage(tx, p.id, day, Math.trunc(requests));
      });
      counted++;
    } catch {
      failed++;
    }
  }
  return { day, counted, failed };
}
