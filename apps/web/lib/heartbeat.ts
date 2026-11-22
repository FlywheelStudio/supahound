import { billingMode } from "@supahound/core/db/billing";
import { runHeartbeat, type HeartbeatDeps, type HeartbeatOutcome } from "@supahound/core/poller/heartbeat";
import pg from "pg";

// The web Worker's cron (issue #159): the staff heartbeat's "stale" check, so polling that has
// stopped is reported even when the poller's own cron is dead. The poller's cron owns the
// "failing" check; one owner per check keeps a 6-hour slot to one email without stored state
// (packages/core/src/poller/heartbeat.ts).
//
// Reads through HYPERDRIVE_SCHEDULER as supahound_scheduler: due-project IDs and poll_runs status
// and finish times, aggregates only. Never a tenant row, and never through the app role.

export interface HeartbeatEnv {
  HYPERDRIVE_SCHEDULER: { connectionString: string };
  EMAIL: { send(message: Parameters<HeartbeatDeps["send"]>[0]): Promise<unknown> };
  SUPAHOUND_STAFF_ALERT_EMAIL?: string;
  SUPAHOUND_BILLING: string;
  EMAIL_FROM_ADDRESS: string;
  EMAIL_FROM_NAME: string;
  APP_URL: string;
}

export interface SchedulerPool {
  query: HeartbeatDeps["scheduler"]["query"];
  end(): Promise<void>;
}

export interface ScheduledDeps {
  // One pool per invocation: Workers may not share I/O objects across requests.
  pool: (connectionString: string) => SchedulerPool;
  heartbeat: (deps: HeartbeatDeps, now: Date) => Promise<HeartbeatOutcome>;
  log: (event: string, fields?: Record<string, string | number>) => void;
}

function log(event: string, fields: Record<string, string | number> = {}): void {
  // Counts and statuses only.
  console.log(JSON.stringify({ event, ...fields }));
}

export const defaultScheduledDeps: ScheduledDeps = {
  pool: (connectionString) => new pg.Pool({ connectionString, max: 1 }),
  heartbeat: runHeartbeat,
  log,
};

// Never throws: a failed check must not fail the cron, and the next minute checks again.
export async function scheduledHeartbeat(
  scheduledTime: number, env: HeartbeatEnv, deps: ScheduledDeps = defaultScheduledDeps,
): Promise<HeartbeatOutcome | null> {
  // Off without a staff address: no pool, no query.
  if (!env.SUPAHOUND_STAFF_ALERT_EMAIL?.trim()) return { status: "off" };
  let pool: SchedulerPool | null = null;
  try {
    pool = deps.pool(env.HYPERDRIVE_SCHEDULER.connectionString);
    const outcome = await deps.heartbeat({
      scheduler: pool as unknown as HeartbeatDeps["scheduler"],
      billing: billingMode(env.SUPAHOUND_BILLING),
      staffEmail: env.SUPAHOUND_STAFF_ALERT_EMAIL,
      send: (m) => env.EMAIL.send(m),
      from: { email: env.EMAIL_FROM_ADDRESS, name: env.EMAIL_FROM_NAME },
      appUrl: env.APP_URL,
      checks: "stale",
    }, new Date(scheduledTime));
    if (outcome.status !== "off" && outcome.status !== "healthy") deps.log("heartbeat", { ...outcome });
    return outcome;
  } catch {
    deps.log("heartbeat_crashed");
    return null;
  } finally {
    try {
      await pool?.end();
    } catch {
      // The pool is gone either way.
    }
  }
}
