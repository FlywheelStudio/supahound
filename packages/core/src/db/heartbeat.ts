import type { Pool } from "pg";

// The staff heartbeat's input (issue #133). Scheduler role: reads poll_runs (status, finished_at)
// only, so it returns aggregates across all tenants and never a tenant, project or error code.

export interface MinuteBucket {
  // Epoch minute: floor(finished_at / 60 s).
  minute: number;
  total: number;
  unable: number;
  // The newest finish inside the minute.
  last: Date;
}

export interface PollHealth {
  // The newest finish before `since`, or null when no run finished before it.
  lastBefore: Date | null;
  // Finished runs per minute in [since, until), oldest first.
  buckets: MinuteBucket[];
}

export async function pollHealth(schedulerPool: Pool, since: Date, until: Date): Promise<PollHealth> {
  const before = await schedulerPool.query<{ last: Date | null }>(
    "SELECT max(finished_at) AS last FROM supahound.poll_runs WHERE finished_at IS NOT NULL AND finished_at < $1",
    [since],
  );
  const res = await schedulerPool.query<{ minute: string; total: number; unable: number; last: Date }>(
    `SELECT floor(extract(epoch FROM finished_at) / 60)::bigint AS minute,
            count(*)::int AS total,
            count(*) FILTER (WHERE status = 'unable_to_assess')::int AS unable,
            max(finished_at) AS last
     FROM supahound.poll_runs
     WHERE finished_at >= $1 AND finished_at < $2
     GROUP BY 1 ORDER BY 1`,
    [since, until],
  );
  return {
    lastBefore: before.rows[0]?.last ?? null,
    buckets: res.rows.map((r) => ({ minute: Number(r.minute), total: r.total, unable: r.unable, last: r.last })),
  };
}
